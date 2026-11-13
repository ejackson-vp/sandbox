/**
 * The ledger audit: do the books agree with the payment intents?
 *
 * Pure: no SQL, no clock, no I/O. The adapter reads one read-only snapshot,
 * hands it here with `now`, and the sampler publishes the counts as gauges.
 *
 * Three code paths move money, and each is correct on its own: the settlement
 * transaction (`completeEntitlement`), the refund worker's claim protocol, and
 * settlement recovery. Nothing compared their results with each other, so a
 * settled intent with no ledger row, or a ledger row that claims service was
 * delivered for an intent that failed, stayed invisible until a human
 * reconciled a spreadsheet. This module is that comparison, as a total
 * function over one read-only snapshot.
 *
 * The rules are deliberately narrow. A divergence is something the three
 * writers themselves should have made impossible, not a style opinion:
 *
 *  - `settled_without_ledger`: the intent says the money settled, the ledger
 *    has no row for it. The settlement transaction writes both, so only a bug,
 *    a manual edit, or a missing ledger row produces this.
 *  - `intent_failed_ledger_settled`: the intent says the payment was refused,
 *    the ledger says the customer received service. The duplicate-charge path
 *    is not a false positive: it records `REFUNDED` or `REFUND_PENDING`, never
 *    `SETTLED`. `failIntent` refuses that pair in the same statement as the
 *    status change, so no request writes it; a sample means a row was changed
 *    outside the request path (an edit, a one-sided restore, or recovery that
 *    crashed before applying the refund policy).
 *  - `duplicate_refund_claim`: two ledger rows in `REFUND_SENDING` share one
 *    settlement nonce, so one signed authorisation is being refunded twice.
 *    `payment_key` cannot repeat (it is the primary key) and a nonce is what a
 *    provider keys a refund by, so the nonce is the identity that can collide.
 *
 * Staleness is the session half: a non-terminal row past the deadline it was
 * given. The deadline is the lease when READY was reached, otherwise the
 * wall-clock lifetime cap, which is the only bound a session that never got
 * ready has. A grace period keeps the reconciler's own latency out of the
 * signal; the policy already allows `leaseGraceMs` before it terminates.
 *
 * What this module cannot see lives in `docs/payment-ledger.md`: it reads this
 * database, not the chain or the provider, so a transfer made outside these
 * three paths is not auditable here.
 */
import { MAX_SESSION_LIFETIME_SECONDS, type SessionState } from "@x402s/shared/protocol";
import type { IntentStatus, LedgerStatus } from "./store/models.js";

/**
 * The closed set of divergence labels. Every member is a gauge sample on every
 * pass, including zero, so an alert on a reason does not depend on the reason
 * having ever fired.
 */
export const LEDGER_DIVERGENCE_REASONS = [
  "settled_without_ledger",
  "intent_failed_ledger_settled",
  "duplicate_refund_claim",
] as const;

export type LedgerDivergenceReason = (typeof LEDGER_DIVERGENCE_REASONS)[number];

/**
 * The phases the stale gauge can report: every non-terminal state a session row
 * can hold. `CREATED` is deliberately absent because the entitlement is written
 * straight into `PAID`, so no row is ever stored in it; the table test asserts
 * this list against `SESSION_STATES` minus the terminal and pre-row states.
 */
export const AUDIT_SESSION_PHASES = [
  "PAID",
  "PROVISIONING",
  "READY",
  "ACTIVE",
  "SUSPENDING",
  "SUSPENDED",
  "RESUMING",
  "TERMINATING",
] as const;

export type AuditSessionPhase = (typeof AUDIT_SESSION_PHASES)[number];

/** One intent and the ledger row with the same payment key, if any. */
export interface IntentLedgerSnapshot {
  paymentKey: string;
  intentStatus: IntentStatus;
  /** Null when no ledger row exists for this payment key. */
  ledgerStatus: LedgerStatus | null;
}

/** A ledger row the refund worker has claimed (`REFUND_SENDING`). */
export interface LiveRefundClaim {
  paymentKey: string;
  /** EIP-3009 nonce; the identity a provider dedupes a refund by. */
  settlementNonce: string | null;
}

/** The session fields the stale check needs, and nothing else. */
export interface SessionLifetimeSnapshot {
  sessionId: string;
  state: SessionState;
  createdAt: number;
  leaseExpiresAt: number | null;
  maxLifetimeSeconds: number | null;
}

/** Everything one audit pass reads. One snapshot, one `now`. */
export interface LedgerAuditSnapshot {
  intents: readonly IntentLedgerSnapshot[];
  liveRefunds: readonly LiveRefundClaim[];
  sessions: readonly SessionLifetimeSnapshot[];
}

export interface LedgerAuditLimits {
  /**
   * Slack added to a session deadline. Covers the reconciler's own decision
   * latency: a row is not stale while the pass that will terminate it is
   * allowed to be late.
   */
  sessionGraceMs: number;
}

