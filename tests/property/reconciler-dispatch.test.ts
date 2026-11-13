/**
 * The per-session serialization guarantee, and the bounded concurrency that
 * shares it.
 *
 * `PhaseDispatcher` exists for one promise: no later pass may reconcile a
 * session that an earlier pass still has in flight, because lease expiry and
 * termination are stateful and two concurrent attempts on one id would race.
 * The eligibility filter alone does not keep that promise, because two passes
 * can filter the same list before either marks anything in flight, so the
 * guarantee is the second check inside the worker. That is the line these
 * properties defend.
 *
 * The rest is arithmetic an operator relies on: a pass never runs more callbacks
 * at once than its concurrency, and the count it returns is the number of
 * sessions it actually handed to the caller.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PhaseDispatcher } from "../../controller/src/reconciler/dispatch.js";
import type { SessionRecord } from "../../controller/src/store/models.js";
import { limitsFor, sessionFixture } from "../helpers/store-fixtures.js";

function session(id: string, state: SessionRecord["state"] = "READY"): SessionRecord {
  return sessionFixture({
    id,
    paymentKey: `payment-${id}`,
    tier: "standard",
    durationSeconds: 300,
    limits: limitsFor("unit"),
    clientPublicKey: "pk".repeat(22),
    clientNonce: "nn".repeat(22),
    overrides: { state },
  });
}

/** Tracks the highest number of concurrent entries and the total per session. */
function observer() {
  const concurrent = new Map<string, number>();
  const peak = new Map<string, number>();
  const total = new Map<string, number>();
  let active = 0;
  let peakActive = 0;

  return {
    async enter(id: string, holdMs: number) {
      const running = (concurrent.get(id) ?? 0) + 1;
      concurrent.set(id, running);
      peak.set(id, Math.max(peak.get(id) ?? 0, running));
      total.set(id, (total.get(id) ?? 0) + 1);
      active += 1;
      peakActive = Math.max(peakActive, active);
      if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
      active -= 1;
      concurrent.set(id, (concurrent.get(id) ?? 1) - 1);
    },
    peak,
    total,
    peakActive: () => peakActive,
  };
}

describe("a session is never reconciled twice at once", () => {
  it("holds when two passes filter the same sessions before either marks them", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 40 }),
        async (sessionCount, holdMs) => {
          const sessions = Array.from({ length: sessionCount }, (_, index) => session(`sbx_pass_${index}`));
          const dispatcher = new PhaseDispatcher({ concurrency: 4, now: () => 0 });
          const seen = observer();

          const pass = () =>
            dispatcher.run("readiness", sessions, (record) => seen.enter(record.id, holdMs));

          // Both passes start from the same eligibility snapshot: neither has
          // marked anything in flight when the other filters.
          await Promise.all([pass(), pass(), pass()]);

          for (const [id, highest] of seen.peak) {
            expect(highest, `${id} ran concurrently`).toBe(1);
          }
          for (const [, count] of seen.total) {
            expect(count).toBeGreaterThanOrEqual(1);
          }
        },
      ),
      { numRuns: 25 },
    );
  });

  it("never exceeds its concurrency", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 8 }),
        async (concurrency, sessionCount) => {
          const sessions = Array.from({ length: sessionCount }, (_, index) => session(`sbx_conc_${index}`));
          const dispatcher = new PhaseDispatcher({ concurrency, now: () => 0 });
          const seen = observer();

          await dispatcher.run("readiness", sessions, (record) => seen.enter(record.id, 5));

          expect(seen.peakActive()).toBeLessThanOrEqual(concurrency);
          expect(seen.peakActive()).toBe(Math.min(concurrency, sessionCount));
        },
      ),
      { numRuns: 20 },
    );
  });

  it("returns the number of sessions it handed to the caller", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 8 }), async (sessionCount) => {
        const sessions = Array.from({ length: sessionCount }, (_, index) => session(`sbx_count_${index}`));
        const dispatcher = new PhaseDispatcher({ concurrency: 3, now: () => 0 });
        const seen = observer();

        const dispatched = await dispatcher.run("cleanup", sessions, (record) => seen.enter(record.id, 0));

        expect(dispatched).toBe(sessionCount);
        expect([...seen.total.values()].reduce((sum, count) => sum + count, 0)).toBe(sessionCount);
      }),
      { numRuns: 20 },
    );
  });

  it("releases a session when the callback throws, so the next pass can run it", async () => {
    const dispatcher = new PhaseDispatcher({ concurrency: 2, now: () => 0 });
    const target = session("sbx_throws");
    let attempts = 0;

    await expect(
      dispatcher.run("readiness", [target], async () => {
        attempts += 1;
        throw new Error("reconcile failed");
      }),
    ).rejects.toThrow("reconcile failed");

    await dispatcher.run("readiness", [target], async () => {
      attempts += 1;
    });

    expect(attempts).toBe(2);
  });
});
