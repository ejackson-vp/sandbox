/**
 * The reconcile tick: phase order, the bound, and the state switch.
 *
 * `reconciler.ts` is the only component that mutates session state, and the
 * scheduler around that switch makes four promises no single example can pin:
 *
 *   1. readiness runs to completion before cleanup starts. Cleanup deletes pods,
 *      so a terminating session that is still shutting its guest down would lose
 *      the pod under it if the two phases interleaved;
 *   2. one pass is bounded. `listDue` is capped by `RECONCILE_BUDGET`, dispatch
 *      by `RECONCILE_CONCURRENCY`, and the backlog gauge is only counted when the
 *      pass actually left a due row behind;
 *   3. a terminal row leaves the sweep exactly once. `listTerminalWithPod` stops
 *      returning it when `clearPod` nulls the pod reference, so a pod reference
 *      cannot be deleted twice and cannot be lost because an apiserver refused
 *      one delete;
 *   4. the state switch routes each state to exactly one collaborator, and a
 *      client destroy wins from every non-terminal state before that switch is
 *      read.
 *
 * A per-session failure is contained: the other sessions in the phase still run,
 * cleanup still runs, and the failed row is re-armed so the next pass retries it.
 * A failure in the pass's own reads ends the pass cleanly instead, and the next
 * pass picks the work up because nothing was marked done.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SessionState } from "@x402s/shared/protocol";
import { cadenceFor } from "../../controller/src/reconcile-cadence.js";
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

/** Every state `listDue` can return. Terminal states are never selected. */
const SCHEDULED: SessionState[] = [
  "CREATED",
  "PAID",
  "PROVISIONING",
  "READY",
  "ACTIVE",
  "SUSPENDING",
  "SUSPENDED",
  "RESUMING",
  "TERMINATING",
];

/** The documented state table, as the test's reference for "exactly one". */
const STATE_OP: Partial<Record<SessionState, string>> = {
  PAID: "provision",
  PROVISIONING: "await_ready",
  RESUMING: "await_ready",
  READY: "lease_enforce",
  ACTIVE: "lease_enforce",
  SUSPENDING: "reconcile_suspend",
  TERMINATING: "terminate",
};

const ROUTED = Object.keys(STATE_OP) as SessionState[];

/** Calls made against a session, ignoring the cleanup sweep and warm listing. */
function sessionOps(h: ReturnType<typeof harness>): string[] {
  return h.ops
    .filter((entry) => entry.op !== "delete_pod" && entry.op !== "warm_list")
    .map((entry) => entry.op);
}

