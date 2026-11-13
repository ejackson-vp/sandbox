/**
 * The split brain, executed.
 *
 * ADR 0009 and ADR 0010 argue that two authorities can disagree safely: the
 * Kubernetes Lease decides who reconciles (liveness), and the Postgres advisory
 * writer lock decides who may write (the fence). A write without the lock
 * throws. The argument is load-bearing and, until this file, only the lease half
 * had tests: `leadership.test.ts` drives fake clients, and the store contract
 * proves a second writer is refused on a quiet database. Neither runs the state
 * that matters, because the deployment pins one replica:
 *
 *   the Lease moves to replica B while replica A's database session is still
 *   alive and still holds the writer lock.
 *
 * That is what this file executes, against a real Postgres. Two replicas, two
 * store connections, one advisory lock, and a fake API server that enforces the
 * same resourceVersion compare-and-swap the real one does. A is then suspended
 * (its own renewal loop does not run, which is the state a SIGSTOP or a stalled
 * event loop produces), B waits out the lease duration and takes the Lease, and
 * the assertions are about what each process can commit at each instant.
 *
 * The fake API server is a control, not a test of the election: dropping the
 * version from its observe key would keep this file green, and
 * `leadership.test.ts` is what catches that. What this file proves is the
 * Postgres fence under a handover, which no other test executes. The client
 * that actually sends the version to Kubernetes is covered separately in
 * `lease-client-cas.test.ts`.
 *
 * The wiring is the production wiring: `bindLeadership` with the same hooks
 * `main.ts` installs, so the ordering under test (stop scheduling, then refuse
 * writes, retry a refused acquire, hand the Lease back if it cannot be backed)
 * is the ordering that ships.
 *
 * Skips cleanly when DATABASE_URL is unset. The repository's global test setup
 * already fails the run without a database; the skip is here so this file can be
 * pointed at a command line without one and still report a sensible result.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReadinessCache } from "@x402s/shared/runtime";
import {
  bindLeadership,
  type AcquireRetryOptions,
} from "../../controller/src/leadership.js";
import {
  makeLeaseLeadership,
  type LeaseClient,
  type LeaseLeadership,
  type LeaseLeadershipOverrides,
  type LeaseRecord,
  type LeaseSnapshot,
} from "../../controller/src/leadership-lease.js";
import type { ControllerConfig } from "../../controller/src/config.js";
import {
  PostgresStore,
  WriterLockUnavailableError,
} from "../../controller/src/store/postgres/store.js";
import { PgConnection } from "../../controller/src/store/postgres/pg.js";
import {
  ensureTestDatabase,
  sqlRows,
  testDatabaseUrl,
} from "../helpers/test-store.js";

const NAMESPACE = "sandbox-system";
const NAME = "controller-leader";
const DATABASE_NAMESPACE = "split_brain";
const INFLIGHT_NAMESPACE = "split_brain_inflight";
const WRITE_SPEC_HASH = "b".repeat(64);
const HAS_DATABASE = Boolean(process.env.DATABASE_URL?.trim());

/* ------------------------------------------------------------------ */
/* A fake API server with the one property the safety argument uses.   */
/* ------------------------------------------------------------------ */

function conflict(): Error {
  return Object.assign(new Error("the object has been modified"), { code: 409 });
}

function notFound(): Error {
  return Object.assign(new Error("leases.coordination.k8s.io not found"), { code: 404 });
}

function clone(snapshot: LeaseSnapshot): LeaseSnapshot {
  return { record: { ...snapshot.record }, resourceVersion: snapshot.resourceVersion };
}

/**
 * The server's single Lease. Compare-and-swap on `resourceVersion`, exactly as
 * the API server does it: a replace built on a stale version is a 409, and two
 * replicas racing for the same record cannot both win.
 */
class FakeLeaseApi {
  private snapshot: LeaseSnapshot | null = null;
  private version = 0;
  reads = 0;
  creates = 0;
  replaces = 0;

  read(): LeaseSnapshot | null {
    this.reads += 1;
    return this.snapshot ? clone(this.snapshot) : null;
  }

  create(record: LeaseRecord): LeaseSnapshot {
    this.creates += 1;
    if (this.snapshot) throw conflict();
    return this.store(record);
  }

  replace(record: LeaseRecord, resourceVersion: string): LeaseSnapshot {
    if (!this.snapshot) throw notFound();
    if (this.snapshot.resourceVersion !== resourceVersion) throw conflict();
    this.replaces += 1;
    return this.store(record);
  }

