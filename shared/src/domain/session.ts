/**
 * Pure session lifecycle: one transition table, guards and effects as data.
 *
 * This module has no I/O, no clock and no Kubernetes. The imperative shell
 * (reconciler, use cases) builds a SessionSnapshot, asks for a decision, and
 * performs the effects. Property tests exercise the table directly.
 */
import { type IdlePolicy, type SessionState, isTerminal } from "../protocol.js";
import { Err, Ok, type Result } from "../fp.js";

export interface SessionSnapshot {
  state: SessionState;
  /** Customer opted into checkpoint/suspend. */
  suspendable: boolean;
  hasPod: boolean;
  hasPvc: boolean;
  hasRelay: boolean;
  leaseExpiresAt: number | null;
  suspendedAt: number | null;
  createdAt: number;
  maxLifetimeSeconds: number | null;
  idlePolicy: IdlePolicy | null;
  lastActivityAt: number | null;
}

export type SessionEvent =
  | { type: "payment_settled" }
  | { type: "provision_requested" }
  | { type: "guest_ready" }
  | { type: "operation_started" }
  | { type: "operation_finished" }
  | { type: "suspend_requested" }
  | { type: "guest_stopped" }
  | { type: "resume_requested" }
  | { type: "lease_expired" }
  | { type: "terminate_requested"; reason: string }
  | { type: "terminated"; final: "EXPIRED" | "FAILED" | "DESTROYED" };

/**
 * States from which each event is accepted, ignoring non-state guards
 * (suspendability, workspace presence, pod/relay invariants).
 *
 * The store's SQL guards are built from this map, and a test asserts it matches
 * transition() for every state/event pair. Change the table, and the store
 * follows.
 */
export const SOURCE_STATES: Readonly<Record<SessionEvent["type"], readonly SessionState[]>> = {
  payment_settled: ["CREATED"],
  provision_requested: ["PAID"],
  guest_ready: ["PROVISIONING", "RESUMING"],
  operation_started: ["READY", "ACTIVE"],
  operation_finished: ["READY", "ACTIVE"],
  suspend_requested: ["READY", "ACTIVE"],
  guest_stopped: ["SUSPENDING"],
  resume_requested: ["SUSPENDED"],
  lease_expired: ["PROVISIONING", "READY", "ACTIVE", "SUSPENDING", "SUSPENDED", "RESUMING"],
  terminate_requested: [
    "PAID",
    "PROVISIONING",
    "READY",
    "ACTIVE",
    "SUSPENDING",
    "SUSPENDED",
    "RESUMING",
  ],
  terminated: ["TERMINATING"],
};

export type SessionEffect =
  | { type: "register_relay" }
  | { type: "purge_relay" }
  | { type: "ensure_workspace_pvc" }
  | { type: "start_pod"; warm: boolean }
  | { type: "stop_guest" }
  | { type: "delete_pod" }
  | { type: "delete_workspace_pvc" }
  | { type: "persist_ready" }
  | { type: "persist_suspending" }
  | { type: "persist_suspended" }
  | { type: "finalize"; final: "EXPIRED" | "FAILED" | "DESTROYED" };

export interface TransitionError {
  readonly code:
    | "terminal"
    | "invalid_transition"
    | "not_suspendable"
    | "not_resumable"
    | "invariant";
  readonly message: string;
  readonly from: SessionState;
  readonly event: SessionEvent["type"];
}

export interface Transition {
  readonly state: SessionState;
  readonly effects: readonly SessionEffect[];
}

function fail(
  snapshot: SessionSnapshot,
  event: SessionEvent,
  code: TransitionError["code"],
  message: string,
): Result<Transition, TransitionError> {
  return Err({ code, message, from: snapshot.state, event: event.type });
}

function terminateEffects(snapshot: SessionSnapshot): SessionEffect[] {
  return [
    ...(snapshot.hasPod ? [{ type: "stop_guest" as const }, { type: "delete_pod" as const }] : []),
    ...(snapshot.hasRelay ? [{ type: "purge_relay" as const }] : []),
    ...(snapshot.hasPvc ? [{ type: "delete_workspace_pvc" as const }] : []),
  ];
}