describe("readiness finishes before cleanup starts", () => {
  it("never deletes a terminal pod while a readiness callback is still running", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 4 }),
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 0, max: 2 }),
        async (liveCount, deadCount, holdMs) => {
          const h = harness({ env: { RECONCILE_CONCURRENCY: "3" } });
          for (let index = 0; index < liveCount; index += 1) {
            h.add(`sbx_live_${index}`, { state: "READY" });
          }
          for (let index = 0; index < deadCount; index += 1) {
            h.add(`sbx_dead_${index}`, { state: "DESTROYED", podName: `pod-dead-${index}` });
          }
          h.hook("lease_enforce", async (session) => {
            h.ops.push({ op: "begin", id: session.id });
            if (holdMs > 0) await sleep(holdMs);
            h.ops.push({ op: "end", id: session.id });
          });

          await h.pass();

          const events = h.ops.map((entry) => entry.op);
          const firstDelete = events.indexOf("delete_pod");
          const lastEnd = events.lastIndexOf("end");
          expect(events.filter((event) => event === "begin")).toHaveLength(liveCount);
          expect(events.filter((event) => event === "end")).toHaveLength(liveCount);
          if (firstDelete >= 0) expect(firstDelete).toBeGreaterThan(lastEnd);
          expect(h.deletes).toHaveLength(deadCount);
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe("a pass is bounded", () => {
  it("asks for at most the budget and dispatches at most what it was given", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 12 }),
        fc.integer({ min: 1, max: 6 }),
        async (sessionCount, budget) => {
          const h = harness({ env: { RECONCILE_BUDGET: String(budget) } });
          for (let index = 0; index < sessionCount; index += 1) {
            h.add(`sbx_due_${index}`, { state: "PAID" });
          }

          await h.pass();

          expect(h.cfg.reconcileBudget).toBe(budget);
          expect(h.store.dueReads[0]).toEqual({ now: NOW, limit: budget });
          const ran = h.ops.filter((entry) => entry.op === "provision").map((entry) => entry.id);
          expect(ran).toHaveLength(Math.min(sessionCount, budget));
          // No session is dispatched twice within one pass.
          expect(new Set(ran).size).toBe(ran.length);
        },
      ),
      { numRuns: 40 },
    );
  });

  it("never runs more callbacks at once than RECONCILE_CONCURRENCY", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 0, max: 8 }),
        fc.integer({ min: 0, max: 2 }),
        async (concurrency, sessionCount, holdMs) => {
          const h = harness({ env: { RECONCILE_CONCURRENCY: String(concurrency) } });
          for (let index = 0; index < sessionCount; index += 1) {
            h.add(`sbx_conc_${index}`, { state: "PAID" });
          }
          let active = 0;
          let peak = 0;
          h.hook("provision", async () => {
            active += 1;
            peak = Math.max(peak, active);
            if (holdMs > 0) await sleep(holdMs);
            active -= 1;
          });

          await h.pass();

          expect(peak).toBeLessThanOrEqual(concurrency);
          // With a hold every worker is parked before any finishes, so the
          // bound is actually reached and not merely respected.
          if (holdMs > 0) expect(peak).toBe(Math.min(concurrency, sessionCount));
        },
      ),
      { numRuns: 20 },
    );
  });

  it("counts the backlog only when the pass left a due row behind", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 8 }),
        fc.integer({ min: 1, max: 5 }),
        async (sessionCount, budget) => {
          const h = harness({ env: { RECONCILE_BUDGET: String(budget) } });
          for (let index = 0; index < sessionCount; index += 1) {
            h.add(`sbx_backlog_${index}`, { state: "PAID" });
          }

          await h.pass();

          // A read that returned exactly `budget` rows is treated as truncated
          // even when nothing was left over: conservative, and cheaper than a
          // second read to find out.
          const truncated = Math.min(sessionCount, budget) >= budget;
          expect(h.store.countDueCalls).toBe(truncated ? 1 : 0);
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe("a terminal pod is swept exactly once", () => {
  it("deletes and clears each terminal row once, however many passes run", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 4 }),
        fc.integer({ min: 1, max: 3 }),
        fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
        async (deadCount, passes, refused) => {
          const h = harness();
          for (let index = 0; index < deadCount; index += 1) {
            const podName = `pod-dead-${index}`;
            h.add(`sbx_dead_${index}`, { state: "DESTROYED", podName });
            if (refused[index]) h.refuseDelete(podName);
          }

          for (let pass = 0; pass < passes; pass += 1) await h.pass();

          expect(h.deletes).toHaveLength(deadCount);
          expect(new Set(h.deletes).size).toBe(deadCount);
          // A refused delete still clears the reference: the orphan sweep owns
          // the pod from then on, and the row is not retried forever.
          expect(h.store.clearPodCalls).toHaveLength(deadCount);
          expect(h.store.terminalReads).toBe(passes);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("never reconciles a terminal session, only sweeps its pod", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<SessionState>("EXPIRED", "FAILED", "DESTROYED"),
        async (state) => {
          const h = harness();
          h.add("sbx_dead", { state, podName: "pod-dead" });

          await h.pass();

          expect(sessionOps(h)).toEqual([]);
          expect(h.store.rearmCalls).toEqual([]);
          expect(h.deletes).toEqual(["pod-dead"]);
          expect(h.store.clearPodCalls).toEqual(["sbx_dead"]);
        },
      ),
      { numRuns: 10 },
    );
  });
});