  get holder(): string | null {
    return this.snapshot?.record.holderIdentity ?? null;
  }

  private store(record: LeaseRecord): LeaseSnapshot {
    this.version += 1;
    this.snapshot = { record: { ...record }, resourceVersion: String(this.version) };
    return clone(this.snapshot);
  }
}

/**
 * One replica's link to that server.
 *
 * `down` is this replica's network, not the server's: an in-flight process whose
 * API calls fail while its Postgres session stays open is the whole point of the
 * scenario, and the real `LeaseClient` has the same one-object surface per
 * process.
 */
class FakeLeaseClient implements LeaseClient {
  down: Error | null = null;

  constructor(private readonly api: FakeLeaseApi) {}

  async read(): Promise<LeaseSnapshot | null> {
    this.check();
    return this.api.read();
  }

  async create(_name: string, _namespace: string, record: LeaseRecord): Promise<LeaseSnapshot> {
    this.check();
    return this.api.create(record);
  }

  async replace(
    _name: string,
    _namespace: string,
    record: LeaseRecord,
    resourceVersion: string,
  ): Promise<LeaseSnapshot> {
    this.check();
    return this.api.replace(record, resourceVersion);
  }

  private check(): void {
    if (this.down) throw this.down;
  }
}

/** Wall and monotonic clocks the test advances by hand. */
function clock(start = 1_000_000) {
  let wall = start;
  let mono = 5_000;
  return {
    now: () => wall,
    mono: () => mono,
    advance: (ms: number) => {
      wall += ms;
      mono += ms;
    },
  };
}

/** Only these three fields are read by the lease election. */
function configFor(identity: string): ControllerConfig {
  return {
    controlNamespace: NAMESPACE,
    leaderLeaseName: NAME,
    leaderIdentity: identity,
  } as ControllerConfig;
}

/* ------------------------------------------------------------------ */
/* What a write attempt did.                                           */
/* ------------------------------------------------------------------ */

interface WriteAttempt {
  label: string;
  committed: boolean;
  error?: unknown;
}

let probe = 0;

function paymentKey(label: string): string {
  probe += 1;
  // A fresh key every time, so a claimed intent is an INSERT that committed
  // rather than a read that answered `in_progress`.
  return `${label}-${probe}`;
}

async function tryWrite(store: PostgresStore, label: string): Promise<WriteAttempt> {
  try {
    const claim = await store.claimPaymentIntent(paymentKey(label), WRITE_SPEC_HASH, 30_000);
    return { label, committed: claim.status === "claimed" };
  } catch (error) {
    return { label, committed: false, error };
  }
}

function committedWriters(attempts: WriteAttempt[]): string[] {
  return attempts.filter((attempt) => attempt.committed).map((attempt) => attempt.label);
}

function expectRefused(attempt: WriteAttempt, message: RegExp): void {
  expect(attempt.committed).toBe(false);
  expect(attempt.error).toBeInstanceOf(WriterLockUnavailableError);
  expect((attempt.error as Error).message).toMatch(message);
}

/** Advisory locks held in this test's database, counting every session. */
async function advisoryLocks(): Promise<number> {
  // `pg_locks` is cluster-wide, so scope it to this database: the suite runs
  // files in parallel, each with its own database and its own writer lock.
  const rows = await sqlRows<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM pg_locks
      WHERE locktype = 'advisory'
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    [],
    DATABASE_NAMESPACE,
  );
  return rows[0]?.n ?? -1;
}

/** Poll for an asynchronous assertion the retry loop makes on its own. */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met in time");
}

/* ------------------------------------------------------------------ */
/* The scenario.                                                       */
/* ------------------------------------------------------------------ */

