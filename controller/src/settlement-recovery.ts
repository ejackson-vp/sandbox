/**
 * Settlement recovery for real payment modes (#31, F-10).
 *
 * The crash window this closes: the facilitator settles an EIP-3009
 * authorisation, then the API or controller dies before `completeEntitlement`
 * writes the payment and ledger rows. The client retries, gets
 * `nonce_already_used`, and — without a settlement lookup and without this
 * worker — the money is gone with no record that it is owed back.
 *
 * The worker walks intents that have been `claimed` past a grace period, asks
 * the facilitator whether that payment key settled, and if it did, writes a
 * `REFUND_PENDING` ledger row with a synthetic session id (`unsettled:<key>`).
 * The refund worker then resolves it, or an operator does.
 *
 * Two deliberate limits:
 *
 *  - it never creates an entitlement. The spec, the client key and the
 *    capability are gone by then, and inventing them would be worse than
 *    refunding;
 *  - an unsettled intent is left alone. The API still owns the retry path, and
 *    failing the intent here would race a slow but successful settlement.
 */
import { log, metrics } from "@x402s/shared/runtime";
import type { PaymentIntentRecord } from "./store/models.js";
import type { SettlementRecoveryStore } from "./store/ports.js";
import type { RefundOutcome, RefundService } from "./refunds.js";

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

/**
 * The mock facilitator (and a production facilitator that implements the same
 * contract) exposes `GET /settlements/:paymentKey`. A facilitator without it
 * leaves `supported = false`, and recovery is a no-op rather than a guess.
 */
export class HttpSettlementLookup implements SettlementLookup {
  readonly supported = true;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 5_000,
  ) {}

  async lookup(paymentKey: string): Promise<SettlementRecord | null> {
    const res = await fetch(
      `${this.baseUrl.replace(/\/$/, "")}/settlements/${encodeURIComponent(paymentKey)}`,
      { signal: AbortSignal.timeout(this.timeoutMs) },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`settlement lookup failed (${res.status})`);
    const body = (await res.json()) as SettlementRecord;
    return body?.settled ? body : null;
  }
}

export interface SettlementRecoveryOptions {
  /** How long a claim may sit before recovery considers it a crash. */
  graceMs: number;
  /** Intents examined per pass. */
  limit: number;
  /** Payment mode stamped on the ledger row when the lookup omits it. */
  mode: "mock" | "testnet";
  now?: () => number;
}

export interface SettlementRecoveryResult {
  checked: number;
  recovered: number;
  errors: number;
}

interface RequirementSummary {
  asset?: string;
  network?: string;
  amount?: string;
}

/** The claim recorded the requirements JSON; a malformed row is not fatal. */
function requirementsOf(intent: PaymentIntentRecord): RequirementSummary {
  if (!intent.requirementsJson) return {};
  try {
    const parsed = JSON.parse(intent.requirementsJson) as RequirementSummary;
    return {
      ...(typeof parsed.asset === "string" ? { asset: parsed.asset } : {}),
      ...(typeof parsed.network === "string" ? { network: parsed.network } : {}),
      ...(typeof parsed.amount === "string" ? { amount: parsed.amount } : {}),
    };
  } catch {
    return {};
  }
}

export class SettlementRecovery {
  private readonly now: () => number;

  constructor(
    private readonly store: SettlementRecoveryStore,
    private readonly refunds: RefundService,
    private readonly lookup: SettlementLookup | null,
    private readonly opts: SettlementRecoveryOptions,
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  async run(): Promise<SettlementRecoveryResult> {
    if (!this.lookup?.supported) return { checked: 0, recovered: 0, errors: 0 };

    const cutoff = this.now() - this.opts.graceMs;
    const intents = await this.store.listStaleClaimedIntents(cutoff, this.opts.limit);
    let recovered = 0;
    let errors = 0;

    for (const intent of intents) {
      // Already accounted for: a completed entitlement, a previous recovery, or
      // a refund. Nothing to do.
      if (await this.store.getLedgerByPayment(intent.paymentKey)) continue;
      try {
        const record = await this.lookup.lookup(intent.paymentKey);
        if (!record) continue;
        const requirements = requirementsOf(intent);
        const inserted = await this.store.insertUnclaimedLedger({
          paymentKey: intent.paymentKey,
          sessionId: `unsettled:${intent.paymentKey}`,
          payer: record.payer ?? null,
          amount: record.amount ?? requirements.amount ?? "0",
          asset: requirements.asset ?? "unknown",
          network: requirements.network ?? "unknown",
          mode: this.opts.mode,
          // SETTLED so `applyPolicy` can apply the mode rule: mock refunds now,
          // a real mode becomes REFUND_PENDING for the worker. A crash between
          // this write and the policy is repaired by RefundService.reconcile.
          status: "SETTLED",
          reason: "settled_without_entitlement",
          settlementNonce: null,
        });
        if (!inserted) continue;
        recovered += 1;
        const ledger = await this.store.getLedgerByPayment(intent.paymentKey);
        let outcome: RefundOutcome = "pending";
        if (ledger) outcome = await this.refunds.applyPolicy(ledger, "settled_without_entitlement");
        metrics
          .counter("sandbox_settlement_recovery_total", "Settled payments recovered without an entitlement")
          .inc({ result: outcome });
        log.warn("payment_settled_without_entitlement", {
          paymentKeyPrefix: intent.paymentKey.slice(0, 12),
          amount: record.amount ?? requirements.amount ?? "unknown",
          refund: outcome,
        });
      } catch (err) {
        errors += 1;
        log.warn("settlement_recovery_failed", {
          paymentKeyPrefix: intent.paymentKey.slice(0, 12),
          error: (err as Error).message,
        });
      }
    }

    return { checked: intents.length, recovered, errors };
  }
}
