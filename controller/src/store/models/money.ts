/**
 * Money rows: what was paid, what the ledger says, and what a refund claims.
 *
 * Declaration order follows the flow: the payment, the intent that records a
 * settlement attempt, the ledger row that outlives both, and the refund claim
 * that fences a real transfer.
 */
import type { ClaimToken } from "@x402s/shared/durable";
import type { PaymentMode } from "@x402s/shared/protocol";

/** How an entitlement was paid for. `allowlist` rows are always `amount = "0"`. */
type PaymentSource = "x402" | "allowlist";

export interface PaymentRecord {
  paymentKey: string;
  network: string;
  scheme: string;
  asset: string;
  amount: string;
  payTo: string;
  payer?: string;
  transaction?: string;
  mode: PaymentMode;
  /** EIP-3009 authorisation nonce, when the payload carried one. */
  settlementNonce?: string | null;
  /** Defaults to `x402` on rows written before schema v19. */
  source?: PaymentSource;
  /**
   * Operator label of the allowlist entry that granted a free session. Recorded
   * in the ledger's `reason`, so a $0 row explains itself.
   */
  label?: string;
  /**
   * Budget row this payment charges. Allowlisted payers use `allow:<address>`
   * so a free session can never consume a paying payer's window.
   */
  budgetKey?: string;
}

export type IntentStatus = "claimed" | "settled" | "failed";

export type LedgerStatus = "SETTLED" | "REFUND_PENDING" | "REFUND_SENDING" | "REFUNDED";

/**
 * A refund the worker has claimed and not yet resolved (#31). `reclaimed` is
 * true when the row was already `REFUND_SENDING`: its previous owner's lease
 * expired, so this owner found it on the stale-lease path. The worker counts it
 * separately, and the resend reuses the stored idempotency key.
 */
export interface ClaimedRefund {
  ledger: PaymentLedgerRecord;
  reclaimed: boolean;
}

/** What a refund claim pass asks the store for. */
export interface RefundClaimRequest {
  nowMs: number;
  /**
   * A `REFUND_SENDING` row claimed at or before this instant has an expired
   * lease and is due again. The caller computes it with
   * `@x402s/shared/durable:leaseCutoffMs`, so the lease policy lives with the
   * worker and the store only compares timestamps.
   */
  leaseCutoffMs: number;
  limit: number;
  /** Rows at or above this many attempts are never claimed again. */
  maxAttempts: number;
  /** Fence written onto every row this pass claims (ADR 0011). */
  claimToken: ClaimToken;
}

