import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  type IdlePolicy,
  type SessionEvent,
  type SessionSnapshot,
  type SessionState,
  finalStateForReason,
  idleExpired,
  isTerminal,
  lifetimeExpired,
  remainingSeconds,
  suspendedExpired,
  transition,
} from "../../shared/src/index.js";

const STATES: SessionState[] = [
  "CREATED",
  "PAID",
  "PROVISIONING",
  "READY",
  "ACTIVE",
  "SUSPENDED",
  "TERMINATING",
  "EXPIRED",
  "FAILED",
  "DESTROYED",
];

const stateArb = fc.constantFrom(...STATES);
const eventArb: fc.Arbitrary<SessionEvent> = fc.oneof(
  fc.constant({ type: "payment_settled" } as const),
  fc.constant({ type: "provision_requested" } as const),
  fc.constant({ type: "guest_ready" } as const),
  fc.constant({ type: "operation_started" } as const),
  fc.constant({ type: "operation_finished" } as const),
  fc.constant({ type: "suspend_requested" } as const),
  fc.constant({ type: "resume_requested" } as const),
  fc.constant({ type: "lease_expired" } as const),
  fc.record({ type: fc.constant("terminate_requested" as const), reason: fc.string() }),
  fc.record({
    type: fc.constant("terminated" as const),
    final: fc.constantFrom("EXPIRED" as const, "FAILED" as const, "DESTROYED" as const),
  }),
);

const idlePolicyArb: fc.Arbitrary<IdlePolicy> = fc.record({
  maxIdleSeconds: fc.option(fc.integer({ min: 1, max: 28_800 }), { nil: undefined }),
  suspendedDurationSeconds: fc.option(fc.integer({ min: 1, max: 28_800 }), { nil: undefined }),
  autoResume: fc.option(fc.boolean(), { nil: undefined }),
});

const snapshotArb: fc.Arbitrary<SessionSnapshot> = fc.record({
  state: stateArb,
  suspendable: fc.boolean(),
  hasPod: fc.boolean(),
  hasPvc: fc.boolean(),
  hasRelay: fc.boolean(),
  leaseExpiresAt: fc.option(fc.integer({ min: 0, max: 10 ** 12 }), { nil: null }),
  suspendedAt: fc.option(fc.integer({ min: 0, max: 10 ** 12 }), { nil: null }),
  createdAt: fc.integer({ min: 0, max: 10 ** 12 }),
  maxLifetimeSeconds: fc.option(fc.integer({ min: 1, max: 28_800 }), { nil: null }),
  idlePolicy: fc.option(idlePolicyArb, { nil: null }),
  lastActivityAt: fc.option(fc.integer({ min: 0, max: 10 ** 12 }), { nil: null }),
});

