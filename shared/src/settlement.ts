/**
 * Settlement lookup: one implementation of the facilitator's settlement
 * contract, shared by the API and the controller.
 *
 * The crash window it closes: the facilitator settles an EIP-3009 authorisation
 * for a payment key, then the API or controller dies before the entitlement and
 * ledger rows are durable. The client retries, gets `nonce_already_used`, and
 * without a lookup the money is gone with no record that it is owed back. The
 * API recovers the entitlement from the record; the controller's recovery worker
 * writes a refundable ledger row for a settlement no session consumed.
 *
 * Both processes read the same contract, so it lives here rather than once per
 * workspace: two copies drift silently and one of them is then wrong about what
 * the facilitator returned.
 *
 * The mock facilitator (and a production facilitator that implements the same
 * contract) exposes `GET /settlements/:paymentKey`. A facilitator without it
 * leaves `supported = false` and recovery is a no-op rather than a guess: the
 * public testnet facilitator exposes no settlement lookup, so the API answers
 * 409 `reconciliation_pending` there instead of charging twice or silently
 * losing the entitlement.
 */
export interface SettlementRecord {
  settled: boolean;
  transaction?: string;
  payer?: string;
  amount?: string;
}

export interface SettlementLookup {
  readonly supported: boolean;
  lookup(paymentKey: string): Promise<SettlementRecord | null>;
}

/** The default request budget. A lookup runs inside a client request or a reconcile tick. */
const DEFAULT_TIMEOUT_MS = 5_000;

export class HttpSettlementLookup implements SettlementLookup {
  readonly supported = true;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async lookup(paymentKey: string): Promise<SettlementRecord | null> {
    const res = await fetch(
      `${this.baseUrl.replace(/\/$/, "")}/settlements/${encodeURIComponent(paymentKey)}`,
      { signal: AbortSignal.timeout(this.timeoutMs) },
    );
    // 404 is "no record for this key", not a failure: the payment may never
    // have reached the facilitator, which is the API's normal retry path.
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`settlement lookup failed (${res.status})`);
    const body = (await res.json()) as SettlementRecord;
    return body?.settled ? body : null;
  }
}

export class UnsupportedSettlementLookup implements SettlementLookup {
  readonly supported = false;
  async lookup(): Promise<null> {
    return null;
  }
}
