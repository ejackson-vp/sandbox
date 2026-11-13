/**
 * Resume is one refusal ladder.
 *
 * The order is the contract: state, lifetime, suspended expiry, checkpoint,
 * node affinity, data plane, capacity. Each rung has a different owner and a
 * different retry, so a reordering changes what a client is told and whether a
 * checkpoint is terminated. The property compares the whole ladder against a
 * reference rule over arbitrary rows rather than one example per rung.
 *
 * The second half is the sweep: lifetime before idle before suspended expiry,
 * with terminal rows never rewritten, and the cleanup pass deleting each
 * terminal workspace exactly once.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  isTerminal,
  leaseDeadline,
  transition,
  type SessionEffect,
  type SessionEvent,
  type SessionSnapshot,
  type SessionState,
} from "@x402s/shared/protocol";
import {
  NOW,
  baseShape,
  harness,
  record,
  refusal,
  shapeArb,
  stateArb,
  type SessionShape,
} from "../helpers/lifecycle-harness.js";

interface ResumeVariant {
  state: SessionState;
  suspendable: boolean;
  hasPvc: boolean;
  maxLifetimeSeconds: number | null;
  ageMs: number;
  suspendedForMs: number | null;
  suspendedDurationSeconds: number | null;
  pvcExists: boolean;
  pinNode: boolean;
  nodeName: string | null;
  nodeAvailable: boolean;
  endpointsAvailable: boolean;
  admitted: boolean;
}

const resumeArb: fc.Arbitrary<ResumeVariant> = fc.record({
  state: stateArb,
  suspendable: fc.boolean(),
  hasPvc: fc.boolean(),
  maxLifetimeSeconds: fc.option(fc.integer({ min: 1, max: 28_800 }), { nil: null }),
  ageMs: fc.integer({ min: 0, max: 10 ** 9 }),
  suspendedForMs: fc.option(fc.integer({ min: 0, max: 10 ** 9 }), { nil: null }),
  suspendedDurationSeconds: fc.option(fc.integer({ min: 1, max: 28_800 }), { nil: null }),
  pvcExists: fc.boolean(),
  pinNode: fc.boolean(),
  nodeName: fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: null }),
  nodeAvailable: fc.boolean(),
  endpointsAvailable: fc.boolean(),
  admitted: fc.boolean(),
});


describe("resume follows one refusal ladder", () => {
  it("checks state, lifetime, expiry, checkpoint, node, data plane and capacity in that order", async () => {
    await fc.assert(
      fc.asyncProperty(resumeArb, async (variant) => {
        const shape: SessionShape = {
          state: variant.state,
          suspendable: variant.suspendable,
          hasPvc: variant.hasPvc,
          hasPod: false,
          hasRelay: false,
          nodeName: variant.nodeName,
          maxLifetimeSeconds: variant.maxLifetimeSeconds,
          ageMs: variant.ageMs,
          suspendedForMs: variant.suspendedForMs,
          maxIdleSeconds: null,
          lastActivityAgoMs: null,
          suspendedDurationSeconds: variant.suspendedDurationSeconds,
        };
        const h = harness({
          sessions: [record(shape)],
          pvcExists: variant.pvcExists,
          nodeAvailable: variant.nodeAvailable,
          endpoints: variant.endpointsAvailable
            ? { relay: { host: "relay", port: 8443 }, proxy: { host: "proxy", port: 3128 } }
            : { relay: null, proxy: null },
          admission: variant.admitted
            ? { admitted: true }
            : { admitted: false, reason: "insufficient_cpu", retryable: true },
        });
        h.cfg.pinCheckpointNode = variant.pinNode;

        const lifetimeExpired =
          variant.maxLifetimeSeconds !== null && variant.ageMs > variant.maxLifetimeSeconds * 1000;
        // The policy only exists on a suspendable row (idlePolicyJson).
        const suspendedExpired =
          variant.suspendable &&
          variant.suspendedForMs !== null &&
          variant.suspendedDurationSeconds !== null &&
          variant.suspendedForMs > variant.suspendedDurationSeconds * 1000;
        const resumable = variant.state === "SUSPENDED" && variant.hasPvc;

        // The expected rung, in the module's order.
        const expected: string | null = !resumable
          ? "not_suspended"
          : lifetimeExpired
            ? "max_lifetime"
            : suspendedExpired
              ? "suspended_expired"
              : !variant.pvcExists
                ? "resume_unavailable"
                : variant.pinNode && variant.nodeName !== null && !variant.nodeAvailable
                  ? "resume_unavailable"
                  : !variant.endpointsAvailable
                    ? "control_plane_unavailable"
                    : !variant.admitted
                      ? "capacity_unavailable"
                      : null;

        const err = await refusal(h.lifecycle.resume("sbx_lifecycle"));
        expect(err?.code ?? null).toBe(expected);

        const after = await h.store.getSession("sbx_lifecycle");
        if (expected === null) {
          expect(after!.state).toBe("RESUMING");
          expect(h.restores).toEqual(["sbx_lifecycle"]);
          expect(h.capacityCalls.resume).toEqual(["sbx_lifecycle"]);
          expect(h.starts).toHaveLength(1);
          expect(h.starts[0]!.resume).toBe(true);
          if (variant.pinNode && variant.nodeName) {
            expect(h.starts[0]!.nodeName).toBe(variant.nodeName);
          }
          return;
        }

        // No refused resume reached the checkpoint restore or the pod create.
        expect(h.restores).toHaveLength(0);
        expect(h.starts).toHaveLength(0);
        if (expected === "max_lifetime") {
          expect(h.store.terminations.map((call) => call.reason)).toContain("max_lifetime");
          expect(after!.state).toBe("TERMINATING");
        } else if (expected === "suspended_expired") {
          expect(h.store.terminations.map((call) => call.reason)).toContain("suspended_expired");
          expect(after!.state).toBe("TERMINATING");
        } else if (expected === "capacity_unavailable") {
          expect(after!.state).toBe("SUSPENDED");
          expect(h.capacityCalls.resume).toEqual(["sbx_lifecycle"]);
        } else if (expected === "resume_unavailable" && !variant.pvcExists) {
          expect(h.store.terminations[0]?.code).toBe("checkpoint_missing");
          expect(after!.state).toBe("TERMINATING");
        } else {
          expect(after!.state).toBe(variant.state);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("reports a lost RESUMING write and leaves the row resumable", async () => {
    const h = harness({ sessions: [record({ ...baseShape(), state: "SUSPENDED", hasPvc: true })] });
    // The pod create lost its race with a destroy. Provisioning owns the
    // rollback (delete the pod, purge the relay, suspend the reservation); the
    // use case must not pretend the session moved.
    h.store.markResuming = async () => false;
    const err = await refusal(h.lifecycle.resume("sbx_lifecycle"));
    expect(err?.code).toBe("not_suspended");
    expect(h.capacityCalls.resume).toEqual(["sbx_lifecycle"]);
    expect((await h.store.getSession("sbx_lifecycle"))!.state).toBe("SUSPENDED");
    expect(h.starts).toHaveLength(1);
  });

  it("names each late refusal for what it is", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("node", "endpoints", "capacity"), async (rung) => {
        const h = harness({
          sessions: [
            record({
              ...baseShape(),
              state: "SUSPENDED",
              hasPod: false,
              hasRelay: false,
              nodeName: rung === "node" ? "node-a" : null,
            }),
          ],
          pvcExists: true,
          nodeAvailable: rung !== "node",
          endpoints:
            rung === "endpoints"
              ? { relay: null, proxy: null }
              : { relay: { host: "relay", port: 8443 }, proxy: { host: "proxy", port: 3128 } },
          admission: rung === "capacity" ? { admitted: false, reason: "insufficient_cpu", retryable: true } : { admitted: true },
        });
        h.cfg.pinCheckpointNode = rung === "node";
        const err = await refusal(h.lifecycle.resume("sbx_lifecycle"));
        if (rung === "node") expect(err?.code).toBe("resume_unavailable");
        if (rung === "endpoints") {
          expect(err?.code).toBe("control_plane_unavailable");
          expect(err?.status).toBe(503);
        }
        if (rung === "capacity") {
          expect(err?.code).toBe("capacity_unavailable");
          expect((await h.store.getSession("sbx_lifecycle"))!.state).toBe("SUSPENDED");
        }
        expect(h.starts).toHaveLength(0);
      }),
      { numRuns: 6 },
    );
  });

  it("returns the compute reservation when the restore throws", async () => {
    const h = harness({
      sessions: [record({ ...baseShape(), state: "SUSPENDED", hasPod: false, hasRelay: false })],
      restoreThrows: true,
    });
    // The restore failure is not a lifecycle refusal: it is rethrown, and the
    // compute reservation is handed back on the way out.
    await expect(h.lifecycle.resume("sbx_lifecycle")).rejects.toThrow("checkpoint restore failed");
    expect(h.capacityCalls.resume).toEqual(["sbx_lifecycle"]);
    expect(h.capacityCalls.suspend).toEqual(["sbx_lifecycle"]);
    expect((await h.store.getSession("sbx_lifecycle"))!.state).toBe("SUSPENDED");
  });
});

describe("enforce reads one list and applies one policy", () => {
  it("matches lifetime, then idle, then suspended expiry over arbitrary rows", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(shapeArb, { maxLength: 6 }), async (shapes) => {
        const sessions = shapes.map((shape, index) => {
          const row = record(shape);
          return { ...row, id: `sbx_${index}`, workspacePvc: shape.hasPvc ? `x402-ws-sbx_${index}` : null };
        });
        const h = harness({ sessions });

        const expectedTerminations: Array<{ id: string; reason: string }> = [];
        const expectedSuspends: string[] = [];
        for (const session of sessions) {
          if (isTerminal(session.state)) continue;
          const lifetime =
            session.maxLifetimeSeconds !== null &&
            NOW - session.createdAt > session.maxLifetimeSeconds * 1000;
          const idlePolicy = session.idlePolicyJson
            ? (JSON.parse(session.idlePolicyJson) as { maxIdleSeconds?: number })
            : {};
          const idle =
            ["READY", "ACTIVE"].includes(session.state) &&
            Boolean(idlePolicy.maxIdleSeconds) &&
            session.lastActivityAt !== null &&
            NOW - session.lastActivityAt > idlePolicy.maxIdleSeconds! * 1000;
          const suspended =
            session.state === "SUSPENDED" &&
            Boolean(
              session.idlePolicyJson &&
                JSON.parse(session.idlePolicyJson).suspendedDurationSeconds &&
                session.suspendedAt !== null &&
                NOW - session.suspendedAt >
                  JSON.parse(session.idlePolicyJson).suspendedDurationSeconds * 1000,
            );
          // The SQL guard refuses CREATED: nothing can terminate a row that
          // has no entitlement, so the sweep's call is a no-op there.
          const canTerminate = [
            "PAID",
            "PROVISIONING",
            "READY",
            "ACTIVE",
            "SUSPENDING",
            "SUSPENDED",
            "RESUMING",
          ].includes(session.state);
          if (lifetime && canTerminate) {
            expectedTerminations.push({ id: session.id, reason: "max_lifetime" });
          } else if (lifetime) {
            // Refused, and the sweep moves on: no idle or suspended branch.
          } else if (idle) {
            if (session.idlePolicyJson && session.workspacePvc) expectedSuspends.push(session.id);
          } else if (suspended) {
            expectedTerminations.push({ id: session.id, reason: "suspended_expired" });
          }
        }

        await h.lifecycle.enforce();

        expect(h.store.terminations.map(({ id, reason }) => ({ id, reason })).sort((a, b) =>
          a.id < b.id ? -1 : 1,
        )).toEqual(
          [...expectedTerminations].sort((a, b) => (a.id < b.id ? -1 : 1)),
        );
        for (const id of expectedSuspends) {
          expect((await h.store.getSession(id))!.state).toBe("SUSPENDED");
        }
        for (const session of sessions) {
          if (!expectedSuspends.includes(session.id) && !expectedTerminations.some((call) => call.id === session.id)) {
            expect((await h.store.getSession(session.id))!.state).toBe(session.state);
          }
        }
        // Terminal rows are not in the list, so a terminal row is never rewritten.
        for (const session of sessions) {
          if (isTerminal(session.state)) {
            expect((await h.store.getSession(session.id))!.state).toBe(session.state);
          }
        }
      }),
      { numRuns: 60 },
    );
  });

  it("swallows a failed idle suspend and keeps sweeping", async () => {
    const h = harness({
      sessions: [
        record({
          ...baseShape(),
          state: "READY",
          suspendable: false,
          hasPvc: false,
          maxIdleSeconds: 1,
          lastActivityAgoMs: 5_000,
        }),
      ],
    });
    await h.lifecycle.enforce();
    // No workspace means suspend refuses; the sweep records it and moves on.
    expect((await h.store.getSession("sbx_lifecycle"))!.state).toBe("READY");
    expect(h.store.terminations).toHaveLength(0);
  });

  it("terminates a session suspended past its policy", async () => {
    const h = harness({
      sessions: [
        record({
          ...baseShape(),
          state: "SUSPENDED",
          suspendedForMs: 5_000,
          suspendedDurationSeconds: 1,
          maxIdleSeconds: null,
        }),
      ],
    });
    await h.lifecycle.enforce();
    expect(h.store.terminations.map((call) => call.reason)).toEqual(["suspended_expired"]);
    expect((await h.store.getSession("sbx_lifecycle"))!.state).toBe("TERMINATING");
  });

  it("deletes exactly the terminal workspaces it is given, even when a delete fails", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(shapeArb, { maxLength: 6 }), async (shapes) => {
        const sessions = shapes.map((shape, index) => {
          const row = record(shape);
          return {
            ...row,
            id: `sbx_${index}`,
            state: isTerminal(shape.state) ? shape.state : "EXPIRED",
            workspacePvc: shape.hasPvc ? `x402-ws-sbx_${index}` : null,
          };
        });
        const h = harness({ sessions });
        const expected = sessions.filter((session) => session.workspacePvc !== null).map((session) => session.workspacePvc!);
        await h.lifecycle.cleanup();
        expect([...h.pvcDeletes].sort()).toEqual([...expected].sort());
        expect(new Set(h.pvcDeletes).size).toBe(h.pvcDeletes.length);
        for (const session of sessions) {
          expect((await h.store.getSession(session.id))!.workspacePvc).toBeNull();
        }
      }),
      { numRuns: 40 },
    );
  });
});

describe("no paid session is stuck before READY", () => {
  it("has no reachable dead end from PAID, and every reachable state can reach a terminal one", () => {
    const snapshot: SessionSnapshot = {
      state: "PAID",
      suspendable: true,
      hasPod: true,
      hasPvc: true,
      hasRelay: true,
      leaseExpiresAt: null,
      suspendedAt: null,
      createdAt: NOW,
      maxLifetimeSeconds: 3_600,
      idlePolicy: { maxIdleSeconds: 300, suspendedDurationSeconds: 600 },
      lastActivityAt: NOW,
    };
    const events: SessionEvent[] = [
      { type: "payment_settled" },
      { type: "provision_requested" },
      { type: "guest_ready" },
      { type: "operation_started" },
      { type: "operation_finished" },
      { type: "suspend_requested" },
      { type: "suspend_retry" },
      { type: "guest_stopped" },
      { type: "resume_requested" },
      { type: "lease_expired" },
      { type: "terminate_requested", reason: "client_destroy" },
      { type: "terminated", final: "DESTROYED" },
      { type: "terminated", final: "EXPIRED" },
      { type: "terminated", final: "FAILED" },
    ];

    const reachable = new Map<SessionState, SessionState[]>();
    const queue: SessionState[] = ["PAID"];
    while (queue.length > 0) {
      const state = queue.shift()!;
      if (reachable.has(state)) continue;
      const next: SessionState[] = [];
      for (const event of events) {
        const result = transition({ ...snapshot, state }, event);
        if (result.ok) next.push(result.value.state);
      }
      reachable.set(state, next);
      for (const target of next) if (!reachable.has(target)) queue.push(target);
    }

    // Every reachable non-terminal state has at least one enabled event.
    for (const state of reachable.keys()) {
      if (!isTerminal(state)) expect(reachable.get(state)!.length).toBeGreaterThan(0);
    }
    expect([...reachable.keys()]).toContain("READY");
    for (const terminal of ["EXPIRED", "FAILED", "DESTROYED"] as const) {
      expect([...reachable.keys()]).toContain(terminal);
    }

    // And each reachable non-terminal state has a path to READY or a terminal.
    const canFinish = (state: SessionState, seen = new Set<SessionState>()): boolean => {
      if (isTerminal(state) || state === "READY") return true;
      if (seen.has(state)) return false;
      seen.add(state);
      return (reachable.get(state) ?? []).some((next) => canFinish(next, new Set(seen)));
    };
    for (const state of reachable.keys()) expect(canFinish(state)).toBe(true);
  });

  it("never leaves READY once the deadline is written, because the table has no event that rewrites it", () => {
    const snapshot: SessionSnapshot = {
      state: "READY",
      suspendable: true,
      hasPod: true,
      hasPvc: true,
      hasRelay: true,
      leaseExpiresAt: NOW + 60_000,
      suspendedAt: null,
      createdAt: NOW,
      maxLifetimeSeconds: 3_600,
      idlePolicy: null,
      lastActivityAt: NOW,
    };
    for (const event of [
      { type: "operation_started" as const },
      { type: "operation_finished" as const },
    ]) {
      const result = transition(snapshot, event);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.effects.some((effect: SessionEffect) => effect.type === "persist_ready")).toBe(false);
      }
    }
    // The deadline helper is a pure function of the three inputs: a later pass
    // computing it again cannot depend on the clock.
    const first = leaseDeadline(NOW - 1_000, NOW, 300, 3_600);
    expect(leaseDeadline(NOW - 1_000, NOW, 300, 3_600)).toBe(first);
    expect(first).toBe(NOW + 300_000);
  });
});
