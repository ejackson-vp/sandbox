/**
 * Pure session lifecycle: one transition table, guards and effects as data.
 *
 * This module has no I/O, no clock and no Kubernetes. The imperative shell
 * (reconciler, use cases) builds a SessionSnapshot, asks for a decision, and
 * performs the effects. Property tests exercise the table directly.
 */
import { type IdlePolicy, type SessionState, isTerminal, MAX_SESSION_LIFETIME_SECONDS } from "../protocol.js";
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

/** Terminal states a session can be finalised into. */
export type FinalState = "EXPIRED" | "FAILED" | "DESTROYED";

export type SessionEvent =
  | { type: "payment_settled" }
  | { type: "provision_requested" }
  | { type: "guest_ready" }
  | { type: "operation_started" }
  | { type: "operation_finished" }
  | { type: "suspend_requested" }
  | { type: "guest_stopped" }
  /**
   * Replay the stop of a suspend that was interrupted after the state write.
   * Self-transition: it asks for the guest to stop again without moving the row,
   * because the checkpoint commit (`guest_stopped`) is a separate decision.
   */
  | { type: "suspend_retry" }
  | { type: "resume_requested" }
  | { type: "lease_expired" }
  | { type: "terminate_requested"; reason: string }
  | { type: "terminated"; final: FinalState };

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
  suspend_retry: ["SUSPENDING"],
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

/**
 * The work a transition asks the shell to do, as data.
 *
 * The set is closed and exhaustive: the controller's interpreter
 * (`controller/src/effects.ts`) switches on `type` and ends in `assertNever`,
 * so a new variant fails `tsc` until it is executed.
 *
 * Payloads carry plain values only. Anything the table cannot know (pod name,
 * relay endpoint, the ready handshake) belongs to the interpreter's context,
 * which is the session row the effects act on.
 *
 * Order is significant. `persist_*` effects are guarded writes: if the row
 * moved on under the transition, the write refuses and the interpreter stops,
 * so no external effect after it runs. The next reconcile pass retries.
 */
export type SessionEffect =
  | { type: "register_relay" }
  | { type: "purge_relay" }
  | { type: "ensure_workspace_pvc" }
  | { type: "start_pod"; warm: boolean }
  /** Ask the guest to shut down. The shell derives the reason text from `intent`. */
  | { type: "stop_guest"; intent: "terminate" | "suspend" }
  /**
   * terminate: short grace period, a failed delete is logged and cleanup
   * continues. suspend: wait until the pod is gone (resume reuses the name), a
   * failure aborts so the suspend is retried.
   */
  | { type: "delete_pod"; intent: "terminate" | "suspend" }
  | { type: "discard_checkpoint" }
  | { type: "delete_workspace_pvc" }
  | { type: "persist_ready" }
  | { type: "persist_suspending" }
  | { type: "persist_suspended" }
  | { type: "finalize"; final: FinalState };

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

/**
 * Effects of entering TERMINATING: stop the guest, drop the pod, the relay
 * entry, the checkpoint and the workspace.
 *
 * `transition()` returns exactly this list for `terminate_requested` and
 * `lease_expired` from every live state. Termination performs the cleanup after
 * the guarded write has already moved the row to TERMINATING, so the list is
 * exported and both callers read one definition rather than two that can drift.
 */
export function terminationEffects(snapshot: SessionSnapshot): SessionEffect[] {
  return [
    ...(snapshot.hasPod
      ? [
          { type: "stop_guest" as const, intent: "terminate" as const },
          { type: "delete_pod" as const, intent: "terminate" as const },
        ]
      : []),
    ...(snapshot.hasRelay ? [{ type: "purge_relay" as const }] : []),
    { type: "discard_checkpoint" },
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
        return Ok({ state: "TERMINATING", effects: terminationEffects(snapshot) });
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
        return Ok({ state: "TERMINATING", effects: terminationEffects(snapshot) });
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
        // The guarded write comes first: a lost race must not stop the guest.
        return Ok({
          state: "SUSPENDING",
          effects: [
            { type: "persist_suspending" },
            ...(snapshot.hasPod ? [{ type: "stop_guest" as const, intent: "suspend" as const }] : []),
          ],
        });
      }
      if (event.type === "lease_expired" || event.type === "terminate_requested") {
        return Ok({ state: "TERMINATING", effects: terminationEffects(snapshot) });
      }
      return fail(snapshot, event, "invalid_transition", "READY/ACTIVE accepts operations, suspend, or terminate");

    case "SUSPENDING":
      if (event.type === "suspend_retry") {
        // A crash between the state write and the goodbye leaves the guest
        // running. Ask again; the row does not move until the checkpoint is
        // committed, so the retry is a self-transition with one effect.
        return Ok({
          state: "SUSPENDING",
          effects: [{ type: "stop_guest", intent: "suspend" }],
        });
      }
      if (event.type === "guest_stopped") {
        // The pod teardown is a local repair that precedes the commit; the
        // guarded write then fences the relay purge behind it.
        return Ok({
          state: "SUSPENDED",
          effects: [
            ...(snapshot.hasPod ? [{ type: "delete_pod" as const, intent: "suspend" as const }] : []),
            { type: "persist_suspended" },
            ...(snapshot.hasRelay ? [{ type: "purge_relay" as const }] : []),
          ],
        });
      }
      if (event.type === "lease_expired" || event.type === "terminate_requested") {
        return Ok({ state: "TERMINATING", effects: terminationEffects(snapshot) });
      }
      return fail(
        snapshot,
        event,
        "invalid_transition",
        "SUSPENDING accepts guest_stopped, a retry, or terminate",
      );

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
        return Ok({ state: "TERMINATING", effects: terminationEffects(snapshot) });
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
        return Ok({ state: "TERMINATING", effects: terminationEffects(snapshot) });
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

/**
 * The immutable deadline written at READY: the purchased duration measured from
 * the moment the guest is ready, capped by the wall-clock lifetime.
 *
 * The cap exists because `readyAt` is a wall-clock reading. A forward step
 * between settlement and readiness would otherwise persist a deadline later
 * than `createdAt + maxLifetimeSeconds`, where the lease path disagrees with
 * `lifetimeExpired` and with the pod's `activeDeadlineSeconds`. Both are
 * wall-clock bounds on the same session, so they have to agree.
 *
 * A session with no `maxLifetimeSeconds` is capped at the protocol maximum,
 * which is above the largest purchasable duration and therefore never binds.
 */
export function leaseDeadline(
  createdAt: number,
  readyAt: number,
  durationSeconds: number,
  maxLifetimeSeconds: number | null,
): number {
  const purchased = readyAt + durationSeconds * 1000;
  const lifetime = createdAt + (maxLifetimeSeconds ?? MAX_SESSION_LIFETIME_SECONDS) * 1000;
  return Math.min(purchased, lifetime);
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
