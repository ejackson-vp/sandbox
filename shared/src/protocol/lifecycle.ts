/**
 * Session lifecycle vocabulary: states, guards, tiers and resource limits.
 */

export type SessionState =
  | "CREATED"
  | "PAID"
  | "PROVISIONING"
  | "READY"
  | "ACTIVE"
  | "SUSPENDING"
  | "SUSPENDED"
  | "RESUMING"
  | "TERMINATING"
  | "EXPIRED"
  | "FAILED"
  | "DESTROYED";

export const TERMINAL_STATES: readonly SessionState[] = ["EXPIRED", "FAILED", "DESTROYED"];

/** States in which a session may accept operations (subject to the lease). */
export const USABLE_STATES: readonly SessionState[] = ["READY", "ACTIVE"];

export function isTerminal(state: SessionState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function isUsable(state: SessionState): boolean {
  return USABLE_STATES.includes(state);
}

/** Hard upper bound on any lease, regardless of configuration. */
export const MAX_LEASE_SECONDS = 3600;
/** Hard upper bound on a session's wall-clock lifetime, including suspended time. */
export const MAX_SESSION_LIFETIME_SECONDS = 28800;
/** Development floor for tests. */
export const MIN_LEASE_SECONDS = 1;

export type SessionTier = "short" | "standard" | "extended" | "long" | "custom";

export const TIER_DURATIONS: Record<Exclude<SessionTier, "custom">, number> = {
  short: 60,
  standard: 300,
  extended: 900,
  long: 1800,
};

export interface SessionLimits {
  cpuMillis: number;
  memoryMiB: number;
  diskMiB: number;
  /** Cap per stream (stdout or stderr) per command. */
  maxOutputBytes: number;
  /** Cap for a single uploaded file or archive. */
  maxFileBytes: number;
  /** Cap per command, independent of the lease. */
  maxCommandSeconds: number;
  /** Max number of processes the guest will allow the workload to spawn. */
  maxProcesses: number;
}

/**
 * Suspended-session policy. Present only when the customer wants a checkpointed
 * workspace instead of a short-lived lease.
 */
export interface IdlePolicy {
  /** Suspend after this many seconds without an operation. */
  maxIdleSeconds?: number;
  /** Terminate after this many seconds in the suspended state. */
  suspendedDurationSeconds?: number;
  /** Hint to clients that they may resume automatically on the next request. */
  autoResume?: boolean;
}

export interface SessionBaseline {
  /** Scheduler reservation (steady-state). */
  cpuMillis: number;
  memoryMiB: number;
}

export interface SessionSpec {
  tier: SessionTier;
  durationSeconds: number;
  limits: SessionLimits;
  /** Steady-state reservation; `limits` is the burst ceiling. */
  baseline?: SessionBaseline;
  /** Present when the session is suspendable. */
  idlePolicy?: IdlePolicy;
  /** Wall-clock cap, including suspended time. */
  maxLifetimeSeconds?: number;
}
