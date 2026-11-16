/**
 * When a settlement counts as settled.
 *
 * One answer, used by both the first attempt and the crash-recovery path, so
 * "the facilitator said yes" and "the chain proves the transfer" can never
 * drift into two different policies.
 *
 * - `settled`: the transaction that consumed the EIP-3009 nonce also transferred
 *   at least the server's price, from the authorizer, to the server's `PAY_TO`,
 *   on the configured USDC contract. Grant or recover.
 * - `unsettled`: the chain was readable and positively disproved that transfer:
 *   the nonce's transaction carried a `Transfer` to another recipient, a short
 *   one, no matching `Transfer` at all, or it reverted. Never grant.
 * - `unavailable`: the check could not be made or could not place the payment:
 *   no verifier for this payload, a requirement that cannot be turned into a
 *   check, no `AuthorizationUsed` log inside the window, a read that threw, or a
 *   settlement record that does not name the recipient and the amount it moved.
 *   A nonce older than the window is *this*, not `unsettled`: the nonce may have
 *   settled before the window opened, and calling that a refusal turns a paid
 *   payment into a permanent retry loop with no debt recorded. `unavailable`
 *   withholds without closing the reconciliation window, which is what the
 *   recovery worker and the facilitator fallback need.
 *
 * The requirement is always the server's own: `payTo` and the price it quoted.
 * A recipient or amount taken from the request, or from a settlement record that
 * merely says "settled", would let the payer choose what "settled" means (F-21).
 *
 * The facilitator lookup remains the fallback for a network this module cannot
 * read, which is why `recoveryAvailable` accepts either mechanism. It is held to
 * the same standard as the chain: `settled: true` alone proves a debt exists,
 * not that this requirement was paid.
 */
import type { PaymentRequirements } from "@x402/core/types";
import { paymentAuthorizer, settlementNonce } from "@x402s/shared/crypto";
import { log, type SettlementRecord } from "@x402s/shared/runtime";
import {
  buildChainSettlementVerifier,
  isEvmAddress,
  redactSettlementError,
  settlementTerms,
  settlementVerdict,
  type ChainSettlementVerifier,
  type ChainVerdict,
} from "@x402s/shared/settlement";
import type { ApiConfig } from "../config.js";

/** The settlement a recovery resolved, in the shape completion consumes. */
export interface RecoveredSettlement {
  payer?: string;
  transaction?: string;
}

/**
 * What a recovery attempt found, so a caller can tell a refusal from an
 * unanswered question. The nonce-conflict branch needs that difference: a
 * `not-settled` answer fails the intent, and `unknown` must not.
 */
export type SettlementResolution =
  /** A source proved the payment. Complete the entitlement. */
  | { status: "settled"; settlement: RecoveredSettlement }
  /** A source positively said this payment did not settle. Refuse it. */
  | { status: "not-settled" }
  /** Neither source could answer. Withhold and let recovery try again. */
  | { status: "unknown" };

/** What the chain must prove, from the requirement the server priced. */
export type SettlementTerms = Pick<PaymentRequirements, "payTo" | "amount">;

/**
 * Build the verifier the deployment configured. Undefined means no chain check
 * is available, which is the mock path and a testnet deployment without an RPC
 * URL. Mainnet refuses to start without one (`api/src/config.ts`).
 */
export function buildSettlementVerifier(
  config: Pick<ApiConfig, "paymentMode" | "network" | "paymentRpcUrl" | "paymentUsdcAddress"> &
    Partial<Pick<ApiConfig, "paymentSettlementLookbackBlocks" | "paymentSettlementScanChunkBlocks">>,
): ChainSettlementVerifier | undefined {
  return buildChainSettlementVerifier({
    mock: config.paymentMode === "mock",
    network: config.network,
    rpcUrl: config.paymentRpcUrl,
    usdcAddress: config.paymentUsdcAddress,
    lookbackBlocks: config.paymentSettlementLookbackBlocks,
    chunkBlocks: config.paymentSettlementScanChunkBlocks,
  });
}

/** Ask the chain. Never throws: an error is `unavailable`, which fails closed. */
export async function confirmSettledOnChain(
  verifier: ChainSettlementVerifier | undefined,
  payload: unknown,
  terms: SettlementTerms,
): Promise<ChainVerdict> {
  if (!verifier) return "unavailable";
  const authorizer = paymentAuthorizer(payload);
  const nonce = settlementNonce(payload);
  if (!authorizer || !nonce) return "unavailable";
  const priced = settlementTerms(terms);
  if (!priced) {
    // The answer, not the values: an address or an amount is not a log field.
    log.warn("chain_settlement_terms_unusable");
    return "unavailable";
  }
  return settlementVerdict(
    verifier,
    { authorizer, nonce: nonce as `0x${string}`, ...priced },
    {
      onDisproven: (reason) => {
        // The reason is a category, never an address or an amount.
        log.warn("chain_settlement_disproven", { reason });
      },
      onNotFound: () => {
        // The nonce is not in the window. It may have settled before it opened,
        // so this is "could not place the payment", not "the payment failed".
        log.warn("chain_settlement_not_in_window");
      },
      onError: (err) => {
        // Never the full authorizer or nonce: a log line must not be a receipt.
        log.warn("chain_settlement_verification_failed", {
          error: redactSettlementError(err instanceof Error ? err.message : err),
        });
      },
    },
  );
}

