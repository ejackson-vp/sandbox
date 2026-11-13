/**
 * Provisioning, reconciliation and the workspace.
 *
 * Everything here bounds how long one operation may take or how many may run
 * at once. The defaults are the contracts the tests pin: 90 s to provision,
 * 250 ms ticks, 8 sessions per phase, and a 25 s relay response window.
 */
import { envBool as bool, envInt as int } from "@x402s/shared/env";
import type { ControllerConfig } from "./types.js";

type ProvisioningSettings = Pick<
  ControllerConfig,
  | "workspaceDir"
  | "provisioningTimeoutMs"
  | "relayRegistrationTimeoutMs"
  | "relayLossGraceMs"
  | "leaseGraceMs"
  | "reconcileIntervalMs"
  | "reconcileConcurrency"
  | "reconcileBudget"
  | "maxPodAgeMs"
  | "relayResponseWaitMs"
>;

type ProvisioningLimitSettings = Pick<
  ControllerConfig,
  | "pinCheckpointNode"
  | "orphanPvcGraceMs"
  | "maxConcurrentProvisioning"
  | "provisionQueueTimeoutMs"
>;

export function parseProvisioning(env: NodeJS.ProcessEnv): ProvisioningSettings {
  return {
    workspaceDir: env.WORKSPACE_DIR ?? "/workspace",
    provisioningTimeoutMs: int(env.PROVISIONING_TIMEOUT_MS, 90_000, 10_000, 600_000),
    relayRegistrationTimeoutMs: int(env.RELAY_REGISTRATION_TIMEOUT_MS, 5_000, 500, 60_000),
    relayLossGraceMs: int(env.RELAY_LOSS_GRACE_MS, 90_000, 1_000, 600_000),
    leaseGraceMs: int(env.LEASE_GRACE_MS, 2_000, 0, 60_000),
    reconcileIntervalMs: int(env.RECONCILE_INTERVAL_MS, 250, 50, 10_000),
    reconcileConcurrency: int(env.RECONCILE_CONCURRENCY, 8, 1, 256),
    // Upper bound keeps one pass from enqueuing an unbounded batch; lower
    // bound keeps the loop making progress (a budget of 0 would starve).
    reconcileBudget: int(env.RECONCILE_BUDGET, 1_000, 1, 10_000),
    maxPodAgeMs: int(env.MAX_POD_AGE_MS, 3_600_000, 120_000, 7_200_000),
    relayResponseWaitMs: int(env.RELAY_RESPONSE_WAIT_MS, 25_000, 0, 120_000),
  };
}

/**
 * Kept separate from `parseProvisioning` so startup still refuses a bad
 * concurrency limit after the warm-pool settings, which is the order the
 * loader used before the split.
 */
export function parseProvisioningLimits(
  env: NodeJS.ProcessEnv,
): ProvisioningLimitSettings {
  return {
    pinCheckpointNode: bool(env.PIN_CHECKPOINT_NODE, true),
    orphanPvcGraceMs: int(env.ORPHAN_PVC_GRACE_MS, 3_600_000, 60_000, 86_400_000),
    maxConcurrentProvisioning: int(env.MAX_CONCURRENT_PROVISIONING, 0, 0, 1_000),
    provisionQueueTimeoutMs: int(env.PROVISION_QUEUE_TIMEOUT_MS, 120_000, 0, 3_600_000),
  };
}