describe.skipIf(!HAS_DATABASE)("split brain between the Lease and the writer lock", () => {
  let url: string;
  let api: FakeLeaseApi;
  let time: ReturnType<typeof clock>;
  let linkA: FakeLeaseClient;
  let linkB: FakeLeaseClient;
  let storeA: PostgresStore;
  let storeB: PostgresStore;

  beforeAll(async () => {
    await ensureTestDatabase(DATABASE_NAMESPACE);
    url = testDatabaseUrl(DATABASE_NAMESPACE);
    // A opens as the writer: the advisory lock is taken and the schema migrated.
    storeA = await PostgresStore.open(url, { writer: true });
    // B opens as a standby: no lock, no migration, write guard closed.
    storeB = await PostgresStore.open(url, { writer: false });
  });

  afterAll(async () => {
    await storeA?.close().catch(() => undefined);
    await storeB?.close().catch(() => undefined);
  });

  it("keeps exactly one writer while the Lease changes hands", async () => {
    api = new FakeLeaseApi();
    time = clock();
    linkA = new FakeLeaseClient(api);
    linkB = new FakeLeaseClient(api);

    // The production cadence, with a test clock: the renewal timer is 10s so it
    // cannot fire inside the test, and the takeover window stays the shipped one
    // (observe() takes max(leaseDuration, renewInterval), both 10s here).
    const leaseOptions = {
      renewIntervalMs: 10_000,
      leaseDurationMs: 10_000,
      now: time.now,
      monotonic: time.mono,
      callTimeoutMs: 500,
    };
    const leaseA = makeLeaseLeadership(configFor("controller-a"), {
      ...leaseOptions,
      client: linkA,
    });
    const leaseB = makeLeaseLeadership(configFor("controller-b"), {
      ...leaseOptions,
      client: linkB,
    });

    const eventsA: string[] = [];
    const eventsB: string[] = [];
    let bAttempts = 0;
    let bFailures = 0;
    let lastBError: unknown;

    // Long enough that B keeps trying for the whole test, so the assertions are
    // about the fence rather than about the retry budget.
    const retry: AcquireRetryOptions = { attempts: 100, initialDelayMs: 20, maxDelayMs: 50 };

    // The same hooks main.ts installs: writes first on acquire, stop before
    // release, and the release unblocks the guard synchronously.
    bindLeadership(leaseA, {
      acquire: async () => {
        await storeA.setWritesBlocked(false);
        eventsA.push("acquire");
      },
      start: () => eventsA.push("start"),
      stop: () => eventsA.push("stop"),
      release: () => {
        eventsA.push("release");
        void Promise.resolve(storeA.setWritesBlocked(true)).catch(() => undefined);
      },
    });
    bindLeadership(leaseB, {
      acquire: async () => {
        bAttempts += 1;
        try {
          await storeB.setWritesBlocked(false);
          eventsB.push("acquire:ok");
        } catch (error) {
          bFailures += 1;
          lastBError = error;
          eventsB.push("acquire:failed");
          // Rethrow: `bindLeadership` owns the retry and the decision to stand
          // down, so it has to see the refusal.
          throw error;
        }
      },
      start: () => eventsB.push("start"),
      stop: () => eventsB.push("stop"),
      release: () => {
        eventsB.push("release");
        void Promise.resolve(storeB.setWritesBlocked(true)).catch(() => undefined);
      },
    }, retry);

    /* 1. A wins the election and the writer lock. ------------------- */

    await leaseA.start();
    await leaseB.start();

    expect(api.holder).toBe("controller-a");
    expect(leaseA.isLeader()).toBe(true);
    expect(leaseB.isLeader()).toBe(false);
    expect(storeA.writesAreBlocked).toBe(false);
    expect(storeB.writesAreBlocked).toBe(true);

    const aFirst = await tryWrite(storeA, "a-first");
    expect(committedWriters([aFirst])).toEqual(["a-first"]);

    // The startup half of the fence: a second process cannot even open as a
    // writer for this database.
    await expect(PostgresStore.open(url, { writer: true })).rejects.toThrow(
      /another process already holds the store writer lock; refusing to start a second writer/,
    );

    /* 2. A is suspended and B takes the Lease. ---------------------- */

    // A's link to the API dies. A does not tick again, which is a suspended
    // process, not a crash: its Postgres session and its advisory lock stay up.
    linkA.down = new Error("connect ECONNREFUSED 10.96.0.1:443");
    time.advance(10_000);

    // B has watched the same record for a full duration, so the compare-and-swap
    // takeover is allowed. It wins the Lease.
    await leaseB.tick();
    await waitFor(() => bFailures >= 1);

    expect(api.holder).toBe("controller-b");
    expect(leaseB.isLeader()).toBe(true);
    expect(bAttempts).toBeGreaterThanOrEqual(1);

    // ...and cannot write, because A's session still holds the advisory lock.
    // This is the fence doing its job: the new Lease holder is refused rather
    // than becoming a second writer.
    expect(lastBError).toBeInstanceOf(WriterLockUnavailableError);
    expect((lastBError as Error).message).toMatch(
      /another process holds the store writer lock; refusing to become the writer/,
    );
    expect(storeB.writesAreBlocked).toBe(true);
    // The reconciler loop must not start on a replica that could not take the
    // lock, or it would schedule effects it cannot commit.
    expect(eventsB).not.toContain("acquire:ok");
    expect(eventsB).not.toContain("start");

    // Readiness is the AND of the store and the lease. B holds the lease, but
    // the store reports read_only because its write guard is closed, so readyz
    // is 503. A write-blocked leader is not routed creates.
    const readiness = new ReadinessCache({
      store: async () => {
        const health = await storeB.healthCheck();
        return health.ok ? { ok: true } : { ok: false, reason: health.reason };
      },
      leadership: () =>
        leaseB.isLeader() ? { ok: true } : { ok: false, reason: "not_leader" },
    });
    const report = await readiness.check();
    expect(report.ok).toBe(false);
    expect(report.components.store).toMatchObject({ ok: false, reason: "read_only" });
    expect(report.components.leadership).toMatchObject({ ok: true });

    // The database has exactly one advisory writer lock, and the refused
    // promotion above is what identifies it as A's session rather than B's.
    expect(await advisoryLocks()).toBe(1);

    // Both replicas try to write at the same instant. A is stale (its Lease is
    // gone) and still writes; B holds the Lease and cannot. Exactly one commits.
    const duringSplit = await Promise.all([
      tryWrite(storeA, "a-during-split"),
      tryWrite(storeB, "b-during-split"),
    ]);
    expect(committedWriters(duringSplit)).toEqual(["a-during-split"]);
    expectRefused(duringSplit[1]!, /does not hold the store writer lock/);

    /* 3. A is told to stand down; its writes stop immediately. ------ */

    // A resumes. Its first act is to notice its own deadline, before it even
    // reads B's record: the deadline is on its own monotonic clock.
    linkA.down = null;
    await leaseA.tick();

    expect(leaseA.isLeader()).toBe(false);
    expect(eventsA.slice(-2)).toEqual(["stop", "release"]);

    // The guard closes synchronously inside the release hook, before the unlock
    // round trip, so this write is refused without waiting for anything.
    const aAfterStandDown = await tryWrite(storeA, "a-after-stand-down");
    expectRefused(aAfterStandDown, /does not hold the store writer lock/);

    /* 4. B retries and recovers without a restart. ------------------ */

    // A's stand-down released the advisory lock. B's next attempt takes it, so
    // the takeover is not stuck waiting for A's process to die.
    await waitFor(() => eventsB.includes("acquire:ok"));
    expect(storeB.writesAreBlocked).toBe(false);
    expect(eventsB).toContain("start");
    expect(api.holder).toBe("controller-b");
    expect(await advisoryLocks()).toBe(1);

    const bAfterTakeover = await tryWrite(storeB, "b-after-takeover");
    expect(committedWriters([bAfterTakeover])).toEqual(["b-after-takeover"]);

    // A's process dies after it stood down. The lock B holds is unaffected.
    await storeA.close();
    expect(await advisoryLocks()).toBe(1);
    expect(storeA.writesAreBlocked).toBe(true);

    // Exactly one writer at every phase above: A before the split, A during it,
    // nobody while A stands down, B once the lock is free.
    await leaseA.stop();
    await leaseB.stop();
  });
});