/** Whether anything can resolve an ambiguous settlement for this deployment. */
export function recoveryAvailable(deps: {
  settlementVerifier?: ChainSettlementVerifier;
  settlementLookup: { readonly supported: boolean };
}): boolean {
  return deps.settlementVerifier !== undefined || deps.settlementLookup.supported;
}

/** The record as the chain check would need it, or null when it cannot answer. */
function recordTerms(record: SettlementRecord): { recipient: `0x${string}`; amount: bigint } | null {
  if (!isEvmAddress(record.recipient)) return null;
  if (typeof record.amount !== "string" || !/^\d+$/.test(record.amount)) return null;
  return { recipient: record.recipient, amount: BigInt(record.amount) };
}

/**
 * What a settlement record proves about one requirement.
 *
 * `settled: true` says the payment key settled, not that this requirement was
 * paid. The record has to name the address the transfer went to and the amount
 * that moved, or the answer is `unknown`: a record that cannot answer is the
 * same withholding as a chain read that cannot place the nonce, and a facilitator
 * that omits the fields is never able to mint a session (F-21). A record that
 * answers with a different recipient or a short amount contradicts the
 * requirement, so it is a refusal rather than an unanswered question.
 */
function recordVerdict(
  record: SettlementRecord,
  priced: { recipient: `0x${string}`; amount: bigint },
): ChainVerdict {
  const terms = recordTerms(record);
  if (!terms) return "unavailable";
  if (terms.recipient.toLowerCase() !== priced.recipient.toLowerCase()) return "unsettled";
  if (terms.amount < priced.amount) return "unsettled";
  return "settled";
}

/**
 * Resolve a payment that may already have settled, for the crash-recovery path.
 *
 * The chain is asked first because it is authoritative and needs no facilitator
 * answer. A `settled` verdict short-circuits the lookup, and a `disproven` one
 * ends the question: the chain read the nonce's transaction and it does not pay
 * this requirement, so a facilitator lookup must not override it.
 *
 * Only a chain that could not answer falls back to the lookup, and the lookup is
 * held to the same standard: the record must prove the recipient and the amount,
 * not merely that the key settled (F-21).
 *
 * When neither source can answer, the result is `unknown`, which is a different
 * thing from "did not settle": callers must withhold rather than refuse, or a
 * paid payment gets a terminal refusal with no debt recorded.
 *
 * `terms` is the requirement the intent was claimed with, not anything the
 * client sent with the retry: the recovery must check the same transfer the
 * first attempt priced.
 */
export async function recoverSettlement(
  deps: {
    settlementVerifier?: ChainSettlementVerifier;
    settlementLookup: { readonly supported: boolean; lookup(key: string): Promise<SettlementRecord | null> };
  },
  paymentKey: string,
  payload: unknown,
  terms: SettlementTerms,
): Promise<SettlementResolution> {
  const chain = await confirmSettledOnChain(deps.settlementVerifier, payload, terms);
  if (chain === "settled") {
    // The payer is the address that signed the commitment, not a claimed field:
    // `proveCommitment` already recovered the signer before this is called.
    const payer = paymentAuthorizer(payload) ?? undefined;
    return { status: "settled", settlement: payer ? { payer } : {} };
  }
  if (chain === "unsettled") return { status: "not-settled" };
  if (!deps.settlementLookup.supported) return { status: "unknown" };
  let record: SettlementRecord | null;
  try {
    record = await deps.settlementLookup.lookup(paymentKey);
  } catch (err) {
    // A lookup that failed is not a lookup that said no.
    log.warn("settlement_lookup_failed", { error: (err as Error).message, paymentKeyPrefix: paymentKey.slice(0, 12) });
    return { status: "unknown" };
  }
  if (!record) return { status: "not-settled" };
  const priced = settlementTerms(terms);
  const verdict = priced ? recordVerdict(record, priced) : "unavailable";
  if (verdict === "unsettled") {
    // A readable record that paid another address, or too little. The log line
    // carries a category, never a field.
    log.warn("settlement_record_disproven", { paymentKeyPrefix: paymentKey.slice(0, 12) });
    return { status: "not-settled" };
  }
  if (verdict === "unavailable") {
    log.warn("settlement_record_incomplete", { paymentKeyPrefix: paymentKey.slice(0, 12) });
    return { status: "unknown" };
  }
  return { status: "settled", settlement: record };
}
