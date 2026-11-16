/**
 * Settlement recovery for real payment modes (#31, F-10, F-19).
 *
 * The crash window this closes: the facilitator settles an EIP-3009
 * authorisation, then the API or controller dies before `completeEntitlement`
 * writes the payment and ledger rows. The client retries, gets
 * `nonce_already_used`, and — without a chain read and without this worker —
 * the money is gone with no record that it is owed back.
 *
 * The worker walks intents that have been `claimed` past a grace period and
 * asks two sources, in order:
 *
 *  1. the chain: the `AuthorizationUsed` log for the nonce the API recorded at
 *     claim time, then the `Transfer` in that transaction, checked against the
 *     recipient and price from the same intent's `requirements_json` (F-17).
 *     Nonce use alone is never enough: a 1-atomic-unit authorisation to the
 *     wrong address is not this payment. This is authoritative and needs no
 *     facilitator answer, so it works on a network whose facilitator exposes no
 *     settlement lookup (F-19);
 *  2. the facilitator's settlement lookup, for a network this deployment cannot
 *     read (no RPC URL, or a non-EVM network), when the nonce is outside the
 *     scan window, or for an intent claimed before the attribution columns
 *     existed. Same fallback as before.
 *
 * A proven answer writes a `REFUND_PENDING` ledger row with a synthetic session
 * id (`unsettled:<key>`). The refund worker then resolves it, or an operator
 * does. With neither source the pass is a no-op, which is the honest default:
 * no verifier and no lookup must not invent a debt.
 *
 * The verifier and the verdict mapping are `@x402s/shared/settlement`: the API
 * and this worker ask the same question through one implementation, so "the
 * facilitator said yes" and "the chain proved the transfer" cannot drift.
 *
 * Two deliberate limits:
 *
 *  - it never creates an entitlement. The spec, the client key and the
 *    capability are gone by then, and inventing them would be worse than
 *    refunding;
 *  - an unsettled intent is left alone. The API still owns the retry path, and
 *    failing the intent here would race a slow but successful settlement. A
 *    chain read that fails is also left alone: the next pass retries it.
 */
import { log, metrics, type SettlementLookup } from "@x402s/shared/runtime";
import {
  redactSettlementError,
  settlementTerms,
  settlementVerdict,
  type ChainSettlementVerifier,
  type ChainVerdict,
} from "@x402s/shared/settlement";
import type { PaymentMode } from "@x402s/shared/protocol";
import type { PaymentIntentRecord } from "./store/models/money.js";
import type { SettlementRecoveryStore } from "./store/ports.js";
import type { RefundOutcome, RefundService } from "./refunds.js";

/** Where a recovery answer can come from, in order of authority. */
export interface SettlementRecoverySources {
  /** Chain read, when the deployment configured one. Authoritative. */
  verifier: ChainSettlementVerifier | null;
  /** Facilitator lookup, when it exposes one. Fallback only. */
  lookup: SettlementLookup | null;
}

interface SettlementRecoveryOptions {
  /** How long a claim may sit before recovery considers it a crash. */
  graceMs: number;
  /** Intents examined per pass. */
  limit: number;
  /** Payment mode stamped on the ledger row when the lookup omits it. */
  mode: PaymentMode;
  /**
   * Network the configured verifier reads. An intent whose recorded
   * requirements name another network is not asked about: one USDC contract
   * cannot answer for a different chain.
   */
  network?: string;
  now?: () => number;
}

interface SettlementRecoveryResult {
  checked: number;
  recovered: number;
  errors: number;
}

interface RequirementSummary {
  asset?: string;
  network?: string;
  amount?: string;
  payTo?: string;
}

