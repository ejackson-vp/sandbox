/**
 * Fixtures for the split-brain tests: two real Postgres stores on one
 * database, two replicas wired through the production `bindLeadership`
 * hooks, and a fake Lease API that enforces the same resourceVersion
 * compare-and-swap the apiserver does.
 */
import { expect } from "vitest";
import {
  bindLeadership,
  type AcquireFailure,
  type AcquireRetryOptions,
} from "../../../controller/src/leadership.js";
import {
  makeLeaseLeadership,
  type LeaseClient,
  type LeaseLeadership,
  type LeaseLeadershipOverrides,
  type LeaseRecord,
  type LeaseSnapshot,
} from "../../../controller/src/leadership-lease.js";
import type { ControllerConfig } from "../../../controller/src/config.js";
import {
  PostgresStore,
  WriterLockUnavailableError,
} from "../../../controller/src/store/postgres/store.js";
import {
  ensureTestDatabase,
  sqlRows,
  testDatabaseUrl,
} from "../../helpers/test-store.js";
export const NAMESPACE = "sandbox-system";
export const NAME = "controller-leader";
export const DATABASE_NAMESPACE = "split_brain";
export const INFLIGHT_NAMESPACE = "split_brain_inflight";
export const WRITE_SPEC_HASH = "b".repeat(64);
export const HAS_DATABASE = Boolean(process.env.DATABASE_URL?.trim());

/* ------------------------------------------------------------------ */
/* A fake API server with the one property the safety argument uses.   */
/* ------------------------------------------------------------------ */

export function conflict(): Error {
  return Object.assign(new Error("the object has been modified"), {
    code: 409,
  });
}

export function notFound(): Error {
  return Object.assign(new Error("leases.coordination.k8s.io not found"), {
    code: 404,
  });
}

export function clone(snapshot: LeaseSnapshot): LeaseSnapshot {
  return {
    record: { ...snapshot.record },
    resourceVersion: snapshot.resourceVersion,
  };
}

/**
 * The server's single Lease. Compare-and-swap on `resourceVersion`, exactly as
 * the API server does it: a replace built on a stale version is a 409, and two
 * replicas racing for the same record cannot both win.
 */
export class FakeLeaseApi {
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
    this.snapshot = {
      record: { ...record },
      resourceVersion: String(this.version),
    };
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
export class FakeLeaseClient implements LeaseClient {
  down: Error | null = null;

  constructor(private readonly api: FakeLeaseApi) {}

  async read(): Promise<LeaseSnapshot | null> {
    this.check();
    return this.api.read();
  }

  async create(
    _name: string,
    _namespace: string,
    record: LeaseRecord,
  ): Promise<LeaseSnapshot> {
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
export function clock(start = 1_000_000) {
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
export function configFor(identity: string): ControllerConfig {
  return {
    controlNamespace: NAMESPACE,
    leaderLeaseName: NAME,
    leaderIdentity: identity,
  } as ControllerConfig;
}

/* ------------------------------------------------------------------ */
/* What a write attempt did.                                           */
/* ------------------------------------------------------------------ */

export interface WriteAttempt {
  label: string;
  committed: boolean;
  error?: unknown;
}

let probe = 0;

export function paymentKey(label: string): string {
  probe += 1;
  // A fresh key every time, so a claimed intent is an INSERT that committed
  // rather than a read that answered `in_progress`.
  return `${label}-${probe}`;
}

export async function tryWrite(
  store: PostgresStore,
  label: string,
): Promise<WriteAttempt> {
  try {
    const claim = await store.claimPaymentIntent(
      paymentKey(label),
      WRITE_SPEC_HASH,
      30_000,
    );
    return { label, committed: claim.status === "claimed" };
  } catch (error) {
    return { label, committed: false, error };
  }
}

export function committedWriters(attempts: WriteAttempt[]): string[] {
  return attempts
    .filter((attempt) => attempt.committed)
    .map((attempt) => attempt.label);
}

export function expectRefused(attempt: WriteAttempt, message: RegExp): void {
  expect(attempt.committed).toBe(false);
  expect(attempt.error).toBeInstanceOf(WriterLockUnavailableError);
  expect((attempt.error as Error).message).toMatch(message);
}

/** Advisory locks held in this test's database, counting every session. */
export async function advisoryLocks(): Promise<number> {
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
export async function waitFor(
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

export interface WedgeWorld {
  api: FakeLeaseApi;
  time: ReturnType<typeof clock>;
  linkA: FakeLeaseClient;
  storeA: PostgresStore;
  storeB: PostgresStore;
  leaseA: LeaseLeadership;
  leaseB: LeaseLeadership;
  eventsB: string[];
  /** Failures B reported after giving the Lease back. Never production's exit. */
  readonly exhausted: AcquireFailure[];
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
export async function openWedgeWorld(
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
  const exhausted: AcquireFailure[] = [];
  let failures = 0;

  bindLeadership(leaseA, {
    acquire: async () => {
      await storeA.setWritesBlocked(false);
    },
    start: () => undefined,
    stop: () => undefined,
    release: () => {
      void Promise.resolve(storeA.setWritesBlocked(true)).catch(
        () => undefined,
      );
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
        void Promise.resolve(storeB.setWritesBlocked(true)).catch(
          () => undefined,
        );
      },
      // Production exits here. The suite records instead, so a regression that
      // exhausts the budget fails an assertion rather than the worker.
      exhausted: (failure) => {
        exhausted.push(failure);
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
    exhausted,
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
