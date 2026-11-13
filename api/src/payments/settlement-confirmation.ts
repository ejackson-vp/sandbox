/**
 * When a settlement counts as settled.
 *
 * One answer, used by both the first attempt and the crash-recovery path, so
 * "the facilitator said yes" and "the chain says yes" can never drift into two
 * different policies.
 *
 * - `settled`: the EIP-3009 nonce is used on chain. Grant or recover.
 * - `unsettled`: the chain answered, and the nonce is not used. Never grant.
 * - `unavailable`: the check could not be made (no verifier for this payload,
 *   or the read threw). Callers fail closed: no entitlement, and the intent
 *   stays claimed while recovery is still possible.
 *
 * The facilitator lookup remains the fallback for a network this module cannot
 * read, which is why `recoveryAvailable` accepts either mechanism.
 */
import { paymentAuthorizer, settlementNonce } from "@x402s/shared/crypto";
import { log } from "@x402s/shared/runtime";
import type { ApiConfig } from "../config.js";
import {
  UsdcAuthorizationStateVerifier,
  usdcAddressFor,
  type ChainSettlementVerifier,
} from "./settlement-verifier.js";

/** The settlement a recovery resolved, in the shape completion consumes. */
export interface RecoveredSettlement {
  payer?: string;
  transaction?: string;
}

export type ChainVerdict = "settled" | "unsettled" | "unavailable";

/**
 * Build the verifier the deployment configured. Undefined means no chain check
 * is available, which is the mock path and a testnet deployment without an RPC
 * URL. Mainnet refuses to start without one (`api/src/config.ts`).
 */
export function buildSettlementVerifier(
  config: Pick<ApiConfig, "paymentMode" | "network" | "paymentRpcUrl" | "paymentUsdcAddress">,
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
  return new UsdcAuthorizationStateVerifier({ rpcUrl: config.paymentRpcUrl, usdcAddress });
}

/** Ask the chain. Never throws: an error is `unavailable`, which fails closed. */
export async function confirmSettledOnChain(
  verifier: ChainSettlementVerifier | undefined,
  payload: unknown,
): Promise<ChainVerdict> {
  if (!verifier) return "unavailable";
  const authorizer = paymentAuthorizer(payload);
  const nonce = settlementNonce(payload);
  if (!authorizer || !nonce) return "unavailable";
  try {
    return (await verifier.isSettled(authorizer, nonce as `0x${string}`)) ? "settled" : "unsettled";
  } catch (err) {
    // Never the full authorizer or nonce: a log line must not be a receipt.
    log.warn("chain_settlement_verification_failed", { error: (err as Error).message });
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
 */
export async function recoverSettlement(
  deps: {
    settlementVerifier?: ChainSettlementVerifier;
    settlementLookup: { readonly supported: boolean; lookup(key: string): Promise<RecoveredSettlement | null> };
  },
  paymentKey: string,
  payload: unknown,
): Promise<RecoveredSettlement | null> {
  if ((await confirmSettledOnChain(deps.settlementVerifier, payload)) === "settled") {
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
