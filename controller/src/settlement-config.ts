/**
 * Settlement, refund and budget configuration (#31, #48).
 *
 * Split out of `config.ts` for reviewability. Two rules are worth stating here
 * because they are easy to get wrong:
 *
 *  - every refund path is opt-in. An empty `REFUND_WEBHOOK_URL` means no
 *    automatic transfer of funds, and the controller holds no signing key;
 *  - an amount is kept as a decimal string. USDC has 6 decimals, but a tier is
 *    operator-configurable and 30 digits is the schema limit, so a JS number
 *    would be the wrong type for money.
 */
import { envBool as bool, envInt as int } from "@x402s/shared/env";
import type { PaymentMode } from "@x402s/shared/protocol";

interface SettlementConfig {
  paymentMode: PaymentMode;
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
 * Settlement reconciliation and refund execution (#31). All of it is opt-in by
 * configuration: no webhook means no automatic transfer of funds.
 */
export function parseSettlement(
  env: NodeJS.ProcessEnv,
): SettlementConfig {
  const paymentMode = (env.PAYMENT_MODE ?? "mock") as PaymentMode;
  if (paymentMode !== "mock" && paymentMode !== "testnet" && paymentMode !== "mainnet") {
    throw new Error(`PAYMENT_MODE must be "mock", "testnet" or "mainnet", got ${paymentMode}`);
  }
  const refundWebhookUrl = env.REFUND_WEBHOOK_URL ?? "";
  if (refundWebhookUrl && !/^https?:\/\//.test(refundWebhookUrl)) {
    throw new Error("REFUND_WEBHOOK_URL must be an absolute http(s) URL");
  }
  return {
    paymentMode,
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