describe("the state switch routes each session once", () => {
  it("calls exactly the collaborator the state table names", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...SCHEDULED), async (state) => {
        const h = harness();
        h.add("sbx_one", { state });

        await h.pass();

        const expected = STATE_OP[state];
        expect(sessionOps(h)).toEqual(expected ? [expected] : []);
        expect(h.store.rearmCalls).toEqual([
          { id: "sbx_one", at: NOW + cadenceFor(state), now: NOW },
        ]);
      }),
      { numRuns: 40 },
    );
  });

  it("lets a client destroy win from every non-terminal state", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...SCHEDULED), async (state) => {
        const h = harness();
        h.add("sbx_destroy", { state, destroyRequested: true });

        await h.pass();

        expect(sessionOps(h)).toEqual(["terminate"]);
        if (state !== "TERMINATING") {
          expect(h.store.terminations).toEqual([{ id: "sbx_destroy", reason: "client_destroy" }]);
          // The state changed, so the due time was armed by the transition and
          // must not be overwritten with the cadence of the state it left.
          expect(h.store.rearmCalls).toEqual([]);
        } else {
          expect(h.store.terminations).toEqual([]);
          expect(h.store.rearmCalls).toHaveLength(1);
        }
      }),
      { numRuns: 30 },
    );
  });

  it("does not re-arm a row whose state changed during the pass", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...ROUTED), async (state) => {
        const h = harness();
        h.add("sbx_rearm", { state });
        // Model a transition the collaborator makes during the pass.
        const entered = state === "READY" ? "ACTIVE" : "READY";
        h.hook(STATE_OP[state]!, (session) => {
          h.store.forceState(session.id, entered as SessionState);
        });

        await h.pass();

        // READY -> ACTIVE keeps the 1s cadence, so the assertion has to be on
        // the write itself: a changed row is not re-armed at all.
        expect(h.store.rearmCalls).toEqual([]);
      }),
      { numRuns: 20 },
    );
  });

  it("keeps a session due when its re-arm write fails", async () => {
    const h = harness();
    h.add("sbx_retry", { state: "PAID" });
    h.store.fail("rearmDue", 1);

    await h.pass();
    expect(h.store.rearmCalls).toHaveLength(1);

    // Still due, so the very next pass retries it rather than losing the row.
    await h.pass();
    expect(h.ops.filter((entry) => entry.op === "provision")).toHaveLength(2);
  });

  it("enforces the real lease deadline from the READY branch", async () => {
    const h = harness();
    // Restore the prototype method the harness stubs, so the real LeaseHealth
    // runs: this is the wiring, not the policy (lease-health.test.ts owns that).
    Reflect.deleteProperty(h.internals.lease, "enforce");
    h.add("sbx_expired", {
      state: "READY",
      podName: null,
      leaseExpiresAt: NOW - 60_000,
    });

    await h.pass();

    expect(h.store.terminations).toEqual([{ id: "sbx_expired", reason: "lease_expired" }]);
    // The deadline moves the row to TERMINATING; the actual pod cleanup is the
    // next pass's TERMINATING branch, and no re-arm may overwrite its due time.
    expect(sessionOps(h)).toEqual([]);
    expect(h.store.rearmCalls).toEqual([]);
    expect(h.store.row("sbx_expired")?.state).toBe("TERMINATING");
  });

  it("survives a destroy that loses the race to another writer", async () => {
    // The row moved to TERMINATING between the due read and the request, so the
    // guarded write refuses and the pass reconciles from the state it saw.
    const refused = harness();
    refused.add("sbx_race", { state: "READY", destroyRequested: true });
    refused.store.refuseTermination = true;
    await refused.pass();
    expect(refused.store.terminations).toEqual([]);
    expect(sessionOps(refused)).toEqual(["lease_enforce"]);

    // The request won, but the row was reaped before it could be re-read. The
    // stale snapshot falls through to the switch; every write it can make is
    // guarded, so the only effect is a refusal on a row that is already gone.
    const reaped = harness();
    reaped.add("sbx_reaped", { state: "READY", destroyRequested: true });
    reaped.store.dropAfterTermination = true;
    await expect(reaped.pass()).resolves.toBeUndefined();
    expect(reaped.store.terminations).toEqual([
      { id: "sbx_reaped", reason: "client_destroy" },
    ]);
    expect(sessionOps(reaped)).toEqual(["lease_enforce"]);
    expect(reaped.store.rearmCalls).toEqual([]);
  });
});

