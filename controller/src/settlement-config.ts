/**
 * Settlement, refund and budget configuration (#31, #48, F-19).
 *
 * Split out of `config.ts` for reviewability. Three rules are worth stating
 * here because they are easy to get wrong:
 *
 *  - every refund path is opt-in. An empty `REFUND_WEBHOOK_URL` means no
 *    automatic transfer of funds, and the controller holds no signing key;
 *  - an amount is kept as a decimal string. USDC has 6 decimals, but a tier is
 *    operator-configurable and 30 digits is the schema limit, so a JS number
 *    would be the wrong type for money;
 *  - a mainnet controller refuses to start without a chain reader. Recovery
 *    that could not see the chain would only record a debt when the facilitator
 *    happens to expose a lookup, which is the F-19 failure. The mock path stays
 *    exactly as it was: no chain exists there.
 */
import { envBool as bool, envInt as int } from "@x402s/shared/env";
import {
  MAINNET_NETWORKS,
  MOCK_NETWORK,
  SETTLEABLE_MAINNET_NETWORKS,
  TESTNET_NETWORK,
  TESTNET_NETWORKS,
} from "@x402s/shared/payment";
import type { PaymentMode } from "@x402s/shared/protocol";
import { parseChainReadSettings } from "@x402s/shared/settlement";

interface SettlementConfig {
  paymentMode: PaymentMode;
  /**
   * The network this deployment settles on. Recovery asks the chain only about
   * an intent whose recorded requirements name this network: the verifier reads
   * one USDC contract, and an answer from the wrong chain is worse than none.
   */
  paymentNetwork: string;
  /**
   * JSON-RPC endpoint for the chain read. Unset on the mock path and on a
   * testnet deployment without an RPC; mainnet refuses to start without it.
   */
  paymentRpcUrl?: string;
  /** USDC contract that holds the authorisations. Defaults per network. */
  paymentUsdcAddress?: `0x${string}`;
  /**
   * How far behind head the chain check scans for the `AuthorizationUsed` log,
   * in blocks. The API uses the same value, so both processes cover the same
   * reconciliation window.
   */
  paymentSettlementLookbackBlocks: number;
  /** Blocks per `eth_getLogs` call; the verifier caps the calls per check. */
  paymentSettlementScanChunkBlocks: number;
  facilitatorUrl: string;
  refundWebhookUrl: string;
  refundWebhookToken: string;
  refundMaxAttempts: number;
  refundRetryBaseMs: number;
  /**
   * How long a claimed refund is owned before another pass may reclaim it. Must
   * be longer than the refund webhook timeout (10 s in `HttpRefundExecutor`).
   */
  refundClaimLeaseMs: number;
  settlementRecoveryEnabled: boolean;
  settlementRecoveryGraceMs: number;
}

/**
 * The network this controller settles on, validated against the same sets the
 * API uses (`@x402s/shared/payment`). The controller reads the chain, it does
 * not register an x402 scheme, but a network the API could not produce is a
 * configuration mistake worth refusing rather than carrying into recovery.
 *
 * Mock ignores `NETWORK`: a dev box that exports one moves no money, and the
 * mock facilitator never touches a chain.
 */
function parsePaymentNetwork(env: NodeJS.ProcessEnv, paymentMode: PaymentMode): string {
  if (paymentMode === "mock") return MOCK_NETWORK;
  const requested = (env.NETWORK ?? "").trim();
  if (paymentMode === "mainnet") {
    if (requested.length === 0) {
      throw new Error(
        "PAYMENT_MODE=mainnet requires NETWORK to be set explicitly (there is no mainnet default)",
      );
    }
    if (!SETTLEABLE_MAINNET_NETWORKS.has(requested)) {
      throw new Error(
        `PAYMENT_MODE=mainnet requires NETWORK in the mainnet allowlist (${[...SETTLEABLE_MAINNET_NETWORKS].join(", ")}), got ${requested}`,
      );
    }
    return requested;
  }
  const network = requested.length > 0 ? requested : TESTNET_NETWORK;
  if (MAINNET_NETWORKS.has(network)) {
    throw new Error(
      `refusing to start: ${network} is a mainnet network; real money requires PAYMENT_MODE=mainnet (no silent mainnet activation)`,
    );
  }
  if (!TESTNET_NETWORKS.has(network)) {
    throw new Error(`testnet payment mode requires a documented testnet network, got ${network}`);
  }
  return network;
}

