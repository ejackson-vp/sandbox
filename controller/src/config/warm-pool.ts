/**
 * Warm pool: pre-booted sandboxes and how they grow and drain.
 *
 * The allocation (size, base share, tier) is parsed early because the tier has
 * to exist before anything is placed. The tuning (growth step, cooldown, idle
 * drain, demand window, TTL, claim timeout) is parsed with the rest of the
 * scheduler settings. Splitting the two is what keeps each parser small; the
 * order of the calls in `loadControllerConfig` is what keeps startup failures
 * in the same order as before.
 */
import { envInt as int } from "@x402s/shared/env";
import type { TierTable } from "@x402s/shared/payment";
import type { ControllerConfig } from "./types.js";

export interface WarmPoolAllocation {
  warmPoolSize: number;
  warmPoolBaseMin: number;
  warmPoolTier: keyof TierTable;
}

export type WarmPoolSettings = Pick<
  ControllerConfig,
  | "warmPoolSize"
  | "warmPoolBaseMin"
  | "warmPoolGrowthStep"
  | "warmPoolCooldownMs"
  | "warmPoolIdleDrainMs"
  | "warmPoolDemandWindowMs"
  | "warmPoolTier"
  | "warmPoolTtlMs"
  | "warmClaimTimeoutMs"
>;

export function parseWarmPoolAllocation(
  env: NodeJS.ProcessEnv,
  tiers: TierTable,
): WarmPoolAllocation {
  const warmPoolSize = int(env.WARM_POOL_SIZE, 0, 0, 50);
  const warmPoolBaseMin = int(env.WARM_POOL_BASE_MIN, warmPoolSize, 0, 50);
  if (warmPoolBaseMin > warmPoolSize) {
    throw new Error(`WARM_POOL_BASE_MIN (${warmPoolBaseMin}) must not exceed WARM_POOL_SIZE (${warmPoolSize})`);
  }
  const warmPoolTier = (env.WARM_POOL_TIER ?? "short") as keyof TierTable;
  if (!(warmPoolTier in tiers)) {
    throw new Error(`invalid WARM_POOL_TIER ${String(warmPoolTier)}`);
  }
  return { warmPoolSize, warmPoolBaseMin, warmPoolTier };
}

export function parseWarmPool(
  env: NodeJS.ProcessEnv,
  allocation: WarmPoolAllocation,
): WarmPoolSettings {
  return {
    warmPoolSize: allocation.warmPoolSize,
    warmPoolBaseMin: allocation.warmPoolBaseMin,
    warmPoolGrowthStep: int(env.WARM_POOL_GROWTH_STEP, 1, 1, 10),
    warmPoolCooldownMs: int(env.WARM_POOL_COOLDOWN_MS, 15_000, 0, 600_000),
    warmPoolIdleDrainMs: int(env.WARM_POOL_IDLE_DRAIN_MS, 60_000, 0, 3_600_000),
    warmPoolDemandWindowMs: int(env.WARM_POOL_DEMAND_WINDOW_MS, 120_000, 1_000, 3_600_000),
    warmPoolTier: allocation.warmPoolTier,
    warmPoolTtlMs: int(env.WARM_POOL_TTL_MS, 300_000, 30_000, 3_600_000),
    warmClaimTimeoutMs: int(env.WARM_CLAIM_TIMEOUT_MS, 8_000, 1_000, 60_000),
  };
}
