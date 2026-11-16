/**
 * Refund execution for real payment modes (#31).
 *
 * `RefundService` decides *whether* a payment is refundable and, in mock mode,
 * applies it. A real mode leaves `REFUND_PENDING`, and the worker below resolves
 * it against an operator-configured webhook.
 *
 * The protocol is the shared durable-call contract, not a refund-only idea
 * (ADR 0011, `@x402s/shared/durable`):
 *
 *  - **Claim before sending.** A pass claims due rows in one statement
 *    (`REFUND_PENDING` past its backoff, or `REFUND_SENDING` past its lease) and
 *    fences them with a token. Two workers get disjoint rows; a crash leaves the
 *    row `REFUND_SENDING` and the next pass reclaims it after the lease. The
 *    lease arithmetic and the claim rule live in `shared/src/durable/claim.ts`;
 *    the SQL only compares the cutoff it is given.
 *  - **Stable idempotency key.** Every send carries `refundKey(paymentKey)`,
 *    both as an `Idempotency-Key` header and in the body. The provider contract
 *    is that the same key returns the original transaction and moves no funds
 *    again, which is what makes a resend after an ambiguous timeout safe.
 *  - **Fenced completion.** `SENDING -> REFUNDED` requires the current token, so
 *    a stalled owner that was reclaimed cannot record its transaction. The
 *    local short-circuit is `isHeldBy`; the real check is the SQL guard.
 *  - **Unknown is not failure.** A timeout, 5xx or unreadable answer is
 *    `unknown` (`shared/src/durable/outcome.ts`), records no attempt, and is
 *    retried when the lease expires. Only a definite refusal consumes the
 *    attempt budget.
 *
 * Without provider dedupe the key is a request, not a proof; a provider that
 * ignores it breaks the guarantee, and a crash after the provider paid but
 * before `markRefunded` is exactly the window the key exists to close. See
 * docs/payment-ledger.md and docs/adr/0011-durable-external-calls.md.
 *
 * The worker only sends funds through the webhook: there is no on-chain signer
 * in this process, so a compromised controller cannot drain the treasury by
 * itself. With no webhook configured it does nothing: real-mode refunds stay
 * `REFUND_PENDING`, which is the honest default.
 */
import { randomBytes } from "node:crypto";
import { log, metrics } from "@x402s/shared/runtime";
import {
  asClaimToken,
  leaseCoversCallTimeout,
  leaseCutoffMs,
  refundKey,
  refundRetryPolicy,
  runClaimed,
  type ClaimToken,
  type RetryPolicy,
} from "@x402s/shared/durable";
import type { BackoffOptions } from "@x402s/shared/runtime";
import { sendRefund, type RefundExecutor, type RefundRequest } from "./refund-executor.js";
import type { PaymentLedgerRecord } from "./store/models/money.js";
import type { RefundWorkerStore } from "./store/ports.js";

/**
 * The executor port and its HTTP adapter live in `refund-executor.ts`; they are
 * re-exported here because a caller that runs the worker is the caller that needs
 * to supply an executor, and every existing importer names this module.
 */
export { HttpRefundExecutor, RefundSendUnknownError } from "./refund-executor.js";
export type { RefundExecutor, RefundRequest } from "./refund-executor.js";

interface RefundWorkerOptions {
  maxAttempts: number;
  retryBaseMs: number;
  /** Rows claimed per pass. */
  limit: number;
  /** Retry ceiling, so a persistent failure does not retry for a day. */
  retryMaxMs?: number;
  /**
   * How long one pass owns a claim. Must exceed the executor's own timeout: a
   * shorter lease would let a second pass resend while the first is still
   * waiting, which is safe (same key) but noisier.
   */
  claimLeaseMs?: number;
  /** Timeout the executor applies to one call; used to check the lease. */
  callTimeoutMs?: number;
  /**
   * Uniform source for the retry jitter. Defaults to `Math.random`, which is
   * what keeps a fleet of workers from retrying the same provider in one wave.
   * A test pins it so the schedule it asserts stays exact.
   */
  retryRandom?: () => number;
  now?: () => number;
}

