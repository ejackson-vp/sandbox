/**
 * Payment admission: challenge nonces and the durable create budget (#47,
 * #48).
 *
 * The durable budget is the backstop behind the in-memory buckets, so its
 * defaults are looser than `CREATE_RATE_BURST` (30/1s): roughly two creates a
 * minute sustained per payer, and a global ceiling that a rotating `from`
 * cannot escape.
 *
 * Settlement and refund settings live next to this in
 * `settlement-config.ts`; they are a separate section because refunds are
 * opt-in and hold no signing authority.
 */
import { envInt as int } from "@x402s/shared/env";
import { atomicAmount } from "../settlement-config.js";
import type { ControllerConfig } from "./types.js";

export type PaymentLimitSettings = Pick<
  ControllerConfig,
  | "challengeNonceTtlMs"
  | "challengeNonceMaxActive"
  | "budgetWindowMs"
  | "payerCreatesPerWindow"
  | "payerSpendPerWindow"
  | "payerConcurrentSessions"
  | "globalCreatesPerWindow"
  | "globalConcurrentSessions"
>;

export function parsePaymentLimits(env: NodeJS.ProcessEnv): PaymentLimitSettings {
  return {
    // Long enough for a human-speed wallet signature, short enough that a
    // captured challenge is worthless by the time a log is read.
    challengeNonceTtlMs: int(env.CHALLENGE_NONCE_TTL_MS, 180_000, 10_000, 900_000),
    challengeNonceMaxActive: int(env.CHALLENGE_NONCE_MAX_ACTIVE, 20_000, 0, 1_000_000),
    budgetWindowMs: int(env.BUDGET_WINDOW_MS, 3_600_000, 60_000, 86_400_000),
    payerCreatesPerWindow: int(env.PAYER_CREATES_PER_WINDOW, 60, 1, 1_000_000),
    payerSpendPerWindow: atomicAmount(env.PAYER_SPEND_PER_WINDOW, "50000000"),
    payerConcurrentSessions: int(env.PAYER_CONCURRENT_SESSIONS, 4, 0, 1_000),
    globalCreatesPerWindow: int(env.GLOBAL_CREATES_PER_WINDOW, 2_000, 1, 10_000_000),
    globalConcurrentSessions: int(env.GLOBAL_CONCURRENT_SESSIONS, 200, 0, 100_000),
  };
}
