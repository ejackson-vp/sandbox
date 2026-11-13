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