interface WedgeWorld {
  api: FakeLeaseApi;
  time: ReturnType<typeof clock>;
  linkA: FakeLeaseClient;
  storeA: PostgresStore;
  storeB: PostgresStore;
  leaseA: LeaseLeadership;
  leaseB: LeaseLeadership;
  eventsB: string[];
  readonly bFailures: number;
  close(): Promise<void>;
}

/**
 * Two replicas on a fresh database, wired the way `main.ts` wires them.
 *
 * Retry timing is the only thing a test changes: the number of renewal windows
 * is driven by the fake clock, so waiting out the production 5s budget would
 * make the suite slow without testing anything new.
 */
async function openWedgeWorld(
  namespace: string,
  retryB: AcquireRetryOptions,
): Promise<WedgeWorld> {
  await ensureTestDatabase(namespace);
  const url = testDatabaseUrl(namespace);
  const storeA = await PostgresStore.open(url, { writer: true });
  const storeB = await PostgresStore.open(url, { writer: false });
  const api = new FakeLeaseApi();
  const time = clock();
  const linkA = new FakeLeaseClient(api);
  const linkB = new FakeLeaseClient(api);
  const leaseOptions: LeaseLeadershipOverrides = {
    renewIntervalMs: 10_000,
    leaseDurationMs: 10_000,
    now: time.now,
    monotonic: time.mono,
    callTimeoutMs: 500,
  };
  const leaseA = makeLeaseLeadership(configFor("controller-a"), {
    ...leaseOptions,
    client: linkA,
  });
  const leaseB = makeLeaseLeadership(configFor("controller-b"), {
    ...leaseOptions,
    client: linkB,
  });
  const eventsB: string[] = [];
  let failures = 0;

  bindLeadership(leaseA, {
    acquire: async () => {
      await storeA.setWritesBlocked(false);
    },
    start: () => undefined,
    stop: () => undefined,
    release: () => {
      void Promise.resolve(storeA.setWritesBlocked(true)).catch(() => undefined);
    },
  });
  bindLeadership(
    leaseB,
    {
      acquire: async () => {
        try {
          await storeB.setWritesBlocked(false);
          eventsB.push("acquire:ok");
        } catch (error) {
          failures += 1;
          eventsB.push("acquire:failed");
          throw error;
        }
      },
      start: () => eventsB.push("start"),
      stop: () => eventsB.push("stop"),
      release: () => {
        eventsB.push("release");
        void Promise.resolve(storeB.setWritesBlocked(true)).catch(() => undefined);
      },
    },
    retryB,
  );

  return {
    api,
    time,
    linkA,
    storeA,
    storeB,
    leaseA,
    leaseB,
    eventsB,
    get bFailures() {
      return failures;
    },
    async close() {
      await leaseA.stop().catch(() => undefined);
      await leaseB.stop().catch(() => undefined);
      await storeA.close().catch(() => undefined);
      await storeB.close().catch(() => undefined);
    },
  };
}

