import { describe, expect, it } from "vitest";
import {
  SOURCE_STATES,
  transition,
  type SessionEvent,
  type SessionSnapshot,
} from "../../shared/src/domain/session.js";
import { SESSION_STATES } from "../../shared/src/protocol/lifecycle.js";

const NOW = Date.now();
const permissive: SessionSnapshot = {
  state: "CREATED",
  suspendable: true,
  hasPod: true,
  hasPvc: true,
  hasRelay: true,
  leaseExpiresAt: NOW + 60_000,
  suspendedAt: NOW - 1_000,
  createdAt: NOW - 60_000,
  maxLifetimeSeconds: 3_600,
  idlePolicy: null,
  lastActivityAt: NOW - 1_000,
};

const EVENTS: SessionEvent[] = [
  { type: "payment_settled" },
  { type: "provision_requested" },
  { type: "guest_ready" },
  { type: "operation_started" },
  { type: "operation_finished" },
  { type: "suspend_requested" },
  { type: "guest_stopped" },
  { type: "resume_requested" },
  { type: "lease_expired" },
  { type: "terminate_requested", reason: "client_destroy" },
  { type: "terminated", final: "DESTROYED" },
];

describe("session guards", () => {
  it("SOURCE_STATES matches the transition table for every state and event", () => {
    for (const state of SESSION_STATES) {
      for (const event of EVENTS) {
        const result = transition({ ...permissive, state }, event);
        const expected = SOURCE_STATES[event.type].includes(state);
        expect(result.ok, `${state} + ${event.type}`).toBe(expected);
      }
    }
  });

  it("provisions and resumes through one ready transition, with a per-state refusal", () => {
    for (const state of ["PROVISIONING", "RESUMING"] as const) {
      const ready = transition({ ...permissive, state }, { type: "guest_ready" });
      expect(ready.ok).toBe(true);
      if (ready.ok) {
        expect(ready.value.state).toBe("READY");
        expect(ready.value.effects).toEqual([{ type: "persist_ready" }]);
      }

      const missingRelay = transition({ ...permissive, state, hasRelay: false }, { type: "guest_ready" });
      expect(missingRelay.ok).toBe(false);
      if (!missingRelay.ok) expect(missingRelay.error.code).toBe("invariant");

      const refused = transition({ ...permissive, state }, { type: "operation_started" });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        // Combined arm, but the refusal still names the state it came from.
        expect(refused.error.message).toBe(`${state} accepts guest_ready or terminate`);
      }
    }
  });
});
