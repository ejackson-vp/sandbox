/**
 * The claim lease: who owns an in-flight external call, and for how long
 * (ADR 0011).
 *
 * A claim is the durable statement "one process is talking to the provider for
 * this payment right now". It is two things that must travel together:
 *
 *  - a **fence token**, matched on completion so a stalled owner that was
 *    reclaimed cannot record its result;
 *  - a **lease**, so a process that dies leaves work that is due again rather
 *    than work that is stuck.
 *
 * The token and the lease are the same protocol in both consumers, but they are
 * persisted differently on purpose:
 *
 *  - the refund ledger stores `refund_claimed_at` plus a lease duration the
 *    worker owns, so the query compares against a cutoff (`leaseCutoffMs`);
 *  - the payment intent stores an absolute `claim_expires_at`, because the API
 *    that claims it computes the deadline once and the controller only reads it
 *    (`deadlinePassed`).
 *
 * Both encodings are exported here so neither adapter invents its own notion of
 * "expired". Nothing in this module reads a clock or a database.
 */

/** A fence value. Opaque to the database; only equality matters. */
export type ClaimToken = string & { readonly __claimToken: unique symbol };

const TOKEN_PATTERN = /^[\x21-\x7e]{8,128}$/;

/**
 * Brand a fence. Deliberately lenient about shape (the column is text and older
 * rows may not look like today's hex) but strict about transport safety: a
 * token with whitespace or a control character cannot be compared or logged
 * reliably.
 */
export function asClaimToken(raw: string): ClaimToken {
  if (!TOKEN_PATTERN.test(raw)) {
    throw new TypeError(`claim token is not a printable opaque fence: ${JSON.stringify(raw)}`);
  }
  return raw as ClaimToken;
}

/** Ownership of one piece of work, from `claimedAtMs` for `leaseMs`. */
export interface ClaimLease {
  readonly token: ClaimToken;
  readonly claimedAtMs: number;
  readonly leaseMs: number;
}

export function claimLease(token: ClaimToken, claimedAtMs: number, leaseMs: number): ClaimLease {
  if (!Number.isSafeInteger(claimedAtMs) || claimedAtMs < 0) {
    throw new TypeError(`claim start must be epoch milliseconds, got ${claimedAtMs}`);
  }
  // A lease of zero or less is not a bug: it means "already expired", which is
  // how a caller asks for the stale-claim path without waiting. The retry policy
  // is where a meaningful lease duration is enforced.
  if (!Number.isSafeInteger(leaseMs)) {
    throw new TypeError(`claim lease must be a whole number of milliseconds, got ${leaseMs}`);
  }
  return { token, claimedAtMs, leaseMs };
}

/** When the lease stops fencing, as an absolute epoch millisecond value. */
export function leaseExpiresAt(lease: ClaimLease): number {
  return lease.claimedAtMs + lease.leaseMs;
}

/** True at and past the deadline. Half-open: the instant of expiry is expired. */
export function isExpired(lease: ClaimLease, nowMs: number): boolean {
  return nowMs >= leaseExpiresAt(lease);
}

/**
 * Whether a recorded absolute deadline has passed. This is the encoding the
 * payment intent uses. A null deadline means no live lease was ever recorded,
 * so it is due rather than stuck.
 */
export function deadlinePassed(expiresAtMs: number | null, nowMs: number): boolean {
  return expiresAtMs === null || nowMs >= expiresAtMs;
}

/**
 * The cutoff a claim query compares `claimed_at` against. The store only does
 * `claimed_at <= cutoff`, so the arithmetic has one home.
 */
export function leaseCutoffMs(nowMs: number, leaseMs: number): number {
  return nowMs - leaseMs;
}

/**
 * Whether an existing lease may be taken over. `null` covers both "nobody owns
 * this" and "the row is marked as owned but no start was recorded", which the
 * refund claim query treats as due so a lost timestamp cannot wedge a row.
 */
export function reclaimable(lease: ClaimLease | null, nowMs: number): boolean {
  return lease === null || isExpired(lease, nowMs);
}

/**
 * Take a fresh lease over a row that is due. The key is not part of the lease:
 * a reclaim changes the owner and the deadline, never the operation's name.
 */
export function reclaim(
  previous: ClaimLease | null,
  token: ClaimToken,
  nowMs: number,
  leaseMs: number,
): ClaimLease {
  if (!reclaimable(previous, nowMs)) {
    throw new Error("cannot reclaim a live lease");
  }
  return claimLease(token, nowMs, leaseMs);
}

/**
 * The fence check. Only the owner that still holds the token may record a
 * result, so a stale claim cannot complete. Kept string-typed because one
 * caller compares a client-presented token, which must not throw on garbage.
 */
export function isHeldBy(held: string | null, presented: string): boolean {
  return held !== null && held !== "" && held === presented;
}

/** Everything the claim query needs to know about one row. */
export interface ClaimState {
  /** Definitive refusals so far. Unknown outcomes never count. */
  readonly attempts: number;
  /** When a refused attempt is due again, or null when it never failed. */
  readonly nextAttemptAtMs: number | null;
  /** The current owner, or null when the row is unowned. */
  readonly lease: ClaimLease | null;
}

export interface ClaimPolicy {
  /** Work at this many definitive refusals is never claimed again. */
  readonly maxAttempts: number;
}

export type ClaimDecision = "claim" | "reclaim" | "not_due" | "exhausted";

/**
 * The pure form of the refund claim query. The adapter expresses the same rule
 * in SQL; this is the version the state-machine tests drive, and the version a
 * reader can check without a database.
 */
export function claimDecision(state: ClaimState, nowMs: number, policy: ClaimPolicy): ClaimDecision {
  if (state.attempts >= policy.maxAttempts) return "exhausted";
  if (state.lease !== null) {
    return isExpired(state.lease, nowMs) ? "reclaim" : "not_due";
  }
  if (state.nextAttemptAtMs !== null && nowMs < state.nextAttemptAtMs) return "not_due";
  return "claim";
}
