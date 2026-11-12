/**
 * Settlement lookup used to recover the crash window between facilitator
 * settlement and durable entitlement creation.
 *
 * The mock facilitator exposes `GET /settlements/:paymentKey`. Production
 * facilitators do not provide this contract, so recovery there must reconcile
 * against on-chain nonce state (see docs/production-readiness.md). When lookup
 * is unavailable the API answers 409 `reconciliation_pending` instead of
 * charging twice or silently losing the entitlement.
 */
interface SettlementRecord {
  settled: boolean;
  transaction?: string;
  payer?: string;
  amount?: string;
}

export interface SettlementLookup {
  readonly supported: boolean;
  lookup(paymentKey: string): Promise<SettlementRecord | null>;
}

export class HttpSettlementLookup implements SettlementLookup {
  readonly supported = true;
  constructor(private readonly baseUrl: string) {}

  async lookup(paymentKey: string): Promise<SettlementRecord | null> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/settlements/${encodeURIComponent(paymentKey)}`, {
      signal: AbortSignal.timeout(5000),
    });
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