/**
 * Settlement reconciliation and refund execution (#31). All of it is opt-in by
 * configuration: no webhook means no automatic transfer of funds.
 *
 * `allowInsecureDev` is passed in rather than re-read so the flag and the
 * payment mode are validated against one parse, the same way the API does.
 */
export function parseSettlement(
  env: NodeJS.ProcessEnv,
  allowInsecureDev: boolean,
): SettlementConfig {
  const paymentMode = (env.PAYMENT_MODE ?? "mock") as PaymentMode;
  if (paymentMode !== "mock" && paymentMode !== "testnet" && paymentMode !== "mainnet") {
    throw new Error(`PAYMENT_MODE must be "mock", "testnet" or "mainnet", got ${paymentMode}`);
  }
  const refundWebhookUrl = env.REFUND_WEBHOOK_URL ?? "";
  if (refundWebhookUrl && !/^https?:\/\//.test(refundWebhookUrl)) {
    throw new Error("REFUND_WEBHOOK_URL must be an absolute http(s) URL");
  }
  const paymentNetwork = parsePaymentNetwork(env, paymentMode);
  const chain = parseChainReadSettings(env, { mock: paymentMode === "mock", network: paymentNetwork });
  // Real money is never reconciled on a facilitator's word alone: a mainnet
  // controller must be able to read the EIP-3009 nonce on chain, the same rule
  // the API applies before it grants (`api/src/config.ts`).
  if (paymentMode === "mainnet" && !chain.rpcUrl) {
    throw new Error(
      "PAYMENT_MODE=mainnet requires PAYMENT_RPC_URL: settlement recovery must be verified on chain",
    );
  }
  // Real payments and the dev switch are mutually exclusive. ALLOW_INSECURE_DEV
  // accepts simulated attestation and an unpinned guest image, so a controller
  // that has it on while settling mainnet is provisioning sandboxes whose
  // isolation evidence anyone can forge. The API refuses the same pair; this is
  // the controller's half of that rule, because a mainnet config can be handed
  // to this process directly.
  if (paymentMode === "mainnet" && allowInsecureDev) {
    throw new Error(
      "refusing to start: PAYMENT_MODE=mainnet requires ALLOW_INSECURE_DEV=false; " +
        "the insecure switch accepts simulated dev attestation and an unpinned guest image, " +
        "so real payments must not run with it on",
    );
  }
  return {
    paymentMode,
    paymentNetwork,
    ...(chain.rpcUrl ? { paymentRpcUrl: chain.rpcUrl } : {}),
    ...(chain.usdcAddress ? { paymentUsdcAddress: chain.usdcAddress } : {}),
    paymentSettlementLookbackBlocks: chain.lookbackBlocks,
    paymentSettlementScanChunkBlocks: chain.chunkBlocks,
    facilitatorUrl: env.FACILITATOR_URL ?? "",
    refundWebhookUrl,
    refundWebhookToken: env.REFUND_WEBHOOK_TOKEN ?? "",
    refundMaxAttempts: int(env.REFUND_MAX_ATTEMPTS, 10, 1, 100),
    refundRetryBaseMs: int(env.REFUND_RETRY_BASE_MS, 60_000, 1_000, 3_600_000),
    refundClaimLeaseMs: int(env.REFUND_CLAIM_LEASE_MS, 60_000, 5_000, 3_600_000),
    settlementRecoveryEnabled: bool(env.SETTLEMENT_RECOVERY_ENABLED, true),
    settlementRecoveryGraceMs: int(env.SETTLEMENT_RECOVERY_GRACE_MS, 300_000, 30_000, 3_600_000),
  };
}

/**
 * A non-negative decimal amount in atomic units, kept as a string so it never
 * loses precision through a JS number (USDC 6dp, but tiers are configurable).
 */
export function atomicAmount(raw: string | undefined, fallback: string): string {
  const value = (raw ?? fallback).trim();
  if (!/^\d{1,30}$/.test(value)) {
    throw new Error(`expected a non-negative decimal amount in atomic units, got ${JSON.stringify(value)}`);
  }
  return value;
}