/**
 * The acquire wedge: the Lease moves to a replica that cannot take the writer
 * lock, and the lock does not free.
 *
 * `bindLeadership` retries a refusal a bounded number of times. If the lock is
 * still someone else's, it releases the Lease rather than renewing one it cannot
 * use: whoever holds the advisory lock is the replica that can write, so it
 * should be allowed to win.
 */
describe.skipIf(!HAS_DATABASE)("acquire retry when the writer lock is held", () => {
  it("recovers when the lock frees inside the retry budget", async () => {
    const world = await openWedgeWorld("split_brain_retry_recover", {
      attempts: 100,
      initialDelayMs: 20,
      maxDelayMs: 50,
    });
    try {
      await world.leaseA.start();
      await world.leaseB.start();
      expect(world.leaseA.isLeader()).toBe(true);

      // A is suspended and B takes the Lease.
      world.linkA.down = new Error("connect ECONNREFUSED 10.96.0.1:443");
      world.time.advance(10_000);
      await world.leaseB.tick();
      await waitFor(() => world.bFailures >= 1);
      expect(world.storeB.writesAreBlocked).toBe(true);

      // The Lease keeps renewing while B cannot write: two renewal windows.
      for (let window = 0; window < 2; window += 1) {
        world.time.advance(2_000);
        await world.leaseB.tick();
      }
      expect(world.api.holder).toBe("controller-b");

      // The lock frees while B is still inside the retry budget.
      await world.storeA.setWritesBlocked(true);
      expect(world.storeA.writesAreBlocked).toBe(true);

      await waitFor(() => world.eventsB.includes("acquire:ok"));
      expect(world.storeB.writesAreBlocked).toBe(false);
      expect(world.leaseB.isLeader()).toBe(true);
      expect(world.eventsB).toContain("start");

      const write = await tryWrite(world.storeB, "b-recovered");
      expect(committedWriters([write])).toEqual(["b-recovered"]);

      // A resumes and stands down on its own deadline.
      world.linkA.down = null;
      world.time.advance(2_000);
      await world.leaseA.tick();
      expect(world.leaseA.isLeader()).toBe(false);
      expect(world.storeA.writesAreBlocked).toBe(true);
    } finally {
      await world.close();
    }
  });

  it("stands down when the lock never frees, and the lock holder wins the released lease", async () => {
    const world = await openWedgeWorld("split_brain_retry_stepdown", {
      attempts: 3,
      initialDelayMs: 10,
      maxDelayMs: 20,
    });
    try {
      await world.leaseA.start();
      await world.leaseB.start();

      world.linkA.down = new Error("connect ECONNREFUSED 10.96.0.1:443");
      world.time.advance(10_000);
      await world.leaseB.tick();
      await waitFor(() => world.bFailures >= 1);

      // The Lease renews across two windows, then the retry budget runs out.
      for (let window = 0; window < 2; window += 1) {
        world.time.advance(2_000);
        await world.leaseB.tick();
      }
      await waitFor(() => !world.leaseB.isLeader());
      await waitFor(() => world.api.holder === "");

      expect(world.eventsB).toContain("acquire:failed");
      expect(world.eventsB).toContain("stop");
      expect(world.eventsB).toContain("release");
      expect(world.storeB.writesAreBlocked).toBe(true);
      const refused = await tryWrite(world.storeB, "b-after-stand-down");
      expectRefused(refused, /does not hold the store writer lock/);

      // A is the replica that can write. The released Lease is free, so A wins
      // it back and the cluster has one writer again.
      world.linkA.down = null;
      await world.leaseA.tick();
      await waitFor(() => world.leaseA.isLeader() && !world.storeA.writesAreBlocked);

      expect(world.api.holder).toBe("controller-a");
      expect(world.storeB.writesAreBlocked).toBe(true);
      const write = await tryWrite(world.storeA, "a-wins-back");
      expect(committedWriters([write])).toEqual(["a-wins-back"]);
    } finally {
      await world.close();
    }
  });
});

