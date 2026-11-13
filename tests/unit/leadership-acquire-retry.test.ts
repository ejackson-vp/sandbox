/**
 * The acquire wedge, and the one thing the advisory lock cannot do.
 *
 * `bindLeadership` retries a refused writer-lock acquire a bounded number of
 * times and then releases the Lease, so a replica that cannot write does not
 * keep the role. The second case pins the gap that remains: a transaction
 * already past BEGIN commits after the lock is released.
 *
 * Fixtures: ./support/leadership-fence-harness.js. The handover itself is in
 * leadership-split-brain.test.ts.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { bindLeadership, SoloLeadership } from "../../controller/src/leadership.js";
import {
  PostgresStore,
  WriterLockUnavailableError,
} from "../../controller/src/store/postgres/store.js";
import { PgConnection } from "../../controller/src/store/postgres/pg.js";
import { ensureTestDatabase, testDatabaseUrl } from "../helpers/test-store.js";
import {
  HAS_DATABASE,
  INFLIGHT_NAMESPACE,
  committedWriters,
  expectRefused,
  openWedgeWorld,
  tryWrite,
  waitFor,
} from "./support/leadership-fence-harness.js";

/**
 * The acquire policy without Postgres: what is retried, for how long, and what
 * happens when the budget runs out.
 *
 * Production exits after releasing the Lease. Every test injects `exhausted`
 * so the runner survives, and asserts on what the default would have seen.
 */
describe("acquire policy", () => {
  function lockRefusal(): Error {
    return new WriterLockUnavailableError(
      "another process holds the store writer lock; refusing to become the writer",
    );
  }

  it("stands down inside the shipped budget with no retry options", async () => {
    const leadership = new SoloLeadership("controller-0");
    const failures: string[] = [];
    let attempts = 0;
    let leaderWhenExhausted = true;
    const startedAt = Date.now();

    bindLeadership(leadership, {
      acquire: async () => {
        attempts += 1;
        throw lockRefusal();
      },
      start: () => undefined,
      stop: () => undefined,
      release: () => undefined,
      exhausted: (failure) => {
        leaderWhenExhausted = leadership.isLeader();
        failures.push(failure);
      },
    });

    await leadership.start();
    await waitFor(() => failures.length > 0, 7_000);

    const elapsed = Date.now() - startedAt;
    // Six attempts, 200ms doubling to 2s: about five seconds. Changing the
    // attempts or the ceiling moves this out of the window.
    expect(attempts).toBe(6);
    expect(failures).toEqual(["lock_refused"]);
    expect(leaderWhenExhausted).toBe(false);
    expect(elapsed).toBeGreaterThan(4_000);
    expect(elapsed).toBeLessThan(7_000);
  }, 10_000);

  it("stops retrying when the role is lost during a backoff", async () => {
    const leadership = new SoloLeadership("controller-0");
    let attempts = 0;
    let exhausted = 0;

    bindLeadership(
      leadership,
      {
        acquire: async () => {
          attempts += 1;
          throw lockRefusal();
        },
        start: () => undefined,
        stop: () => undefined,
        release: () => undefined,
        exhausted: () => {
          exhausted += 1;
        },
      },
      { attempts: 4, initialDelayMs: 100, maxDelayMs: 100, callTimeoutMs: 500 },
    );

    await leadership.start();
    await waitFor(() => attempts >= 1);
    // The first backoff is 100ms; drop the role inside it.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await leadership.stop();
    await new Promise((resolve) => setTimeout(resolve, 250));

    // The re-check after the backoff must win: no second attempt, no exhaustion.
    expect(attempts).toBe(1);
    expect(exhausted).toBe(0);
  });

  it("keeps the lease and retries longer when the store is unavailable", async () => {
    const leadership = new SoloLeadership("controller-0");
    let attempts = 0;
    let started = false;
    let exhausted = 0;

    bindLeadership(
      leadership,
      {
        acquire: async () => {
          attempts += 1;
          if (attempts < 5) throw new Error("connect ECONNREFUSED 10.0.0.1:5432");
        },
        start: () => {
          started = true;
        },
        stop: () => undefined,
        release: () => undefined,
        exhausted: () => {
          exhausted += 1;
        },
      },
      {
        // A lock budget that would give up after two attempts, and a longer
        // store budget that carries the same replica through five.
        attempts: 2,
        initialDelayMs: 10,
        maxDelayMs: 10,
        unavailableAttempts: 10,
        unavailableInitialDelayMs: 20,
        unavailableMaxDelayMs: 20,
        callTimeoutMs: 500,
      },
    );

    await leadership.start();
    await waitFor(() => started);

    expect(attempts).toBe(5);
    expect(exhausted).toBe(0);
    expect(leadership.isLeader()).toBe(true);
  });

  it("abandons an attempt that hangs past the call deadline", async () => {
    const leadership = new SoloLeadership("controller-0");
    const failures: string[] = [];
    let attempts = 0;

    bindLeadership(
      leadership,
      {
        acquire: () => {
          attempts += 1;
          // A connect to a blackholed host: no settlement, no cancellation.
          return new Promise<void>(() => undefined);
        },
        start: () => undefined,
        stop: () => undefined,
        release: () => undefined,
        exhausted: (failure) => {
          failures.push(failure);
        },
      },
      {
        attempts: 2,
        initialDelayMs: 10,
        maxDelayMs: 10,
        unavailableAttempts: 2,
        unavailableInitialDelayMs: 10,
        unavailableMaxDelayMs: 10,
        callTimeoutMs: 25,
      },
    );

    await leadership.start();
    await waitFor(() => failures.length > 0, 2_000);

    // The deadline turned two hung attempts into two timeouts, and a timeout is
    // a store failure, not a rival lock.
    expect(attempts).toBe(2);
    expect(failures).toEqual(["store_unavailable"]);
    expect(leadership.isLeader()).toBe(false);
  });
});

