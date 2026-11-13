/**
 * The slow path: housekeeping order, its reentrancy guard, and the timer
 * ownership a leadership handover relies on.
 *
 * Housekeeping is deliberately off the readiness tick, and the order inside it
 * is load-bearing rather than incidental:
 *
 *   - relay generation recovery runs first, because it fences the operation a
 *     lost relay link was carrying before the fence may decide anything about
 *     that gate;
 *   - the pool is replenished before the lifecycle enforces idle policy, so a
 *     suspend cannot hand a pod back to a pool that then refills from the same
 *     budget in the same pass;
 *   - settlement recovery runs before the refund worker, so a payment recovered
 *     in this pass that needs a real transfer is attempted immediately rather
 *     than one pass later.
 *
 * A step that throws ends the pass (the catch is around the whole sequence) and
 * must release the guard, or housekeeping stops forever after one apiserver
 * blip. The observed sequence is therefore always a prefix of one fixed order,
 * and the next pass starts again from the first step.
 *
 * `start`/`stop` are what `bindLeadership` calls when the lease moves, so they
 * have to be idempotent in both directions: a duplicate timer that survives a
 * `stop` would keep reconciling on a replica that no longer holds the lease.
 */
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { NOW, harness } from "../helpers/reconciler-harness.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error("condition was not met before the timeout");
}

/**
 * The documented sequence, as one flat list. `refund_worker` appears twice
 * because the worker publishes two gauges before it decides whether to run.
 */
const EXPECTED = [
  "relay_recovery",
  "termination_sweep",
  "fence_reconcile",
  "warm_list",
  "lifecycle_enforce",
  "lifecycle_cleanup",
  "sweep_pvcs",
  "refund_reconcile",
  "settlement_recovery",
  "refund_worker",
  "refund_worker",
  "prune_nonces",
  "capacity_reap",
];

/** Steps whose failure can be injected through a collaborator hook. */
const HOOKABLE = [
  "relay_recovery",
  "termination_sweep",
  "fence_reconcile",
  "lifecycle_enforce",
  "lifecycle_cleanup",
  "sweep_pvcs",
  "refund_reconcile",
  "capacity_reap",
];

/**
 * A settlement lookup is configured but never called: no stale intent exists, so
 * recovery takes its clock reading, reads the table and returns. That is what
 * makes the recovery step observable without a facilitator.
 */
function slowPath(env: NodeJS.ProcessEnv = {}) {
  return harness({ env: { FACILITATOR_URL: "http://facilitator.invalid", ...env } });
}

describe("housekeeping runs one fixed sequence", () => {
  it("observes the documented order, whatever ends the pass", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom(...HOOKABLE), { maxLength: 3 }), async (failing) => {
        const h = slowPath();
        // Every selected step throws, so the earliest one in the sequence is the
        // one that ends the pass.
        for (const op of new Set(failing)) {
          h.hook(op, () => {
            throw new Error(`${op} failed`);
          });
        }

        await expect(h.housekeeping()).resolves.toBeUndefined();

        const observed = h.ops.map((entry) => entry.op);
        const positions = [...new Set(failing)].map((op) => EXPECTED.indexOf(op));
        const stop = positions.length === 0 ? EXPECTED.length : Math.min(...positions) + 1;
        expect(observed).toEqual(EXPECTED.slice(0, stop));
      }),
      { numRuns: 25 },
    );
  });

  it("releases the guard after a step throws, so the next pass starts over", async () => {
    const h = slowPath();
    let attempts = 0;
    h.hook("relay_recovery", () => {
      attempts += 1;
      if (attempts === 1) throw new Error("relay unreachable");
    });

    await expect(h.housekeeping()).resolves.toBeUndefined();
    expect(h.ops.map((entry) => entry.op)).toEqual(["relay_recovery"]);

    await h.housekeeping();
    expect(h.ops.map((entry) => entry.op)).toEqual(["relay_recovery", ...EXPECTED]);
  });

  it("does not start a second pass while one is still running", async () => {
    const h = slowPath();
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    h.hook("relay_recovery", async () => {
      entered = true;
      await parked;
    });

    const first = h.housekeeping();
    await waitFor(() => entered);
    // The reentrancy guard is what keeps the fast tick's budget out of a
    // duplicate slow pass when the interval fires twice.
    await h.housekeeping();
    expect(h.ops).toEqual([{ op: "relay_recovery" }]);

    release();
    await first;
    expect(h.ops.map((entry) => entry.op)).toEqual(EXPECTED);
  });
});

describe("the timer belongs to whoever holds the lease", () => {
  it("starts one timer, runs immediately, and stops everything on stop", async () => {
    vi.useFakeTimers();
    try {
      const h = slowPath({ RECONCILE_INTERVAL_MS: "50" });
      h.add("sbx_tick", { state: "PAID" });

      h.reconciler.start();
      await vi.advanceTimersByTimeAsync(1_100);
      const reads = h.store.dueReads.length;
      const slowRuns = h.ops.filter((entry) => entry.op === "relay_recovery").length;
      expect(reads).toBeGreaterThanOrEqual(2);
      // The slow path has its own, slower interval and did not borrow the
      // readiness tick's.
      expect(slowRuns).toBeGreaterThanOrEqual(2);

      // A second start must not add a second interval: `stop` clears one handle.
      h.reconciler.start();
      h.reconciler.stop();
      await vi.advanceTimersByTimeAsync(3_000);

      expect(h.store.dueReads).toHaveLength(reads);
      expect(h.ops.filter((entry) => entry.op === "provision")).toHaveLength(1);
      expect(h.ops.filter((entry) => entry.op === "relay_recovery")).toHaveLength(slowRuns);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles again when the lease comes back", async () => {
    vi.useFakeTimers();
    try {
      const h = slowPath({ RECONCILE_INTERVAL_MS: "50" });
      h.add("sbx_tick", { state: "PAID" });

      h.reconciler.start();
      await vi.advanceTimersByTimeAsync(60);
      h.reconciler.stop();

      // The row is due again, so a fresh start serves it without waiting.
      h.clock.now = NOW + 60_000;
      h.reconciler.start();
      await vi.advanceTimersByTimeAsync(10);
      h.reconciler.stop();

      expect(h.ops.filter((entry) => entry.op === "provision")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the control API reaches the lifecycle through the reconciler", () => {
  it("forwards suspend and resume to the lifecycle unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 16 }),
        fc.string({ minLength: 1, maxLength: 16 }),
        async (suspendId, resumeId) => {
          const h = harness();

          await Promise.all([
            h.reconciler.suspendSession(suspendId),
            h.reconciler.resumeSession(resumeId),
          ]);

          expect(h.ops).toEqual(
            expect.arrayContaining([
              { op: "lifecycle_suspend", id: suspendId },
              { op: "lifecycle_resume", id: resumeId },
            ]),
          );
        },
      ),
      { numRuns: 10 },
    );
  });
});
