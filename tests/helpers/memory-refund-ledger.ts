/**
 * In-memory ledger for the refund-worker property tests.
 *
 * The four methods are the same conditional writes the Postgres adapter runs:
 * a claim only takes a row that is `REFUND_PENDING` past its backoff or
 * `REFUND_SENDING` past its lease, and the completion and release only match
 * `REFUND_SENDING` plus the fence token the row holds. The claim rule itself is
 * the shared `claimDecision`, not a second implementation, so a test that drives
 * the real `RefundWorker` cannot disagree with the protocol about due-ness.
 *
 * The provider honours the idempotency-key contract: the first send for a key
 * moves funds and records a transaction, and every later send for the same key
 * returns the original transaction. That is what lets a test assert "one
 * payment, one transfer" rather than "the fake was called twice".
 */
import {
  asClaimToken,
  claimDecision,
  claimLease,
  isHeldBy,
  refundRetryPolicy,
  type ClaimToken,
  type RetryPolicy,
} from "@x402s/shared/durable";
import fc from "fast-check";
import {
  RefundSendUnknownError,
  type RefundExecutor,
  type RefundRequest,
} from "../../controller/src/refund-worker.js";
import type {
  ClaimedRefund,
  PaymentLedgerRecord,
  RefundClaimRequest,
} from "../../controller/src/store/models.js";
import type { RefundWorkerStore } from "../../controller/src/store/ports.js";

export const KEY = "c".repeat(64);

/** A `REFUND_PENDING` row in the shape the ledger writes before the worker. */
export function pendingRow(key = KEY, now = 1_000_000): PaymentLedgerRecord {
  return {
    paymentKey: key,
    sessionId: `unsettled:${key}`,
    payer: null,
    amount: "50000",
    asset: "mock:usdc",
    network: "mock:local",
    mode: "testnet",
    status: "REFUND_PENDING",
    reason: "no_service_delivered",
    refundTransaction: null,
    settlementNonce: `0x${key}`,
    refundAttempts: 0,
    refundLastError: null,
    refundNextAttemptAt: null,
    refundClaimToken: null,
    refundClaimedAt: null,
    refundIdempotencyKey: null,
    createdAt: now,
    updatedAt: now,
  };
}

export interface Release {
  paymentKey: string;
  attemptsBefore: number;
  nextAttemptAt: number;
  nowMs: number;
}

export class MemoryLedger implements RefundWorkerStore {
  readonly rows = new Map<string, PaymentLedgerRecord>();
  readonly completions: Array<{ paymentKey: string; token: string; transaction: string }> = [];
  readonly releases: Release[] = [];
  readonly transfers = new Map<string, string>();
  /** The clock the current pass runs with, so a release can be checked against it. */
  nowMs = 0;

  constructor(...rows: PaymentLedgerRecord[]) {
    for (const row of rows) this.rows.set(row.paymentKey, row);
  }

  row(key = KEY): PaymentLedgerRecord {
    const row = this.rows.get(key);
    if (!row) throw new Error(`no row ${key}`);
    return row;
  }

  async countLedgerByStatus(status: PaymentLedgerRecord["status"]): Promise<number> {
    return [...this.rows.values()].filter((row) => row.status === status).length;
  }

