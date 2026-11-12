/**
 * Tier and platform tables.
 *
 * The tier table is parsed early because warm-pool placement names a tier;
 * platform limits are parsed later, where the original loader read them. Both
 * come from `@x402s/shared/payment` so the API and the controller agree on
 * what a tier means.
 */
import { loadPlatformLimits, loadTiers, type TierTable } from "@x402s/shared/payment";
import type { ControllerConfig } from "./types.js";

type LimitTables = Pick<ControllerConfig, "tiers" | "platformLimits">;

export function parseTierTable(env: NodeJS.ProcessEnv): TierTable {
  return loadTiers(env);
}

export function parseLimitTables(env: NodeJS.ProcessEnv, tiers: TierTable): LimitTables {
  return {
    tiers,
    platformLimits: loadPlatformLimits(env),
  };
}
