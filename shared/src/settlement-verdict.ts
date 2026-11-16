/**
 * Turning a settlement proof into a decision, and configuring the check.
 *
 * `settlement-verifier.ts` reads the chain. This module owns what the answer
 * means, so the API and the controller cannot disagree about it:
 *
 *  - `not-found` is `unavailable`, never `unsettled`. A nonce outside the scan
 *    window may have settled before it opened, and calling that a refusal turns
 *    a paid payment into a permanent rejection with no debt recorded (F-17).
 *  - only `proven` is `settled`, and `proven` requires the transfer, not just
 *    the nonce.
 *  - the terms are the server's: the recipient and price it quoted, never a
 *    field from the request.
 *
 * The settings parser lives here too, so the fail-closed rules for
 * `PAYMENT_RPC_URL`, `PAYMENT_USDC_ADDRESS` and the scan bounds are one
 * implementation for both processes.
 */
import { envInt as int } from "./env.js";
import {
  DEFAULT_SETTLEMENT_LOOKBACK_BLOCKS,
  DEFAULT_SETTLEMENT_SCAN_CHUNK_BLOCKS,
  UsdcSettlementVerifier,
  usdcAddressFor,
  type ChainSettlementVerifier,
  type DisproofReason,
  type SettlementRequirement,
} from "./settlement-verifier.js";

/** The same 20-byte shape the verifier enforces. */
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * What a settlement check means to a caller.
 *
 * - `settled`: the chain proved the transfer. Grant or recover.
 * - `unsettled`: the chain read the nonce's transaction and positively
 *   disproved the transfer. Never grant, and a weaker source must not override
 *   it.
 * - `unavailable`: the check could not be made, or could not place the payment
 *   (`not-found`). Withhold and keep the reconciliation window open.
 */
export type ChainVerdict = "settled" | "unsettled" | "unavailable";