  async claimRefunds(request: RefundClaimRequest): Promise<ClaimedRefund[]> {
    this.nowMs = request.nowMs;
    const leaseMs = request.nowMs - request.leaseCutoffMs;
    const due: ClaimedRefund[] = [];
    for (const row of [...this.rows.values()].sort((a, b) => a.updatedAt - b.updatedAt)) {
      if (due.length >= request.limit) break;
      // The query's first condition: a REFUNDED row is terminal and is never
      // selected, whatever its attempt count says.
      if (row.status !== "REFUND_PENDING" && row.status !== "REFUND_SENDING") continue;
      const sending = row.status === "REFUND_SENDING";
      // A SENDING row with no recorded start is due, not stuck: the SQL says
      // `claimed_at IS NULL OR claimed_at <= cutoff`, and `claimedAt = 0`
      // reproduces the first half without a second rule.
      const lease = sending
        ? claimLease(
            asClaimToken(row.refundClaimToken ?? "missing-token"),
            row.refundClaimedAt ?? 0,
            leaseMs,
          )
        : null;
      const decision = claimDecision(
        { attempts: row.refundAttempts, nextAttemptAtMs: row.refundNextAttemptAt, lease },
        request.nowMs,
        { maxAttempts: request.maxAttempts },
      );
      if (decision !== "claim" && decision !== "reclaim") continue;

      const reclaimed = sending;
      row.status = "REFUND_SENDING";
      row.refundClaimToken = request.claimToken;
      row.refundClaimedAt = request.nowMs;
      row.refundIdempotencyKey ??= `refund:${row.paymentKey}`;
      row.updatedAt = request.nowMs;
      due.push({ ledger: { ...row }, reclaimed });
    }
    return due;
  }

  async completeRefundClaim(
    paymentKey: string,
    claimToken: ClaimToken,
    transaction: string,
  ): Promise<boolean> {
    const row = this.rows.get(paymentKey);
    if (!row || row.status !== "REFUND_SENDING") return false;
    if (!isHeldBy(row.refundClaimToken, claimToken)) return false;
    row.status = "REFUNDED";
    row.refundTransaction = transaction;
    row.refundClaimToken = null;
    row.refundClaimedAt = null;
    row.updatedAt = this.nowMs;
    this.completions.push({ paymentKey, token: claimToken, transaction });
    return true;
  }

  async releaseRefundClaim(
    paymentKey: string,
    claimToken: ClaimToken,
    error: string,
    nextAttemptAt: number,
  ): Promise<boolean> {
    const row = this.rows.get(paymentKey);
    if (!row || row.status !== "REFUND_SENDING") return false;
    if (!isHeldBy(row.refundClaimToken, claimToken)) return false;
    this.releases.push({
      paymentKey,
      attemptsBefore: row.refundAttempts,
      nextAttemptAt,
      nowMs: this.nowMs,
    });
    row.status = "REFUND_PENDING";
    row.refundAttempts += 1;
    row.refundLastError = error;
    row.refundNextAttemptAt = nextAttemptAt;
    row.refundClaimToken = null;
    row.refundClaimedAt = null;
    row.updatedAt = this.nowMs;
    return true;
  }
}

export type Verdict = "ok" | "refuse" | "unknown";

/**
 * A provider whose answer is supplied per call, so a property can interleave
 * outcomes on one payment.
 */
export function provider(
  ledger: MemoryLedger,
  verdict: (request: RefundRequest, call: number) => Verdict,
): RefundExecutor & { calls: RefundRequest[] } {
  const calls: RefundRequest[] = [];
  return {
    calls,
    async refund(request: RefundRequest) {
      calls.push(request);
      const answer = verdict(request, calls.length);
      if (answer === "refuse") throw new Error("provider refused");
      if (answer === "unknown") throw new RefundSendUnknownError("refund webhook timed out");
      const existing = ledger.transfers.get(request.idempotencyKey);
      const transaction = existing ?? `0xtx-${ledger.transfers.size + 1}`;
      ledger.transfers.set(request.idempotencyKey, transaction);
      return { transaction };
    },
  };
}

/** A policy shape a property can generate, with the lease below the call timeout. */
export const POLICY_SHAPE = fc.record({
  maxAttempts: fc.integer({ min: 1, max: 4 }),
  baseDelayMs: fc.integer({ min: 1, max: 1_000 }),
  maxDelayMs: fc.integer({ min: 1_000, max: 20_000 }),
  leaseMs: fc.integer({ min: 1, max: 1_000 }),
});

export function policyOf(shape: {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  leaseMs: number;
}): RetryPolicy {
  return refundRetryPolicy({
    maxAttempts: shape.maxAttempts,
    baseDelayMs: shape.baseDelayMs,
    maxDelayMs: Math.max(shape.maxDelayMs, shape.baseDelayMs),
    leaseMs: shape.leaseMs,
    callTimeoutMs: 1,
  });
}