/**
 * The one thing the advisory lock does not do.
 *
 * `PgConnection.tx()` checks `assertWritable()` once, at BEGIN. Releasing the
 * writer lock closes the guard for *new* transactions; it cannot revoke one that
 * is already open on another pool connection, and the COMMIT goes through after
 * a second session has taken the lock. ADR 0009 says a pass still in flight
 * "fails loudly rather than writing after another replica may already own the
 * lease": that is true of a write that has not begun, and not true of a
 * transaction past BEGIN.
 *
 * This is pinned rather than fixed. The overlap is one transaction wide, every
 * effect is still guarded by its own `WHERE state = ...`, and the lock is what
 * stops a second scheduler from *starting* work. But the stronger reading of
 * "one writer at any instant" is false, and a test that claimed otherwise would
 * be agreeing with the design instead of checking it.
 */
describe.skipIf(!HAS_DATABASE)("writer lock released under an open transaction", () => {
  let url: string;

  beforeAll(async () => {
    await ensureTestDatabase(INFLIGHT_NAMESPACE);
    url = testDatabaseUrl(INFLIGHT_NAMESPACE);
    // Migrate through the store, so the connection below is the real schema.
    const migrate = await PostgresStore.open(url, { writer: true });
    await migrate.close();
  });

  it("cannot stop a transaction that was already open when it was released", async () => {
    const a = new PgConnection(url, { max: 2 });
    const b = new PgConnection(url, { max: 2 });
    try {
      // Setup DDL is outside the fence on purpose: there is no store API for it,
      // and it runs before either session takes the lock.
      await a.query("CREATE TABLE IF NOT EXISTS split_brain_probe (id TEXT PRIMARY KEY)");

      expect(await a.acquireWriterLock()).toBe(true);

      let inserted!: () => void;
      let commit!: () => void;
      const writeLanded = new Promise<void>((resolve) => {
        inserted = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        commit = resolve;
      });

      // A's transaction begins while A holds the lock, writes, then waits. This
      // is a reconcile pass that has already started when the stand-down lands.
      const inFlight = a.tx(async (tx) => {
        await tx.query("INSERT INTO split_brain_probe (id) VALUES ($1)", ["a-in-flight"]);
        inserted();
        await gate;
      });
      await writeLanded;

      // A stands down and the lock moves to B while A's transaction is open.
      await a.releaseWriterLock();
      expect(await b.acquireWriterLock()).toBe(true);
      await b.tx(async (tx) => {
        await tx.query("INSERT INTO split_brain_probe (id) VALUES ($1)", ["b-after-takeover"]);
      });

      // New work from A is refused: this is the fence, and it holds.
      await expect(a.tx(async (tx) => tx.query("SELECT 1"))).rejects.toThrow(
        WriterLockUnavailableError,
      );

      // The already-open transaction commits anyway.
      commit();
      await inFlight;

      const rows = await a.query<{ id: string }>(
        "SELECT id FROM split_brain_probe ORDER BY id",
      );
      expect(rows.rows.map((row) => row.id)).toEqual(["a-in-flight", "b-after-takeover"]);
    } finally {
      await a.releaseWriterLock().catch(() => undefined);
      await b.releaseWriterLock().catch(() => undefined);
      await a.close().catch(() => undefined);
      await b.close().catch(() => undefined);
    }
  });
});