interface RefundWorkerResult {
  /** Rows claimed this pass. */
  attempted: number;
  refunded: number;
  /** Provider refused outright; the attempt was counted and backed off. */
  failed: number;
  /** Outcome unknown; the row stays SENDING for the lease reclaim. */
  unknown: number;
  /** Rows that reached the attempt limit on this pass. */
  exhausted: number;
  /** Rows claimed from an expired lease, not from PENDING. */
  reclaimed: number;
  skipped: boolean;
}

export class RefundWorker {
  private readonly now: () => number;
  private readonly retry: RetryPolicy;
  private readonly backoff: BackoffOptions;
  private readonly limit: number;

  constructor(
    private readonly store: RefundWorkerStore,
    private readonly executor: RefundExecutor | null,
    opts: RefundWorkerOptions,
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.backoff = opts.retryRandom ? { random: opts.retryRandom } : {};
    this.limit = opts.limit;
    this.retry = refundRetryPolicy({
      maxAttempts: opts.maxAttempts,
      baseDelayMs: opts.retryBaseMs,
      ...(opts.retryMaxMs !== undefined ? { maxDelayMs: opts.retryMaxMs } : {}),
      ...(opts.claimLeaseMs !== undefined ? { leaseMs: opts.claimLeaseMs } : {}),
      ...(opts.callTimeoutMs !== undefined ? { callTimeoutMs: opts.callTimeoutMs } : {}),
    });
    if (!leaseCoversCallTimeout(this.retry)) {
      // Safe (the key makes a resend a no-op) but noisier than it needs to be.
      log.warn("payment_refund_lease_below_timeout", {
        claimLeaseMs: this.retry.leaseMs,
        callTimeoutMs: this.retry.callTimeoutMs,
      });
    }
  }

