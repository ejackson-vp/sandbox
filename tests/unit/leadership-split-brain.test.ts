/**
 * The split brain, executed.
 *
 * The Lease moves to replica B while replica A's database session is still
 * alive and still holds the writer lock. The assertions are about what each
 * replica can commit at each instant, against a real Postgres. This is the
 * state the deployment pins one replica to avoid, so nothing else runs it.
 *
 * Fixtures: ./support/leadership-fence-harness.js. The acquire retry and the
 * open-transaction case are in leadership-acquire-retry.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReadinessCache } from "@x402s/shared/runtime";
import {
  bindLeadership,
  type AcquireRetryOptions,
} from "../../controller/src/leadership.js";
import { makeLeaseLeadership } from "../../controller/src/leadership-lease.js";
import {
  PostgresStore,
  WriterLockUnavailableError,
} from "../../controller/src/store/postgres/store.js";
import { ensureTestDatabase, testDatabaseUrl } from "../helpers/test-store.js";
import {
  DATABASE_NAMESPACE,
  FakeLeaseApi,
  FakeLeaseClient,
  HAS_DATABASE,
  advisoryLocks,
  clock,
  committedWriters,
  configFor,
  expectRefused,
  tryWrite,
  waitFor,
} from "./support/leadership-fence-harness.js";
/* ------------------------------------------------------------------ */
/* The scenario.                                                       */
/* ------------------------------------------------------------------ */

describe.skipIf(!HAS_DATABASE)(
  "split brain between the Lease and the writer lock",
  () => {
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
      const retry: AcquireRetryOptions = {
        attempts: 100,
        initialDelayMs: 20,
        maxDelayMs: 50,
      };

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
          void Promise.resolve(storeA.setWritesBlocked(true)).catch(
            () => undefined,
          );
        },
      });
      bindLeadership(
        leaseB,
        {
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
            void Promise.resolve(storeB.setWritesBlocked(true)).catch(
              () => undefined,
            );
          },
        },
        retry,
      );

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
          return health.ok
            ? { ok: true }
            : { ok: false, reason: health.reason };
        },
        leadership: () =>
          leaseB.isLeader()
            ? { ok: true }
            : { ok: false, reason: "not_leader" },
      });
      const report = await readiness.check();
      expect(report.ok).toBe(false);
      expect(report.components.store).toMatchObject({
        ok: false,
        reason: "read_only",
      });
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
  },
);