describe("session state machine properties", () => {
  it("is total and never throws", () => {
    fc.assert(
      fc.property(snapshotArb, eventArb, (snapshot, event) => {
        const result = transition(snapshot, event);
        expect(result.ok === true || result.ok === false).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it("terminal states absorb every event", () => {
    fc.assert(
      fc.property(snapshotArb, eventArb, (snapshot, event) => {
        fc.pre(isTerminal(snapshot.state));
        expect(transition(snapshot, event).ok).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it("only enters SUSPENDED with a suspendable session and a workspace", () => {
    fc.assert(
      fc.property(snapshotArb, eventArb, (snapshot, event) => {
        const result = transition(snapshot, event);
        if (result.ok && result.value.state === "SUSPENDED") {
          expect(snapshot.suspendable).toBe(true);
          expect(snapshot.hasPvc).toBe(true);
          expect(["READY", "ACTIVE"]).toContain(snapshot.state);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("enters READY only from PROVISIONING with a pod and relay", () => {
    fc.assert(
      fc.property(snapshotArb, eventArb, (snapshot, event) => {
        const result = transition(snapshot, event);
        if (result.ok && result.value.state === "READY" && event.type === "guest_ready") {
          expect(snapshot.state).toBe("PROVISIONING");
          expect(snapshot.hasPod).toBe(true);
          expect(snapshot.hasRelay).toBe(true);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("enters PROVISIONING only from PAID or SUSPENDED", () => {
    fc.assert(
      fc.property(snapshotArb, eventArb, (snapshot, event) => {
        const result = transition(snapshot, event);
        if (result.ok && result.value.state === "PROVISIONING") {
          expect(["PAID", "SUSPENDED"]).toContain(snapshot.state);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("suspends only from READY/ACTIVE and resumes only from SUSPENDED", () => {
    fc.assert(
      fc.property(snapshotArb, (snapshot) => {
        const suspend = transition(snapshot, { type: "suspend_requested" });
        if (suspend.ok) expect(["READY", "ACTIVE"]).toContain(snapshot.state);
        const resume = transition(snapshot, { type: "resume_requested" });
        if (resume.ok) expect(snapshot.state).toBe("SUSPENDED");
      }),
      { numRuns: 1000 },
    );
  });

  it("suspend keeps the workspace; terminate and resume effects are consistent", () => {
    fc.assert(
      fc.property(snapshotArb, (snapshot) => {
        const suspend = transition(snapshot, { type: "suspend_requested" });
        if (suspend.ok) {
          const types = suspend.value.effects.map((effect) => effect.type);
          expect(types).not.toContain("delete_workspace_pvc");
          expect(types).toContain("persist_suspended");
          if (snapshot.hasPvc) expect(types).not.toContain("ensure_workspace_pvc");
        }
        const terminate = transition(snapshot, { type: "terminate_requested", reason: "client_destroy" });
        if (terminate.ok && terminate.value.state === "TERMINATING") {
          const types = terminate.value.effects.map((effect) => effect.type);
          if (snapshot.hasRelay) expect(types).toContain("purge_relay");
          if (snapshot.hasPvc) expect(types).toContain("delete_workspace_pvc");
          if (snapshot.hasPod) expect(types).toContain("delete_pod");
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("remainingSeconds is zero exactly when the lease is absent or elapsed", () => {
    fc.assert(
      fc.property(
        snapshotArb,
        fc.integer({ min: 0, max: 10 ** 12 }),
        (snapshot, now) => {
          const remaining = remainingSeconds(snapshot, now);
          if (snapshot.leaseExpiresAt === null) {
            expect(remaining).toBe(0);
          } else if (now >= snapshot.leaseExpiresAt || snapshot.leaseExpiresAt - now < 1000) {
            expect(remaining).toBe(0);
          } else {
            expect(remaining).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("remainingSeconds is monotone non-increasing", () => {
    fc.assert(
      fc.property(
        snapshotArb,
        fc.integer({ min: 0, max: 10 ** 12 }),
        fc.integer({ min: 0, max: 10 ** 6 }),
        (snapshot, now, delta) => {
          expect(remainingSeconds(snapshot, now + delta)).toBeLessThanOrEqual(
            remainingSeconds(snapshot, now),
          );
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("lifetime/idle/suspended expiry are monotone in time", () => {
    fc.assert(
      fc.property(
        snapshotArb,
        fc.integer({ min: 0, max: 10 ** 12 }),
        fc.integer({ min: 0, max: 10 ** 6 }),
        (snapshot, now, delta) => {
          if (lifetimeExpired(snapshot, now)) expect(lifetimeExpired(snapshot, now + delta)).toBe(true);
          if (idleExpired(snapshot, now)) expect(idleExpired(snapshot, now + delta)).toBe(true);
          if (suspendedExpired(snapshot, now)) {
            expect(suspendedExpired(snapshot, now + delta)).toBe(true);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("finalStateForReason is total and obeys the documented prefixes", () => {
    fc.assert(
      fc.property(fc.string(), (reason) => {
        const state = finalStateForReason(reason);
        expect(["EXPIRED", "FAILED", "DESTROYED"]).toContain(state);
        if (reason.startsWith("lease_expired")) expect(state).toBe("EXPIRED");
        if (reason.startsWith("suspended_expired")) expect(state).toBe("EXPIRED");
        if (reason.startsWith("max_lifetime")) expect(state).toBe("EXPIRED");
        if (reason.startsWith("failure")) expect(state).toBe("FAILED");
        if (reason.startsWith("pod_")) expect(state).toBe("FAILED");
        if (reason.startsWith("client_destroy")) expect(state).toBe("DESTROYED");
      }),
      { numRuns: 1000 },
    );
  });
});