  /**
   * One pass. Safe to run on every housekeeping tick, from more than one process,
   * and immediately after a restart: an expired claim is due again and a
   * `REFUNDED` row is never selected.
   */
  async run(): Promise<RefundWorkerResult> {
    const now = this.now();
    // Both counts are the operator's view: PENDING is work waiting, SENDING is
    // work in flight or stuck (a row whose outcome is unknown stays there).
    metrics
      .gauge("sandbox_refunds_pending", "Ledger rows awaiting a real-mode refund")
      .set({}, await this.store.countLedgerByStatus("REFUND_PENDING"));
    metrics
      .gauge("sandbox_refunds_sending", "Ledger rows claimed or awaiting reconciliation")
      .set({}, await this.store.countLedgerByStatus("REFUND_SENDING"));
    if (!this.executor) {
      return { attempted: 0, refunded: 0, failed: 0, unknown: 0, exhausted: 0, reclaimed: 0, skipped: true };
    }
    const executor = this.executor;

    // One token fences this pass: 128 random bits, handed to `asClaimToken` so
    // the port cannot receive an arbitrary string by accident. It is matched
    // together with the payment key, so a batch sharing it is still a per-row
    // fence.
    const claimToken = asClaimToken(randomBytes(16).toString("hex"));
    const claims = await this.store.claimRefunds({
      nowMs: now,
      leaseCutoffMs: leaseCutoffMs(now, this.retry.leaseMs),
      limit: this.limit,
      maxAttempts: this.retry.maxAttempts,
      claimToken,
    });

    let refunded = 0;
    let failed = 0;
    let unknown = 0;
    let exhausted = 0;
    let reclaimed = 0;

    for (const { ledger, reclaimed: wasReclaimed } of claims) {
      const rowToken = ledger.refundClaimToken;
      if (!rowToken) {
        // The claim statement always writes one; reaching here means it changed.
        log.error("payment_refund_claim_without_token", {
          paymentKeyPrefix: ledger.paymentKey.slice(0, 12),
        });
        continue;
      }
      let token: ClaimToken;
      try {
        token = asClaimToken(rowToken);
      } catch (err) {
        // The claim statement always writes a valid fence, so this is a manual
        // or corrupt row. Skip it rather than abort every other refund.
        log.error("payment_refund_claim_token_invalid", {
          paymentKeyPrefix: ledger.paymentKey.slice(0, 12),
          error: (err as Error).message,
        });
        continue;
      }
      if (wasReclaimed) {
        reclaimed += 1;
        metrics
          .counter("sandbox_refund_worker_total", "Refund worker attempts by result")
          .inc({ result: "reclaimed" });
        log.warn("payment_refund_reclaimed", {
          paymentKeyPrefix: ledger.paymentKey.slice(0, 12),
          attempts: ledger.refundAttempts,
        });
      }

      const result = await runClaimed({
        policy: this.retry,
        attemptsSoFar: ledger.refundAttempts,
        nowMs: now,
        backoff: this.backoff,
        call: () => sendRefund(executor, requestOf(ledger)),
        complete: (value) => this.store.completeRefundClaim(ledger.paymentKey, token, value.transaction),
        fail: (failure, retry) =>
          this.store.releaseRefundClaim(ledger.paymentKey, token, failure.reason, retry.nextAttemptAtMs),
      });

      switch (result.kind) {
        case "completed":
          refunded += 1;
          metrics
            .counter("sandbox_refunds_total", "Payment refund outcomes")
            .inc({ mode: ledger.mode, result: "refunded" });
          metrics
            .counter("sandbox_refund_worker_total", "Refund worker attempts by result")
            .inc({ result: "refunded" });
          log.info("payment_refunded", {
            paymentKeyPrefix: ledger.paymentKey.slice(0, 12),
            amount: ledger.amount,
            transaction: result.value.transaction,
          });
          break;

        case "unknown":
          // No release: the row stays SENDING, and the lease makes it due again.
          // Retrying with the same key is what the provider dedupes.
          unknown += 1;
          metrics
            .counter("sandbox_refund_worker_total", "Refund worker attempts by result")
            .inc({ result: "unknown" });
          log.warn("payment_refund_outcome_unknown", {
            paymentKeyPrefix: ledger.paymentKey.slice(0, 12),
            error: result.failure.reason,
          });
          break;

        case "record_failed":
          // The send happened but recording it did not. Leaving the row SENDING
          // is correct: the reclaim resends with the same key and the provider
          // answers with the original transaction.
          unknown += 1;
          metrics
            .counter("sandbox_refund_worker_total", "Refund worker attempts by result")
            .inc({ result: "unknown" });
          log.error("payment_refund_record_failed", {
            paymentKeyPrefix: ledger.paymentKey.slice(0, 12),
            error: result.failure.reason,
          });
          break;

        case "refused": {
          const { attempts, exhausted: finalAttempt } = result.retry;
          if (finalAttempt) exhausted += 1;
          else failed += 1;
          metrics
            .counter("sandbox_refund_worker_total", "Refund worker attempts by result")
            .inc({ result: finalAttempt ? "exhausted" : "failed" });
          if (finalAttempt) {
            // PENDING at the attempt limit is terminal for this worker: the
            // claim query never selects it again, and it stays visible to the
            // operator endpoint and the pending gauge.
            log.error("payment_refund_exhausted", {
              paymentKeyPrefix: ledger.paymentKey.slice(0, 12),
              attempts,
              error: result.failure.reason,
            });
          } else {
            log.warn("payment_refund_attempt_failed", {
              paymentKeyPrefix: ledger.paymentKey.slice(0, 12),
              attempts,
              retryInMs: result.retry.nextAttemptAtMs - now,
              error: result.failure.reason,
            });
          }
          break;
        }

        case "claim_lost":
          // Reclaimed while this pass was sending or releasing. The new owner
          // sends the same key, so the provider returns the original
          // transaction; this pass must not count anything, and must not count
          // an attempt it did not record.
          metrics
            .counter("sandbox_refund_worker_total", "Refund worker attempts by result")
            .inc({ result: "claim_lost" });
          log.warn("payment_refund_claim_lost", {
            paymentKeyPrefix: ledger.paymentKey.slice(0, 12),
            ...(result.stage === "complete" ? { transaction: result.value.transaction } : {}),
            ...(result.stage === "fail" ? { error: result.failure.reason } : {}),
          });
          break;
      }
    }

    return {
      attempted: claims.length,
      refunded,
      failed,
      unknown,
      exhausted,
      reclaimed,
      skipped: false,
    };
  }
}

function requestOf(row: PaymentLedgerRecord): RefundRequest {
  return {
    paymentKey: row.paymentKey,
    settlementNonce: row.settlementNonce,
    payer: row.payer,
    amount: row.amount,
    asset: row.asset,
    network: row.network,
    mode: row.mode,
    reason: row.reason,
    // The claim writes this column; the fallback is the same value, so a row
    // that predates the column still presents a stable key.
    idempotencyKey: row.refundIdempotencyKey ?? refundKey(row.paymentKey).value,
  };
}