/**
 * The acquire wedge: the Lease moves to a replica that cannot take the writer
 * lock, and the lock does not free.
 *
 * `bindLeadership` retries a refusal a bounded number of times. If the lock is
 * still someone else's, it releases the Lease rather than renewing one it cannot
 * use: whoever holds the advisory lock is the replica that can write, so it
 * should be allowed to win.
 */
describe.skipIf(!HAS_DATABASE)(
  "acquire retry when the writer lock is held",
  () => {
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
        expect(world.exhausted).toEqual([]);
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
        await waitFor(() => world.exhausted.length > 0);

        // The hook runs after the release, and the failure class says why: a
        // rival held the writer lock, so the role was handed back.
        expect(world.exhausted).toEqual(["lock_refused"]);
        expect(world.api.holder).toBe("");
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
        await waitFor(
          () => world.leaseA.isLeader() && !world.storeA.writesAreBlocked,
        );

        expect(world.api.holder).toBe("controller-a");
        expect(world.storeB.writesAreBlocked).toBe(true);
        const write = await tryWrite(world.storeA, "a-wins-back");
        expect(committedWriters([write])).toEqual(["a-wins-back"]);
      } finally {
        await world.close();
      }
    });
  },
);

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
describe.skipIf(!HAS_DATABASE)(
  "writer lock released under an open transaction",
  () => {
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
        await a.query(
          "CREATE TABLE IF NOT EXISTS split_brain_probe (id TEXT PRIMARY KEY)",
        );

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
          await tx.query("INSERT INTO split_brain_probe (id) VALUES ($1)", [
            "a-in-flight",
          ]);
          inserted();
          await gate;
        });
        await writeLanded;

        // A stands down and the lock moves to B while A's transaction is open.
        await a.releaseWriterLock();
        expect(await b.acquireWriterLock()).toBe(true);
        await b.tx(async (tx) => {
          await tx.query("INSERT INTO split_brain_probe (id) VALUES ($1)", [
            "b-after-takeover",
          ]);
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
        expect(rows.rows.map((row) => row.id)).toEqual([
          "a-in-flight",
          "b-after-takeover",
        ]);
      } finally {
        await a.releaseWriterLock().catch(() => undefined);
        await b.releaseWriterLock().catch(() => undefined);
        await a.close().catch(() => undefined);
        await b.close().catch(() => undefined);
      }
    });
  },
);