export function transition(
  snapshot: SessionSnapshot,
  event: SessionEvent,
): Result<Transition, TransitionError> {
  if (isTerminal(snapshot.state)) {
    return fail(snapshot, event, "terminal", `session is already ${snapshot.state}`);
  }

  switch (snapshot.state) {
    case "CREATED":
      if (event.type === "payment_settled") return Ok({ state: "PAID", effects: [] });
      return fail(snapshot, event, "invalid_transition", "only a settled payment can leave CREATED");

    case "PAID":
      if (event.type === "provision_requested") {
        return Ok({
          state: "PROVISIONING",
          effects: [
            { type: "register_relay" },
            ...(snapshot.suspendable && !snapshot.hasPvc
              ? [{ type: "ensure_workspace_pvc" as const }]
              : []),
            { type: "start_pod", warm: !snapshot.suspendable },
          ],
        });
      }
      if (event.type === "terminate_requested") {
        return Ok({ state: "TERMINATING", effects: terminateEffects(snapshot) });
      }
      return fail(snapshot, event, "invalid_transition", "PAID accepts provision or terminate");

    case "PROVISIONING":
      if (event.type === "guest_ready") {
        if (!snapshot.hasPod || !snapshot.hasRelay) {
          return fail(snapshot, event, "invariant", "READY requires a pod and a relay entry");
        }
        return Ok({ state: "READY", effects: [{ type: "persist_ready" }] });
      }
      if (event.type === "terminate_requested" || event.type === "lease_expired") {
        return Ok({ state: "TERMINATING", effects: terminateEffects(snapshot) });
      }
      return fail(snapshot, event, "invalid_transition", "PROVISIONING accepts guest_ready or terminate");

    case "READY":
    case "ACTIVE":
      if (event.type === "operation_started") {
        return Ok({ state: "ACTIVE", effects: [] });
      }
      if (event.type === "operation_finished") {
        return Ok({ state: "READY", effects: [] });
      }
      if (event.type === "suspend_requested") {
        if (!snapshot.suspendable || !snapshot.hasPvc) {
          return fail(snapshot, event, "not_suspendable", "session has no checkpoint workspace");
        }
        return Ok({
          state: "SUSPENDING",
          effects: [
            ...(snapshot.hasPod ? [{ type: "stop_guest" as const }] : []),
            { type: "persist_suspending" },
          ],
        });
      }
      if (event.type === "lease_expired" || event.type === "terminate_requested") {
        return Ok({ state: "TERMINATING", effects: terminateEffects(snapshot) });
      }
      return fail(snapshot, event, "invalid_transition", "READY/ACTIVE accepts operations, suspend, or terminate");

    case "SUSPENDING":
      if (event.type === "guest_stopped") {
        return Ok({
          state: "SUSPENDED",
          effects: [
            ...(snapshot.hasPod ? [{ type: "delete_pod" as const }] : []),
            ...(snapshot.hasRelay ? [{ type: "purge_relay" as const }] : []),
            { type: "persist_suspended" },
          ],
        });
      }
      if (event.type === "lease_expired" || event.type === "terminate_requested") {
        return Ok({ state: "TERMINATING", effects: terminateEffects(snapshot) });
      }
      return fail(snapshot, event, "invalid_transition", "SUSPENDING accepts guest_stopped or terminate");

    case "SUSPENDED":
      if (event.type === "resume_requested") {
        if (!snapshot.hasPvc) {
          return fail(snapshot, event, "not_resumable", "session has no checkpoint workspace");
        }
        return Ok({
          state: "RESUMING",
          effects: [{ type: "register_relay" }, { type: "start_pod", warm: false }],
        });
      }
      if (event.type === "lease_expired" || event.type === "terminate_requested") {
        return Ok({ state: "TERMINATING", effects: terminateEffects(snapshot) });
      }
      if (event.type === "operation_started") {
        return fail(snapshot, event, "invalid_transition", "resume the session before operations");
      }
      return fail(snapshot, event, "invalid_transition", "SUSPENDED accepts resume or terminate");

    case "RESUMING":
      if (event.type === "guest_ready") {
        if (!snapshot.hasPod || !snapshot.hasRelay) {
          return fail(snapshot, event, "invariant", "READY requires a pod and a relay entry");
        }
        return Ok({ state: "READY", effects: [{ type: "persist_ready" }] });
      }
      if (event.type === "terminate_requested" || event.type === "lease_expired") {
        return Ok({ state: "TERMINATING", effects: terminateEffects(snapshot) });
      }
      return fail(snapshot, event, "invalid_transition", "RESUMING accepts guest_ready or terminate");

    case "TERMINATING":
      if (event.type === "terminated") {
        return Ok({ state: event.final, effects: [{ type: "finalize", final: event.final }] });
      }
      return fail(snapshot, event, "invalid_transition", "TERMINATING only accepts terminated");

    default:
      return fail(snapshot, event, "invalid_transition", `unknown state ${String(snapshot.state)}`);
  }
}

export function canSuspend(snapshot: SessionSnapshot): boolean {
  return transition(snapshot, { type: "suspend_requested" }).ok;
}

export function canResume(snapshot: SessionSnapshot): boolean {
  return transition(snapshot, { type: "resume_requested" }).ok;
}

export function lifetimeExpired(snapshot: SessionSnapshot, now: number): boolean {
  return Boolean(
    snapshot.maxLifetimeSeconds &&
      now - snapshot.createdAt > snapshot.maxLifetimeSeconds * 1000,
  );
}

export function idleExpired(snapshot: SessionSnapshot, now: number): boolean {
  return Boolean(
    (snapshot.state === "READY" || snapshot.state === "ACTIVE") &&
      snapshot.idlePolicy?.maxIdleSeconds &&
      snapshot.lastActivityAt &&
      now - snapshot.lastActivityAt > snapshot.idlePolicy.maxIdleSeconds * 1000,
  );
}

export function suspendedExpired(snapshot: SessionSnapshot, now: number): boolean {
  return Boolean(
    snapshot.state === "SUSPENDED" &&
      snapshot.idlePolicy?.suspendedDurationSeconds &&
      snapshot.suspendedAt &&
      now - snapshot.suspendedAt > snapshot.idlePolicy.suspendedDurationSeconds * 1000,
  );
}

export function remainingSeconds(snapshot: SessionSnapshot, now: number): number {
  if (snapshot.leaseExpiresAt === null) return 0;
  return Math.max(0, Math.floor((snapshot.leaseExpiresAt - now) / 1000));
}

/** Terminal state implied by a termination reason. Total over all strings. */
export function finalStateForReason(reason: string): "EXPIRED" | "FAILED" | "DESTROYED" {
  if (
    reason.startsWith("lease_expired") ||
    reason.startsWith("suspended_expired") ||
    reason.startsWith("max_lifetime")
  ) {
    return "EXPIRED";
  }
  if (reason.startsWith("failure") || reason.startsWith("pod_")) return "FAILED";
  if (reason.startsWith("client_destroy")) return "DESTROYED";
  return "DESTROYED";
}
