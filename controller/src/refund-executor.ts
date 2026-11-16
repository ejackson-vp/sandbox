/**
 * The refund executor port and its HTTP adapter.
 *
 * The worker decides *when* to send; this module owns *what a send means*. The
 * endpoint is the component that holds signing authority, so this process never
 * signs anything: it POSTs one refund and classifies the answer against the
 * shared durable-call algebra.
 *
 * Separated from `refund-worker.ts` so the provider contract (what is a
 * definite refusal, what is ambiguous, which header carries the idempotency key)
 * can be read without the claim/fence/retry loop around it.
 */
import { classifyStatus, definiteFailure, ok, unknown, type ExternalOutcome } from "@x402s/shared/durable";

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
  /**
   * Stable dedupe key, `refund:<paymentKey>`, identical on every attempt for
   * that row. Sent as `Idempotency-Key` and in the body.
   */
  idempotencyKey: string;
}

export interface RefundExecutor {
  refund(request: RefundRequest): Promise<{ transaction: string }>;
}

/**
 * The send ended without a definite answer: a timeout, a dead connection, a 5xx,
 * or a 2xx that named no transaction. Funds may have moved, so the row is left
 * `REFUND_SENDING` and the stale-lease reclaim retries it with the same key.
 *
 * A plain error means the provider definitely refused (a 4xx it answered), so
 * the attempt is counted and backed off.
 */
export class RefundSendUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefundSendUnknownError";
  }
}

/**
 * POSTs one refund to an operator-controlled endpoint. The endpoint is the
 * component that holds signing authority; this process never does.
 *
 * Contract: `200 { "transaction": "<id>" }` means funds were sent. Any other
 * 4xx is a definite refusal. A 5xx, 408, 429, network failure or timeout is
 * ambiguous and raises `RefundSendUnknownError`, because the provider may have
 * paid before the answer was lost. The status split is
 * `classifyStatus` in `shared/src/durable/outcome.ts`, so the worker and the
 * executor cannot disagree about which answers are refusals.
 */
export class HttpRefundExecutor implements RefundExecutor {
  constructor(
    private readonly url: string,
    private readonly token: string = "",
    private readonly timeoutMs = 10_000,
  ) {}

  async refund(request: RefundRequest): Promise<{ transaction: string }> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The header is the contract; the body copy is for endpoints that only
          // read the payload. Both carry the same stable key.
          "idempotency-key": request.idempotencyKey,
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new RefundSendUnknownError(`refund webhook unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const message = `refund webhook answered ${res.status}`;
      // Never downgrade an ambiguous status to a refusal: that would spend the
      // attempt budget on work that may already have been paid.
      if (classifyStatus(res.status) === "definite_failure") throw new Error(message);
      throw new RefundSendUnknownError(message);
    }
    const body = (await res.json().catch(() => undefined)) as { transaction?: unknown } | undefined;
    if (typeof body?.transaction !== "string" || body.transaction === "") {
      throw new RefundSendUnknownError("refund webhook returned no transaction id");
    }
    return { transaction: body.transaction };
  }
}

/**
 * Run one provider call and classify it against the shared algebra. The
 * executor's own protocol is unchanged: a resolved transaction is `ok`,
 * `RefundSendUnknownError` is ambiguous, and any other throw is a refusal the
 * provider answered.
 */
export async function sendRefund(
  executor: RefundExecutor,
  request: RefundRequest,
): Promise<ExternalOutcome<{ transaction: string }>> {
  try {
    return ok(await executor.refund(request));
  } catch (err) {
    const message = (err as Error).message;
    return err instanceof RefundSendUnknownError ? unknown(message) : definiteFailure(message);
  }
}