/**
 * The grace period only. There is no row cap: the reads return exactly the rows
 * that can be findings, so a cap would report a floor on the one number the
 * gauge exists for. The cost of the pass is the scan, which a `LIMIT` never
 * bounded anyway, and the pass now runs on a timer instead of inside a scrape.
 */
export const DEFAULT_LEDGER_AUDIT_LIMITS: LedgerAuditLimits = {
  sessionGraceMs: 60_000,
};

export interface LedgerDivergence {
  paymentKey: string;
  reason: LedgerDivergenceReason;
}

export interface StaleSession {
  sessionId: string;
  phase: AuditSessionPhase;
  /** How far past the deadline the session is, before the grace was applied. */
  overdueMs: number;
}

export interface LedgerAuditResult {
  /** Per-payment divergences in snapshot order, then duplicate claims. */
  divergences: readonly LedgerDivergence[];
  staleSessions: readonly StaleSession[];
  /** One entry per reason, always present, zero when clean. */
  divergenceCounts: Readonly<Record<LedgerDivergenceReason, number>>;
  /** One entry per non-terminal phase, always present, zero when clean. */
  staleCounts: Readonly<Record<AuditSessionPhase, number>>;
}

/**
 * The deadline a non-terminal session was given.
 *
 * `leaseExpiresAt` is written once at READY and is the purchased duration
 * capped by the wall-clock lifetime. Before READY it is null, so the only
 * bound is `createdAt + maxLifetimeSeconds`, and a null cap means the protocol
 * maximum (which never binds before the largest purchasable duration).
 */
export function sessionDeadline(row: SessionLifetimeSnapshot): number {
  if (row.leaseExpiresAt !== null) return row.leaseExpiresAt;
  const lifetime = row.maxLifetimeSeconds ?? MAX_SESSION_LIFETIME_SECONDS;
  return row.createdAt + lifetime * 1000;
}

/** True when `state` is one of the phases the stale gauge reports. */
export function isAuditSessionPhase(state: SessionState): state is AuditSessionPhase {
  return (AUDIT_SESSION_PHASES as readonly SessionState[]).includes(state);
}

/** Decide the audit from one snapshot. Total: every input yields a result. */
export function auditLedger(
  snapshot: LedgerAuditSnapshot,
  limits: LedgerAuditLimits,
  now: number,
): LedgerAuditResult {
  const divergences: LedgerDivergence[] = [];
  for (const row of snapshot.intents) {
    const reason = divergenceReason(row);
    if (reason) divergences.push({ paymentKey: row.paymentKey, reason });
  }
  divergences.push(...duplicateRefundClaims(snapshot.liveRefunds));

  const staleSessions: StaleSession[] = [];
  for (const row of snapshot.sessions) {
    if (!isAuditSessionPhase(row.state)) continue;
    const deadline = sessionDeadline(row);
    if (now <= deadline + limits.sessionGraceMs) continue;
    staleSessions.push({
      sessionId: row.sessionId,
      phase: row.state,
      overdueMs: now - deadline,
    });
  }

  const divergenceCounts = zeroCounts(LEDGER_DIVERGENCE_REASONS);
  for (const finding of divergences) divergenceCounts[finding.reason] += 1;

  const staleCounts = zeroCounts(AUDIT_SESSION_PHASES);
  for (const session of staleSessions) staleCounts[session.phase] += 1;

  return { divergences, staleSessions, divergenceCounts, staleCounts };
}

/**
 * The intent/ledger rules, in one place. `claimed` intents are deliberately
 * silent: settlement recovery leaves an intent claimed after writing the ledger
 * for it (the money moved, no entitlement exists) and that is the documented
 * shape, not divergence.
 */
function divergenceReason(row: IntentLedgerSnapshot): LedgerDivergenceReason | null {
  if (row.intentStatus === "settled") {
    return row.ledgerStatus === null ? "settled_without_ledger" : null;
  }
  if (row.intentStatus === "failed") {
    return row.ledgerStatus === "SETTLED" ? "intent_failed_ledger_settled" : null;
  }
  return null;
}

/**
 * Group live claims by the identity a provider refunds against. A row with no
 * nonce falls back to its payment key, which is unique, so it can only be a
 * group of one: that is the intended silence, not a missed check.
 */
function duplicateRefundClaims(claims: readonly LiveRefundClaim[]): LedgerDivergence[] {
  const groups = new Map<string, LiveRefundClaim[]>();
  for (const claim of claims) {
    const identity = claim.settlementNonce ? `nonce:${claim.settlementNonce}` : `payment:${claim.paymentKey}`;
    const group = groups.get(identity);
    if (group) group.push(claim);
    else groups.set(identity, [claim]);
  }
  const found: LedgerDivergence[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const claim of group) {
      found.push({ paymentKey: claim.paymentKey, reason: "duplicate_refund_claim" });
    }
  }
  return found;
}

function zeroCounts<T extends string>(keys: readonly T[]): Record<T, number> {
  const counts = {} as Record<T, number>;
  for (const key of keys) counts[key] = 0;
  return counts;
}
