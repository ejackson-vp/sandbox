/**
 * Reservation lifecycle at the service seam.
 *
 * These are the calls that decide whether compute is attached, resumed or
 * returned, and the reaper that repairs rows after a crash. The properties are
 * whole state tables over arbitrary rows: `resume` attaches only when there is
 * no live row and otherwise resumes, `beginRelease` names a Pod only when it
 * has one, and the reaper releases terminal sessions, suspends suspended ones,
 * confirms only a missing Pod, and never frees capacity for a Pod that still
 * exists. The runtime guard is checked before the snapshot and before any hold
 * is written, because a charge must not be created for a profile the controller
 * cannot run.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { requestForLimits, requestForSession } from "../../controller/src/capacity/types.js";
import type { ReservationState } from "../../controller/src/capacity/types.js";
import type { SessionRecord } from "../../controller/src/store/models.js";
import { limitsFor, sessionFixture } from "../helpers/store-fixtures.js";
import {
  NOW,
  RESERVATION_STATES,
  harness,
  record,
} from "../helpers/capacity-harness.js";

describe("resume chooses attach or resume by the durable row", () => {
  it("attaches when there is no live reservation and otherwise asks the model to resume", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<"none" | ReservationState>("none", ...RESERVATION_STATES),
        fc.boolean(),
        fc.string({ minLength: 1, maxLength: 8 }),
        async (existingState, pinNode, nodeName) => {
          const session = sessionFixture({
            id: "sbx_capacity",
            paymentKey: "payment-capacity",
            tier: "standard",
            durationSeconds: 300,
            limits: limitsFor("unit"),
            clientPublicKey: "pk".repeat(22),
            clientNonce: "nn".repeat(22),
            overrides: { nodeName },
          });
          const rows = existingState === "none" ? [] : [{ ...record("existing", existingState), sessionId: session.id }];
          const h = harness({
            env: { PIN_CHECKPOINT_NODE: String(pinNode) },
            rows,
            sessions: new Map([[session.id, session]]),
          });
          const admission = await h.service.resume(session);
          expect(admission.admitted).toBe(true);

          const expectedRequest = requestForSession(session);
          if (pinNode) expectedRequest.requiredNodeId = nodeName;
          if (existingState === "none" || existingState === "RELEASED") {
            expect(h.reservations.attachCalls).toHaveLength(1);
            expect(h.reservations.resumeCalls).toHaveLength(0);
            expect(h.reservations.attachCalls[0]).toMatchObject({
              paymentKey: session.paymentKey,
              sessionId: session.id,
              request: expectedRequest,
            });
          } else {
            expect(h.reservations.resumeCalls).toHaveLength(1);
            expect(h.reservations.attachCalls).toHaveLength(0);
            expect(h.reservations.resumeCalls[0]).toEqual({ sessionId: session.id, request: expectedRequest });
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe("release names the Pod only when it has one", () => {
  it("delegates beginRelease versus releaseSession by podName", async () => {
    await fc.assert(
      fc.asyncProperty(fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: null }), async (podName) => {
        const h = harness();
        expect(await h.service.beginRelease("sbx_release", podName)).toBe(true);
        if (podName === null) {
          expect(h.reservations.releaseSessionCalls).toEqual(["sbx_release"]);
          expect(h.reservations.beginReleaseCalls).toHaveLength(0);
        } else {
          expect(h.reservations.beginReleaseCalls).toEqual([{ sessionId: "sbx_release", podName }]);
          expect(h.reservations.releaseSessionCalls).toHaveLength(0);
        }
      }),
      { numRuns: 20 },
    );
  });
});

describe("the reaper follows the state table", () => {
  it("releases terminal, suspends suspended and confirms only a missing Pod", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 8 }),
            reservationState: fc.constantFrom<ReservationState>(
              "HELD",
              "ALLOCATED",
              "SUSPENDED",
              "RELEASING",
            ),
            sessionState: fc.constantFrom(
              "PAID",
              "READY",
              "SUSPENDED",
              "EXPIRED",
              "FAILED",
              "DESTROYED",
            ),
            podName: fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: null }),
            missingSession: fc.boolean(),
          }),
          { maxLength: 5 },
        ),
        fc.boolean(),
        async (rows, podExists) => {
          const sessions = new Map<string, SessionRecord>();
          const pods = new Map<string, boolean>();
          const assigned = rows.map((row, index) => {
            const id = `sbx_${index}`;
            const session = sessionFixture({
              id,
              paymentKey: `payment-${index}`,
              tier: "standard",
              durationSeconds: 300,
              limits: limitsFor("unit"),
              clientPublicKey: "pk".repeat(22),
              clientNonce: "nn".repeat(22),
              overrides: { state: row.sessionState as SessionRecord["state"] },
            });
            if (!row.missingSession) sessions.set(id, session);
            if (row.podName) pods.set(row.podName, podExists);
            return {
              ...record(row.id, row.reservationState),
              id: row.id,
              sessionId: id,
              podName: row.podName,
              updatedAt: NOW - 120_000,
            };
          });
          const h = harness({ rows: assigned, sessions, pods });

          const expectedBeginRelease: string[] = [];
          const expectedRelease: string[] = [];
          const expectedSuspend: string[] = [];
          const expectedConfirm: string[] = [];
          // The reaper does two passes: active rows first, then a fresh read of
          // RELEASING. A row beginRelease just moved is therefore confirmed in
          // the same pass when its Pod is already gone.
          const after = new Map(assigned.map((row) => [row.id, row.state]));
          for (const row of assigned) {
            if (row.state === "RELEASING") continue;
            const session = sessions.get(row.sessionId!);
            if (!session) continue;
            if (["EXPIRED", "FAILED", "DESTROYED"].includes(session.state)) {
              if (row.podName) {
                expectedBeginRelease.push(row.sessionId!);
                after.set(row.id, "RELEASING");
              } else {
                expectedRelease.push(row.sessionId!);
              }
            } else if (session.state === "SUSPENDED" && row.state === "ALLOCATED") {
              expectedSuspend.push(row.sessionId!);
            }
          }
          for (const row of assigned) {
            if (after.get(row.id) !== "RELEASING") continue;
            if (!row.podName || !pods.get(row.podName)) expectedConfirm.push(row.sessionId!);
          }

          await h.service.reap();

          expect(h.reservations.beginReleaseCalls.map((call) => call.sessionId)).toEqual(expectedBeginRelease);
          expect(h.reservations.releaseSessionCalls).toEqual(expectedRelease);
          expect(h.reservations.suspendCalls).toEqual(expectedSuspend);
          expect(h.reservations.confirmReleaseCalls).toEqual(expectedConfirm);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("a rejected runtime never creates a hold", () => {
  it("refuses before the snapshot or the reservation store is touched", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 16 }).filter((name) => name !== "base" && name !== ""),
        fc.integer({ min: 1, max: 4_000 }),
        fc.integer({ min: 1, max: 8_192 }),
        async (runtime, cpuMillis, memoryMiB) => {
          const h = harness();
          const spec = { runtime, limits: { cpuMillis, memoryMiB, diskMiB: 128 } };
          const preflight = await h.service.preflight(spec);
          const hold = await h.service.hold("payment", "spec", spec);
          for (const decision of [preflight, hold]) {
            expect(decision.admitted).toBe(false);
            if (!decision.admitted) {
              expect(decision.reason).toBe("runtime_profile_unavailable");
              expect(decision.retryable).toBe(false);
            }
          }
          expect(h.reservations.admitCalls).toHaveLength(0);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("passes the limits and the explicit baseline through unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4_000 }),
        fc.integer({ min: 1, max: 8_192 }),
        fc.integer({ min: 1, max: 2_000 }),
        fc.integer({ min: 1, max: 4_096 }),
        async (cpuMillis, memoryMiB, baselineCpu, baselineMemory) => {
          const h = harness();
          const spec = {
            limits: { cpuMillis, memoryMiB, diskMiB: 256 },
            baseline: { cpuMillis: baselineCpu, memoryMiB: baselineMemory },
          };
          await h.service.hold("payment", "spec", spec);
          expect(h.reservations.admitCalls).toHaveLength(1);
          expect(h.reservations.admitCalls[0]!.request).toEqual(requestForLimits(spec.limits, spec.baseline));
          expect(h.reservations.admitCalls[0]!.opts).toMatchObject({
            paymentKey: "payment",
            specHash: "spec",
            ttlMs: h.cfg.capacityHoldTtlMs,
          });
        },
      ),
      { numRuns: 40 },
    );
  });
});