/** What a source resolved: enough to describe the payment on the ledger. */
interface SettledAnswer {
  payer?: string | null;
  amount?: string | null;
  source: "chain" | "lookup";
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
      ...(typeof parsed.payTo === "string" ? { payTo: parsed.payTo } : {}),
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
    private readonly sources: SettlementRecoverySources,
    private readonly opts: SettlementRecoveryOptions,
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Ask the chain about one intent, if this deployment can.
   *
   * The proof needs the terms the API priced: the recipient and amount from the
   * intent's `requirements_json`, plus the authorizer and nonce recorded at
   * claim time. A nonce with no usable terms is not a settlement answer, so it
   * is `unavailable` and the lookup may still resolve the payment key.
   *
   * `unavailable` covers "there is nothing to ask" (no verifier, another
   * network, a pre-v20 row, unusable terms) and "the ask failed". Only the
   * second sets `failed`, so the caller can count a real error without treating
   * a payment this worker cannot read as one.
   */
  private async chainAnswer(intent: PaymentIntentRecord): Promise<{
    verdict: ChainVerdict;
    failed: boolean;
  }> {
    const verifier = this.sources.verifier;
    if (!verifier) return { verdict: "unavailable", failed: false };
    const requirements = requirementsOf(intent);
    if (this.opts.network !== undefined && requirements.network !== this.opts.network) {
      return { verdict: "unavailable", failed: false };
    }
    if (!intent.authorizer || !intent.settlementNonce) {
      return { verdict: "unavailable", failed: false };
    }
    // The claim schema validates both shapes; a hand-edited row could still
    // hold something else, and a malformed value must not reach the RPC.
    if (
      !/^0x[0-9a-fA-F]{40}$/.test(intent.authorizer) ||
      !/^0x[0-9a-fA-F]{64}$/.test(intent.settlementNonce)
    ) {
      return { verdict: "unavailable", failed: false };
    }
    // The recovery must prove the same transfer the API priced, so the terms
    // come from the requirement recorded at claim time, never from the nonce.
    const terms = settlementTerms({
      payTo: requirements.payTo ?? "",
      amount: requirements.amount ?? "0",
    });
    if (!terms) {
      log.warn("settlement_recovery_terms_unusable", {
        paymentKeyPrefix: intent.paymentKey.slice(0, 12),
      });
      return { verdict: "unavailable", failed: false };
    }
    let failed = false;
    const verdict = await settlementVerdict(
      verifier,
      {
        authorizer: intent.authorizer as `0x${string}`,
        nonce: intent.settlementNonce as `0x${string}`,
        recipient: terms.recipient,
        amount: terms.amount,
      },
      {
        // The reason is a category, never an address or an amount.
        onDisproven: (reason) =>
          log.warn("settlement_chain_disproven", {
            paymentKeyPrefix: intent.paymentKey.slice(0, 12),
            reason,
          }),
        onNotFound: () =>
          log.warn("settlement_chain_not_in_window", {
            paymentKeyPrefix: intent.paymentKey.slice(0, 12),
          }),
        onError: (err) => {
          failed = true;
          log.warn("settlement_chain_read_failed", {
            paymentKeyPrefix: intent.paymentKey.slice(0, 12),
            error: redactSettlementError(err instanceof Error ? err.message : err),
          });
        },
      },
    );
    return { verdict, failed };
  }

  /**
   * Write the debt for a settled payment no session consumed, then apply the
   * refund policy. Returns false when a row already existed, which is the
   * idempotency the worker relies on.
   */
  private async record(intent: PaymentIntentRecord, settled: SettledAnswer): Promise<boolean> {
    const requirements = requirementsOf(intent);
    const inserted = await this.store.insertUnclaimedLedger({
      paymentKey: intent.paymentKey,
      sessionId: `unsettled:${intent.paymentKey}`,
      payer: settled.payer ?? intent.authorizer ?? null,
      amount: settled.amount ?? requirements.amount ?? "0",
      asset: requirements.asset ?? "unknown",
      network: requirements.network ?? this.opts.network ?? "unknown",
      mode: this.opts.mode,
      // SETTLED so `applyPolicy` can apply the mode rule: mock refunds now,
      // a real mode becomes REFUND_PENDING for the worker. A crash between
      // this write and the policy is repaired by RefundService.reconcile.
      status: "SETTLED",
      reason: "settled_without_entitlement",
      settlementNonce: intent.settlementNonce ?? null,
    });
    if (!inserted) return false;
    const ledger = await this.store.getLedgerByPayment(intent.paymentKey);
    let outcome: RefundOutcome = "pending";
    if (ledger) outcome = await this.refunds.applyPolicy(ledger, "settled_without_entitlement");
    metrics
      .counter("sandbox_settlement_recovery_total", "Settled payments recovered without an entitlement")
      .inc({ result: outcome, source: settled.source });
    log.warn("payment_settled_without_entitlement", {
      paymentKeyPrefix: intent.paymentKey.slice(0, 12),
      amount: settled.amount ?? requirements.amount ?? "unknown",
      source: settled.source,
      refund: outcome,
    });
    return true;
  }

  async run(): Promise<SettlementRecoveryResult> {
    const lookup = this.sources.lookup?.supported ? this.sources.lookup : null;
    if (!this.sources.verifier && !lookup) return { checked: 0, recovered: 0, errors: 0 };

    const cutoff = this.now() - this.opts.graceMs;
    const intents = await this.store.listStaleClaimedIntents(cutoff, this.opts.limit);
    let recovered = 0;
    let errors = 0;

    for (const intent of intents) {
      // Already accounted for: a completed entitlement, a previous recovery, or
      // a refund. Nothing to do.
      if (await this.store.getLedgerByPayment(intent.paymentKey)) continue;
      try {
        const chain = await this.chainAnswer(intent);
        if (chain.verdict === "settled") {
          // Proven means the nonce's transaction transferred at least the
          // recorded price to the recorded payee. The row's amount and payee
          // come from the same requirement, so the books describe the payment
          // the chain just proved.
          if (await this.record(intent, { payer: intent.authorizer, source: "chain" })) recovered += 1;
          continue;
        }
        // The chain read the nonce's transaction and it does not pay this
        // requirement. That is a positive answer for this network, so a weaker
        // source must not override it.
        if (chain.verdict === "unsettled") continue;

        if (!lookup) {
          // Nothing else can answer. A failed read is an error to retry; a
          // missing authorizer or another network is simply not this worker's
          // payment.
          if (chain.failed) errors += 1;
          continue;
        }
        const record = await lookup.lookup(intent.paymentKey);
        if (!record) {
          if (chain.failed) errors += 1;
          continue;
        }
        const inserted = await this.record(intent, {
          payer: record.payer,
          amount: record.amount,
          source: "lookup",
        });
        if (inserted) recovered += 1;
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
