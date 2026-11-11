/**
 * Refund execution for real payment modes (#31).
 *
 * `RefundService` decides *whether* a payment is refundable and, in mock mode,
 * applies it. A real mode leaves `REFUND_PENDING`, and until this worker existed
 * nothing ever resolved it.
 *
 * The worker is deliberately a thin, idempotent loop:
 *
 *  - it only sends funds through an operator-configured webhook
 *    (`REFUND_WEBHOOK_URL`). There is no on-chain signer in this process, so a
 *    compromised controller cannot drain the treasury by itself;
 *  - the ledger transition is conditional (`status = 'REFUND_PENDING'`), so two
 *    workers or a retry cannot refund twice;
 *  - a failed attempt is counted, backed off exponentially and eventually
 *    abandoned at `REFUND_MAX_ATTEMPTS`, leaving the row visible to the operator
 *    endpoint and the pending gauge.
 *
 * With no webhook configured the worker does nothing: real-mode refunds stay
 * `REFUND_PENDING` exactly as before, which is the honest default.
 */
import { log, metrics } from "@x402s/shared/runtime";
import type { PaymentLedgerRecord } from "./store/models.js";
import type { RefundWorkerStore } from "./store/ports.js";

export interface RefundRequest {
  paymentKey: string;
  /** EIP-3009 authorisation nonce, when the payment carried one. */
  settlementNonce: string | null;
  payer: string | null;
  amount: string;
  asset: string;
  network: string;
  mode: string;
  reason: string | null;
}

export interface RefundExecutor {
  refund(request: RefundRequest): Promise<{ transaction: string }>;
}

export interface RefundWorkerOptions {
  maxAttempts: number;
  retryBaseMs: number;
  /** Rows examined per pass. */
  limit: number;
  /** Retry ceiling, so a persistent failure does not retry for a day. */
  retryMaxMs?: number;
  now?: () => number;
}

export interface RefundWorkerResult {
  attempted: number;
  refunded: number;
  failed: number;
  exhausted: number;
  skipped: boolean;
}

/**
 * POSTs one refund to an operator-controlled endpoint. The endpoint is the
 * component that holds signing authority; this process never does.
 *
 * Contract: `200 { "transaction": "<id>" }` means funds were sent. Anything else
 * is a failure and the row is retried.
 */
export class HttpRefundExecutor implements RefundExecutor {
  constructor(
    private readonly url: string,
    private readonly token: string = "",
    private readonly timeoutMs = 10_000,
  ) {}

  async refund(request: RefundRequest): Promise<{ transaction: string }> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`refund webhook answered ${res.status}`);
    const body = (await res.json().catch(() => undefined)) as { transaction?: unknown } | undefined;
    if (typeof body?.transaction !== "string" || body.transaction === "") {
      throw new Error("refund webhook returned no transaction id");
    }
    return { transaction: body.transaction };
  }
}

export class RefundWorker {
  private readonly now: () => number;
  private readonly retryMaxMs: number;

  constructor(
    private readonly store: RefundWorkerStore,
    private readonly executor: RefundExecutor | null,
    private readonly opts: RefundWorkerOptions,
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.retryMaxMs = opts.retryMaxMs ?? 3_600_000;
  }

  /** One pass. Safe to run on every housekeeping tick. */
  async run(): Promise<RefundWorkerResult> {
    const pending = metrics.gauge("sandbox_refunds_pending", "Ledger rows awaiting a real-mode refund");
    // Bounded label on the worker counter; the row count itself is the gauge.
    pending.set({}, await this.store.countLedgerByStatus("REFUND_PENDING"));
    if (!this.executor) {
      return { attempted: 0, refunded: 0, failed: 0, exhausted: 0, skipped: true };
    }

    const now = this.now();
    const rows = await this.store.listRefundPendingDue(now, this.opts.limit);
    let refunded = 0;
    let failed = 0;
    let exhausted = 0;

    for (const row of rows) {
      if (row.refundAttempts >= this.opts.maxAttempts) {
        exhausted += 1;
        continue;
      }
      try {
        const { transaction } = await this.executor.refund(requestOf(row));
        const changed = await this.store.markRefunded(
          row.paymentKey,
          transaction,
          row.reason ?? "refund_worker",
        );
        if (changed) {
          refunded += 1;
          metrics.counter("sandbox_refunds_total", "Payment refund outcomes").inc({ mode: row.mode, result: "refunded" });
          log.info("payment_refunded", {
            paymentKeyPrefix: row.paymentKey.slice(0, 12),
            amount: row.amount,
            transaction,
          });
        }
      } catch (err) {
        failed += 1;
        const message = (err as Error).message;
        const backoff = Math.min(this.retryMaxMs, this.opts.retryBaseMs * 2 ** row.refundAttempts);
        await this.store.recordRefundAttempt(row.paymentKey, message, now + backoff);
        metrics
          .counter("sandbox_refund_worker_total", "Refund worker attempts by result")
          .inc({ result: "error" });
        log.warn("payment_refund_attempt_failed", {
          paymentKeyPrefix: row.paymentKey.slice(0, 12),
          attempts: row.refundAttempts + 1,
          retryInMs: backoff,
          error: message,
        });
      }
    }

    if (exhausted > 0) {
      metrics
        .counter("sandbox_refund_worker_total", "Refund worker attempts by result")
        .inc({ result: "exhausted" });
      log.error("payment_refund_exhausted", { count: exhausted });
    }
    return { attempted: rows.length, refunded, failed, exhausted, skipped: false };
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
  };
}
