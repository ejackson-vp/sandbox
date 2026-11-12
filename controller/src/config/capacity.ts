/**
 * Capacity admission.
 *
 * Off-switch, accounting mode, hold lifetime and the per-node overhead the
 * scheduler withholds for system workloads. Admission itself lives in
 * `controller/src/capacity/`; this module only parses the knobs.
 */
import { envBool as bool, envInt as int } from "@x402s/shared/env";
import type { ControllerConfig } from "./types.js";

export type CapacitySettings = Pick<
  ControllerConfig,
  | "capacityEnabled"
  | "capacityAccounting"
  | "capacityHoldTtlMs"
  | "capacityPlatformOverhead"
  | "capacityNodeCpuOverrideMillis"
  | "capacityNodeMemoryOverrideMiB"
>;

function parseCapacityAccounting(env: NodeJS.ProcessEnv): "baseline" | "peak" {
  const mode = env.CAPACITY_ACCOUNTING ?? "baseline";
  if (mode !== "baseline" && mode !== "peak") {
    throw new Error(`invalid CAPACITY_ACCOUNTING ${mode}`);
  }
  return mode;
}

export function parseCapacity(env: NodeJS.ProcessEnv): CapacitySettings {
  return {
    capacityEnabled: bool(env.CAPACITY_ENABLED, true),
    capacityAccounting: parseCapacityAccounting(env),
    capacityHoldTtlMs: int(env.CAPACITY_HOLD_TTL_MS, 120_000, 5_000, 900_000),
    capacityPlatformOverhead: {
      cpuMillicores: int(env.CAPACITY_PLATFORM_OVERHEAD_CPU_MILLICORES, 250, 0, 64_000),
      memoryMiB: int(env.CAPACITY_PLATFORM_OVERHEAD_MEMORY_MIB, 256, 0, 1_048_576),
      storageMiB: int(env.CAPACITY_PLATFORM_OVERHEAD_STORAGE_MIB, 1_024, 0, 1_048_576),
    },
    capacityNodeCpuOverrideMillis: int(env.CAPACITY_NODE_CPU_MILLICORES, 0, 0, 1_000_000),
    capacityNodeMemoryOverrideMiB: int(env.CAPACITY_NODE_MEMORY_MIB, 0, 0, 1_048_576),
  };
}
