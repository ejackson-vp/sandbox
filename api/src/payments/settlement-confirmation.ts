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
 * - `unsettled`: the chain was readable and did not prove that transfer: no
 *   `AuthorizationUsed` in the window, a different recipient, or a short amount.
 *   Never grant.
 * - `unavailable`: the check could not be made (no verifier for this payload, a
 *   requirement that cannot be turned into a check, or a read that threw).
 *   Callers fail closed: no entitlement, and the intent stays claimed while
 *   recovery is still possible.
 *
 * The requirement is always the server's own: `payTo` and the price it quoted.
 * A recipient or amount taken from the request would let the payer choose what
 * "settled" means.
 *
 * The facilitator lookup remains the fallback for a network this module cannot
 * read, which is why `recoveryAvailable` accepts either mechanism.
 */
import type { PaymentRequirements } from "@x402/core/types";
import { paymentAuthorizer, settlementNonce } from "@x402s/shared/crypto";
import { log } from "@x402s/shared/runtime";
import type { ApiConfig } from "../config.js";
import {
  UsdcSettlementVerifier,
  usdcAddressFor,
  type ChainSettlementVerifier,
} from "./settlement-verifier.js";

/** The settlement a recovery resolved, in the shape completion consumes. */
export interface RecoveredSettlement {
  payer?: string;
  transaction?: string;
}

export type ChainVerdict = "settled" | "unsettled" | "unavailable";

/** What the chain must prove, from the requirement the server priced. */
export type SettlementTerms = Pick<PaymentRequirements, "payTo" | "amount">;

/**
 * Build the verifier the deployment configured. Undefined means no chain check
 * is available, which is the mock path and a testnet deployment without an RPC
 * URL. Mainnet refuses to start without one (`api/src/config.ts`).
 */
export function buildSettlementVerifier(
  config: Pick<ApiConfig, "paymentMode" | "network" | "paymentRpcUrl" | "paymentUsdcAddress"> &
    Partial<Pick<ApiConfig, "paymentSettlementLookbackBlocks">>,
): ChainSettlementVerifier | undefined {
  // The mock scheme has no chain: a nonce it accepts is never used on one. Run
  // the verifier there and every mock payment would be refused, so the mock
  // path ignores an RPC URL entirely.
  if (config.paymentMode === "mock" || !config.paymentRpcUrl) return undefined;
  const usdcAddress = config.paymentUsdcAddress ?? usdcAddressFor(config.network);
  if (!usdcAddress) {
    throw new Error(
      `no default USDC address for network ${config.network}; set PAYMENT_USDC_ADDRESS`,
    );
  }
  return new UsdcSettlementVerifier({
    rpcUrl: config.paymentRpcUrl,
    usdcAddress,
    ...(config.paymentSettlementLookbackBlocks !== undefined
      ? { lookbackBlocks: config.paymentSettlementLookbackBlocks }
      : {}),
  });
}

/** The server's terms as the chain check needs them, or null when unusable. */
function chainTerms(terms: SettlementTerms): { recipient: `0x${string}`; amount: bigint } | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(terms.payTo)) return null;
  let amount: bigint;
  try {
    amount = BigInt(terms.amount);
  } catch {
    return null;
  }
  // A free entitlement never reaches here; a non-positive price would make any
  // transfer, including a zero one, satisfy `value >= amount`.
  if (amount <= 0n) return null;
  return { recipient: terms.payTo as `0x${string}`, amount };
}

/**
 * A chain error can quote the RPC call it made, which carries the authorizer and
 * the nonce. Both are receipt-shaped, so every hex value is redacted before it
 * reaches a log line: the error class is enough to diagnose a failure.
 */
function redactHex(message: unknown): string {
  return typeof message === "string" ? message.replace(/0x[0-9a-fA-F]+/g, "0x<redacted>") : "unknown error";
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
  const priced = chainTerms(terms);
  if (!priced) {
    // The answer, not the values: an address or an amount is not a log field.
    log.warn("chain_settlement_terms_unusable");
    return "unavailable";
  }
  try {
    const settled = await verifier.isSettled({
      authorizer,
      nonce: nonce as `0x${string}`,
      recipient: priced.recipient,
      amount: priced.amount,
    });
    return settled ? "settled" : "unsettled";
  } catch (err) {
    // Never the full authorizer or nonce: a log line must not be a receipt.
    log.warn("chain_settlement_verification_failed", { error: redactHex((err as Error).message) });
    return "unavailable";
  }
}

/** Whether anything can resolve an ambiguous settlement for this deployment. */
export function recoveryAvailable(deps: {
  settlementVerifier?: ChainSettlementVerifier;
  settlementLookup: { readonly supported: boolean };
}): boolean {
  return deps.settlementVerifier !== undefined || deps.settlementLookup.supported;
}

/**
 * Resolve a payment that may already have settled, for the crash-recovery path.
 *
 * The chain is asked first because it is authoritative and needs no facilitator
 * answer. A `settled` verdict short-circuits the lookup; anything else falls
 * back to the facilitator when it exposes a settlement lookup, and a definite
 * `null` is the honest answer when neither source can confirm the payment.
 *
 * `terms` is the requirement the intent was claimed with, not anything the
 * client sent with the retry: the recovery must check the same transfer the
 * first attempt priced.
 */
export async function recoverSettlement(
  deps: {
    settlementVerifier?: ChainSettlementVerifier;
    settlementLookup: { readonly supported: boolean; lookup(key: string): Promise<RecoveredSettlement | null> };
  },
  paymentKey: string,
  payload: unknown,
  terms: SettlementTerms,
): Promise<RecoveredSettlement | null> {
  if ((await confirmSettledOnChain(deps.settlementVerifier, payload, terms)) === "settled") {
    // The payer is the address that signed the commitment, not a claimed field:
    // `proveCommitment` already recovered the signer before this is called.
    const payer = paymentAuthorizer(payload) ?? undefined;
    return payer ? { payer } : {};
  }
  if (!deps.settlementLookup.supported) return null;
  try {
    return await deps.settlementLookup.lookup(paymentKey);
  } catch (err) {
    log.warn("settlement_lookup_failed", { error: (err as Error).message, paymentKeyPrefix: paymentKey.slice(0, 12) });
    return null;
  }
}