export interface PaymentLedgerRecord {
  paymentKey: string;
  sessionId: string;
  payer: string | null;
  amount: string;
  asset: string;
  network: string;
  mode: PaymentMode;
  /** `x402` for a paid row; `allowlist` for a $0 entitlement (ADR 0013). */
  source: PaymentSource;
  status: LedgerStatus;
  reason: string | null;
  refundTransaction: string | null;
  /** EIP-3009 authorisation nonce; lets a refund be keyed by it (#31). */
  settlementNonce: string | null;
  /** Refund worker retry state. */
  refundAttempts: number;
  refundLastError: string | null;
  refundNextAttemptAt: number | null;
  /** Fence held by the worker while the row is `REFUND_SENDING`. */
  refundClaimToken: string | null;
  /** When the current `REFUND_SENDING` lease was taken, in epoch ms. */
  refundClaimedAt: number | null;
  /**
   * Stable provider idempotency key, `refund:<paymentKey>`. Set when the row is
   * first claimed and never rewritten, so every retry presents the same key.
   */
  refundIdempotencyKey: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A ledger row written for a settled payment that no session consumed (#31):
 * unentitled or a duplicate charge. Shared by the refund and settlement-recovery
 * ports, so the shape lives with the record it inserts rather than with an
 * adapter.
 */
export interface UnclaimedLedgerEntry {
  paymentKey: string;
  sessionId: string;
  payer: string | null;
  amount: string;
  asset: string;
  network: string;
  mode: PaymentMode;
  status: LedgerStatus;
  reason: string;
  /** Set when the row is written already refunded (a mock refund). */
  refundTransaction?: string | null;
  settlementNonce: string | null;
}
export interface PaymentIntentRecord {
  paymentKey: string;
  status: IntentStatus;
  sessionId: string | null;
  specHash: string;
  reason: string | null;
  /** Owner of the current claim; null once settled or failed. */
  claimToken: string | null;
  /** Lease deadline for the current claim, in epoch ms. */
  claimExpiresAt: number | null;
  /**
   * Payment requirements recorded at claim time (`PaymentRequirements` JSON).
   * Settlement recovery needs them to describe a payment the API no longer has.
   */
  requirementsJson: string | null;
  /**
   * EIP-3009 authorising address, proven by the client commitment before the
   * claim. Recovery uses it in the transfer proof for the recorded nonce, so a
   * settle-then-crash is resolvable without the API's request (F-19). Null on
   * rows claimed before schema v20.
   */
  authorizer: string | null;
  /** The EIP-3009 nonce to ask the chain about. Null on pre-v20 rows. */
  settlementNonce: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * What a claim records about the payment, beyond its key and spec.
 *
 * All three are optional so an older API keeps working: a claim without them
 * stores NULL, recovery falls back to the facilitator lookup, and the columns
 * are backfilled the next time the same intent is reclaimed.
 */
export interface IntentAttribution {
  requirementsJson?: string | null;
  /** The proven `authorization.from`. */
  authorizer?: string | null;
  /** The EIP-3009 nonce from the same authorization. */
  settlementNonce?: string | null;
}

export class PaymentAlreadyRedeemedError extends Error {
  constructor(paymentKey: string) {
    super(`payment ${paymentKey.slice(0, 12)}… has already been redeemed`);
    this.name = "PaymentAlreadyRedeemedError";
  }
}

/**
 * A second payment settled for a client key pair that already owns a session.
 * The new payment is refunded rather than creating a second session (#31).
 */
export class DuplicateEntitlementError extends Error {
  constructor(
    readonly paymentKey: string,
    readonly existingSessionId: string,
  ) {
    super(`client key pair already owns session ${existingSessionId}`);
    this.name = "DuplicateEntitlementError";
  }
}

/** The caller's claim token is no longer the intent owner (stale or mismatched). */
export class PaymentClaimLostError extends Error {
  constructor(paymentKey: string) {
    super(`claim on payment ${paymentKey.slice(0, 12)}… is no longer held by this owner`);
    this.name = "PaymentClaimLostError";
  }
}

/**
 * A fail request for a payment whose ledger row is already `SETTLED`.
 *
 * The intent may not become `failed` while the books say the customer was
 * served: that pair is the `intent_failed_ledger_settled` divergence, and it has
 * to stay reachable only by editing rows outside the service. The operator
 * reverses the settlement (refund) instead of retrying the fail.
 */
export class LedgerSettledError extends Error {
  constructor(paymentKey: string) {
    super(
      `payment ${paymentKey.slice(0, 12)}… has a SETTLED ledger row; ` +
        `reverse the settlement instead of failing the intent`,
    );
    this.name = "LedgerSettledError";
  }
}
export type IntentClaimResult =
  | { status: "claimed"; recovered: boolean; token: string; expiresAt: number }
  | { status: "settled"; sessionId: string }
  | { status: "in_progress" }
  | { status: "failed"; reason: string | null }
  | { status: "mismatch" };

export function mapIntent(r: Record<string, unknown>): PaymentIntentRecord {
  return {
    paymentKey: r.payment_key as string,
    status: r.status as IntentStatus,
    sessionId: (r.session_id as string | null) ?? null,
    specHash: (r.spec_hash as string) ?? "",
    reason: (r.reason as string | null) ?? null,
    claimToken: (r.claim_token as string | null) ?? null,
    claimExpiresAt: (r.claim_expires_at as number | null) ?? null,
    requirementsJson: (r.requirements_json as string | null) ?? null,
    authorizer: (r.authorizer as string | null) ?? null,
    settlementNonce: (r.settlement_nonce as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

export function mapLedger(r: Record<string, unknown>): PaymentLedgerRecord {
  return {
    paymentKey: r.payment_key as string,
    sessionId: r.session_id as string,
    payer: (r.payer as string | null) ?? null,
    amount: r.amount as string,
    asset: r.asset as string,
    network: r.network as string,
    mode: r.mode as PaymentMode,
    source: ((r.source as PaymentSource | undefined) ?? "x402") as PaymentSource,
    status: r.status as LedgerStatus,
    reason: (r.reason as string | null) ?? null,
    refundTransaction: (r.refund_tx as string | null) ?? null,
    settlementNonce: (r.settlement_nonce as string | null) ?? null,
    refundAttempts: (r.refund_attempts as number | null) ?? 0,
    refundLastError: (r.refund_last_error as string | null) ?? null,
    refundNextAttemptAt: (r.refund_next_attempt_at as number | null) ?? null,
    refundClaimToken: (r.refund_claim_token as string | null) ?? null,
    refundClaimedAt: (r.refund_claimed_at as number | null) ?? null,
    refundIdempotencyKey: (r.refund_idempotency_key as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}