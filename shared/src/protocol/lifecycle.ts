/**
 * Session lifecycle vocabulary: states, guards, tiers and resource limits.
 */
import type { RuntimeName } from "../runtimes.js";

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

/** Every state, for exhaustive checks. */
export const SESSION_STATES: readonly SessionState[] = [
  "CREATED",
  "PAID",
  "PROVISIONING",
  "READY",
  "ACTIVE",
  "SUSPENDING",
  "SUSPENDED",
  "RESUMING",
  "TERMINATING",
  "EXPIRED",
  "FAILED",
  "DESTROYED",
];

/**
 * States with no way forward: the row is finished and only cleanup remains.
 *
 * This is the one definition. Everything else that needs the set derives it:
 * `TERMINAL_STATES` below, `NON_TERMINAL_STATES`, `TerminalState`, the SQL `IN`
 * bodies, the checkpoint-retention decision, the capacity reaper, the refund
 * policy and the pod sweep. A copy of this list in another module is how a state
 * gets added here and forgotten there, which for a retention decision means a
 * plaintext volume with no owner that nothing will ever delete.
 *
 * `as const` keeps the literal union, so `TerminalState` is derived rather than
 * retyped and `finalStateForReason` cannot return a state that is not in it.
 */
const TERMINAL_STATE_NAMES = [
  "EXPIRED",
  "FAILED",
  "DESTROYED",
] as const satisfies readonly SessionState[];

/** A terminal state, as a type. */
export type TerminalState = (typeof TERMINAL_STATE_NAMES)[number];

/**
 * The same list, widened to `SessionState`.
 *
 * Widened on purpose: `TERMINAL_STATE_NAMES.includes(state)` only accepts the
 * three literals, so every caller holding a `SessionState` would need a cast or
 * `isTerminal`. The type predicate below is the narrowing tool.
 */
export const TERMINAL_STATES: readonly SessionState[] = TERMINAL_STATE_NAMES;

const TERMINAL_STATE_SET: ReadonlySet<SessionState> = new Set(TERMINAL_STATE_NAMES);

/**
 * True when the state is finished. A type predicate, so a caller that branches
 * on it keeps the narrowed state instead of casting back to `SessionState`.
 */
export function isTerminal(state: SessionState): state is TerminalState {
  return TERMINAL_STATE_SET.has(state);
}

/**
 * The complement, derived rather than listed.
 *
 * A hand-maintained complement is a list that silently omits a state, and the
 * due query, the `sessions_due` partial index and every live-session count are
 * built from it: a state left out is a row nothing ever reconciles again.
 */
export const NON_TERMINAL_STATES: readonly SessionState[] = SESSION_STATES.filter(
  (state) => !isTerminal(state),
);

/**
 * A state list as a SQL `IN` body: `'EXPIRED','FAILED','DESTROYED'`.
 *
 * The quoting is fine because the values come from the closed union above; a
 * state can only reach this by being written into `SESSION_STATES`.
 */
export function stateListSql(states: readonly SessionState[]): string {
  return states.map((state) => `'${state}'`).join(",");
}

/** `TERMINAL_STATES` as a SQL `IN` body, for the queries that filter on it. */
export const TERMINAL_STATE_SQL = stateListSql(TERMINAL_STATES);

/** `NON_TERMINAL_STATES` as a SQL `IN` body; also the `sessions_due` predicate. */
export const NON_TERMINAL_STATE_SQL = stateListSql(NON_TERMINAL_STATES);

/** Hard upper bound on any lease, regardless of configuration. */
export const MAX_LEASE_SECONDS = 3600;
/** Hard upper bound on a session's wall-clock lifetime, including suspended time. */
export const MAX_SESSION_LIFETIME_SECONDS = 28800;
/** Development floor for tests. */
export const MIN_LEASE_SECONDS = 1;

export type SessionTier = "short" | "standard" | "extended" | "long" | "custom";

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
  /** Guest runtime profile; `base` when the request omitted it. */
  runtime: RuntimeName;
  /** Steady-state reservation; `limits` is the burst ceiling. */
  baseline?: SessionBaseline;
  /** Present when the session is suspendable. */
  idlePolicy?: IdlePolicy;
  /** Wall-clock cap, including suspended time. */
  maxLifetimeSeconds?: number;
  /**
   * The client key this payment is bound to. Part of the spec hash, so a
   * receipt cannot be replayed with a different client key.
   */
  clientCommitment?: { publicKey: string; nonce: string };
}