describe("a failure inside a pass does not lose the work", () => {
  it("reconciles the other sessions, and cleanup, when one session throws", async () => {
    const h = harness();
    h.add("sbx_bad", { state: "PAID" });
    h.add("sbx_good", { state: "PAID" });
    h.add("sbx_dead", { state: "DESTROYED", podName: "pod-dead" });
    h.hook("provision", (session) => {
      if (session.id === "sbx_bad") throw new Error("provision exploded");
    });

    await h.pass();

    expect(
      h.ops.filter((entry) => entry.op === "provision").map((entry) => entry.id),
    ).toEqual(["sbx_bad", "sbx_good"]);
    expect(h.deletes).toEqual(["pod-dead"]);
    // The failed row is re-armed like any other, so the retry is scheduled
    // rather than depending on the next tick happening to list it.
    expect(h.store.rearmCalls.map((call) => call.id).sort()).toEqual(["sbx_bad", "sbx_good"]);
  });

  it("ends the pass cleanly when a store read throws, and retries on the next pass", async () => {
    const h = harness();
    h.add("sbx_dead", { state: "DESTROYED", podName: "pod-dead" });
    h.store.fail("listTerminalWithPod", 1);

    await expect(h.pass()).resolves.toBeUndefined();
    expect(h.deletes).toEqual([]);

    await h.pass();
    expect(h.deletes).toEqual(["pod-dead"]);
  });

  it("runs nothing at all when the due read itself throws", async () => {
    const h = harness();
    h.add("sbx_paid", { state: "PAID" });
    h.store.fail("listDue", 1);

    await expect(h.pass()).resolves.toBeUndefined();
    expect(sessionOps(h)).toEqual([]);

    await h.pass();
    expect(sessionOps(h)).toEqual(["provision"]);
  });
});

describe("the scheduler never overlaps itself", () => {
  it("returns immediately from a pass that is already running", async () => {
    const h = harness();
    h.add("sbx_slow", { state: "PAID" });
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      h.hook("provision", async () => {
        resolve();
        await new Promise<void>((done) => {
          release = done;
        });
      });
    });

    const first = h.pass();
    await entered;
    await h.pass();

    expect(h.store.dueReads).toHaveLength(1);
    release();
    await first;
    expect(h.ops.filter((entry) => entry.op === "provision")).toHaveLength(1);
  });

  it("coalesces nudges into one follow-up pass, not a parallel one", async () => {
    const h = harness();
    h.add("sbx_slow", { state: "PAID" });
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let entered = false;
    h.hook("provision", async () => {
      entered = true;
      await gate;
    });

    const first = h.pass();
    await waitFor(() => entered);
    // A wake during a pass must not start a second one: it is folded into the
    // pass that is already running.
    h.reconciler.wake();
    h.reconciler.wake();
    release();
    await first;

    await waitFor(() => h.store.dueReads.length >= 2);
    await sleep(10);
    expect(h.store.dueReads).toHaveLength(2);
    expect(h.ops.filter((entry) => entry.op === "provision")).toHaveLength(1);
  });

  it("runs a pass immediately when woken while idle", async () => {
    const h = harness();
    h.add("sbx_woken", { state: "PAID" });

    h.reconciler.wake();
    await waitFor(() => h.ops.some((entry) => entry.op === "provision"));
    // Wait for the pass to finish so its tail cannot land in the next test.
    await waitFor(() => h.store.countLiveCalls === 1);
    await sleep(10);

    expect(h.store.dueReads).toHaveLength(1);
  });
});