/** The server's terms as the chain check needs them, or null when unusable. */
export function settlementTerms(terms: {
  payTo: string;
  amount: string | bigint;
}): { recipient: `0x${string}`; amount: bigint } | null {
  if (!ADDRESS_PATTERN.test(terms.payTo)) return null;
  let amount: bigint;
  try {
    amount = typeof terms.amount === "bigint" ? terms.amount : BigInt(terms.amount);
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
export function redactSettlementError(message: unknown): string {
  return typeof message === "string"
    ? message.replace(/0x[0-9a-fA-F]+/g, "0x<redacted>")
    : "unknown error";
}

/** How a caller observes the answer without this module importing the log layer. */
export interface SettlementObservation {
  onProven?(transaction: `0x${string}`): void;
  onDisproven?(reason: DisproofReason, transaction: `0x${string}`): void;
  onNotFound?(): void;
  onError?(err: unknown): void;
}

/**
 * Ask the chain and map its answer to a verdict. Never throws: an error is
 * `unavailable`, which fails closed.
 *
 * Both processes call this, so `not-found` can never be read as a refusal by
 * one of them and as withheld by the other.
 */
export async function settlementVerdict(
  verifier: ChainSettlementVerifier | undefined,
  requirement: SettlementRequirement | null | undefined,
  observe: SettlementObservation = {},
): Promise<ChainVerdict> {
  if (!verifier || !requirement) return "unavailable";
  try {
    const proof = await verifier.settlementProof(requirement);
    if (proof.verdict === "proven") {
      observe.onProven?.(proof.transaction);
      return "settled";
    }
    if (proof.verdict === "disproven") {
      observe.onDisproven?.(proof.reason, proof.transaction);
      return "unsettled";
    }
    // The nonce is not in the window. It may have settled before it opened, so
    // this is "could not place the payment", not "the payment failed".
    observe.onNotFound?.();
    return "unavailable";
  } catch (err) {
    observe.onError?.(err);
    return "unavailable";
  }
}

/**
 * The chain-read settings for a payment mode and network.
 *
 * `PAYMENT_RPC_URL` is opt-in for testnet and ignored for mock: unset on
 * testnet means the facilitator lookup is the only recovery mechanism, which is
 * what those deployments had before the chain reader. The USDC address defaults
 * per network so a deployment cannot accidentally read a different token's
 * state, and an override is validated as a 20-byte address rather than trusted.
 *
 * The scan bounds are parsed on every path, including mock: a misconfigured
 * deployment cannot ask for an unbounded `eth_getLogs`, and the verifier also
 * caps the number of calls per check.
 *
 * The API and the controller both call this, so their fail-closed rules cannot
 * diverge: a setting one process accepts is a setting the other accepts.
 */
export function parseChainReadSettings(
  env: {
    PAYMENT_RPC_URL?: string | undefined;
    PAYMENT_USDC_ADDRESS?: string | undefined;
    PAYMENT_SETTLEMENT_LOOKBACK_BLOCKS?: string | undefined;
    PAYMENT_SETTLEMENT_SCAN_CHUNK_BLOCKS?: string | undefined;
  },
  options: { mock: boolean; network: string },
): {
  lookbackBlocks: number;
  chunkBlocks: number;
  rpcUrl?: string;
  usdcAddress?: `0x${string}`;
} {
  const lookbackBlocks = int(
    env.PAYMENT_SETTLEMENT_LOOKBACK_BLOCKS,
    DEFAULT_SETTLEMENT_LOOKBACK_BLOCKS,
    1,
    1_000_000,
  );
  const chunkBlocks = int(
    env.PAYMENT_SETTLEMENT_SCAN_CHUNK_BLOCKS,
    DEFAULT_SETTLEMENT_SCAN_CHUNK_BLOCKS,
    1,
    1_000_000,
  );
  const scan = { lookbackBlocks, chunkBlocks };
  if (options.mock) return scan;
  const rpcUrl = (env.PAYMENT_RPC_URL ?? "").trim();
  if (rpcUrl.length === 0) return scan;
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new Error("PAYMENT_RPC_URL must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("PAYMENT_RPC_URL must be an absolute http(s) URL");
  }
  const override = (env.PAYMENT_USDC_ADDRESS ?? "").trim();
  if (override.length > 0 && !ADDRESS_PATTERN.test(override)) {
    throw new Error("PAYMENT_USDC_ADDRESS must be a 20-byte EVM address");
  }
  const usdcAddress = (override || usdcAddressFor(options.network)) as `0x${string}` | undefined;
  if (!usdcAddress) {
    throw new Error(
      `PAYMENT_RPC_URL requires a known USDC address for ${options.network}; set PAYMENT_USDC_ADDRESS`,
    );
  }
  return { ...scan, rpcUrl, usdcAddress };
}

export interface ChainVerifierOptions {
  /** No chain exists for the mock scheme, so a mock deployment gets nothing. */
  mock: boolean;
  network: string;
  rpcUrl?: string;
  /** Overrides the per-network default. */
  usdcAddress?: `0x${string}`;
  lookbackBlocks?: number;
  chunkBlocks?: number;
}

/**
 * Build the verifier the deployment configured. Undefined means no chain check
 * is available: the mock path, or a testnet deployment with no RPC URL. Mainnet
 * config refuses to start without an RPC URL before it gets here.
 */
export function buildChainSettlementVerifier(
  options: ChainVerifierOptions,
): ChainSettlementVerifier | undefined {
  // The mock scheme has no chain: a nonce it accepts is never used on one. Run
  // the verifier there and every mock payment would be refused, so the mock
  // path ignores an RPC URL entirely.
  if (options.mock || !options.rpcUrl) return undefined;
  const usdcAddress = options.usdcAddress ?? usdcAddressFor(options.network);
  if (!usdcAddress) {
    throw new Error(
      `no default USDC address for network ${options.network}; set PAYMENT_USDC_ADDRESS`,
    );
  }
  return new UsdcSettlementVerifier({
    rpcUrl: options.rpcUrl,
    usdcAddress,
    lookbackBlocks: options.lookbackBlocks,
    chunkBlocks: options.chunkBlocks,
  });
}

