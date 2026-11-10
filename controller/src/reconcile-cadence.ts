/**
 * Per-state re-due cadence for the reconcile scheduler.
 *
 * Policy, not SQL: `next_due_ms` is a storage column, but how long each state
 * may wait before its next pass is a product decision that belongs in one
 * readable table. The store's state-changing statements arm the due time from
 * here, and the reconciler re-arms an unchanged session from the same table,
 * so a state can never be scheduled by two different constants.
 *
 * The pass itself is bounded by `RECONCILE_BUDGET` (see config.ts); cadence
 * decides *when* a row becomes eligible, the budget decides *how many* rows
 * one pass may dispatch.
 */
import type { SessionState } from "./store/models.js";

/**
 * Fallback for a state missing from the table (including terminal states,
 * whose due time is never read again because `listDue` excludes them).
 * Keeping it equal to the tick interval means "behave like the old sweep".
 */
export const DEFAULT_REDUE_INTERVAL_MS = 250;

/**
 * How long a session may stay in a state before the next reconcile pass.
 *
 * Reasoning, per state:
 *
 *  - PAID: a paid customer is waiting for a pod; the provisioning cap already
 *    bounds concurrent work, so poll at the tick rate.
 *  - PROVISIONING / RESUMING: the guest hello is the latency-critical step,
 *    so poll sub-second. This is the dominant ready-path cost.
 *  - READY / ACTIVE: nothing the reconciler does here is user-visible except
 *    lease expiry and idle detection. The controller clock still owns the
 *    deadline (`enforceLease` compares against it), so this cadence only
 *    bounds *detection* latency: a lease that expires just after a pass is
 *    noticed at most ~1 s later, and pod deletion remains the backstop.
 *  - SUSPENDING: checkpoint completion usually happens inside the suspend
 *    call itself; the pass only repairs a crash between the two writes, so a
 *    medium cadence is enough.
 *  - SUSPENDED: a suspended session has no pod and no lease. Only an event
 *    (resume or destroy) needs attention, and those paths arm the row
 *    immediately (`requestDestroy`) or transition it inline. 15 s bounds a
 *    lost wake without polling storage pointlessly.
 *  - TERMINATING: cleanup latency is customer-visible (the destroy call is
 *    waiting), so poll at the tick rate.
 */
const REDUE_INTERVAL_MS: Partial<Record<SessionState, number>> = {
  PAID: 250,
  PROVISIONING: 250,
  READY: 1_000,
  ACTIVE: 1_000,
  SUSPENDING: 500,
  SUSPENDED: 15_000,
  RESUMING: 250,
  TERMINATING: 250,
};

/** Re-due interval for the state a session is in (or is entering). */
export function cadenceFor(state: SessionState): number {
  return REDUE_INTERVAL_MS[state] ?? DEFAULT_REDUE_INTERVAL_MS;
}