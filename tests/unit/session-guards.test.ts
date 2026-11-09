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
});
