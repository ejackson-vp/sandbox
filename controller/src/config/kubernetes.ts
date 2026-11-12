/**
 * Kubernetes and execution mode.
 *
 * `kubeEnabled` is parsed before the guest image because a real cluster
 * deployment must pin the image by digest independently of the
 * payment/attestation dev switch. Leader election follows from it: a Lease
 * needs an API server, and without one this process is the only writer by
 * construction.
 */
import { hostname } from "node:os";
import {
  assertDigestAllowed,
  DEFAULT_GUEST_IMAGE,
  imageRefFor,
  parseRuntimeProfiles,
  type RuntimeProfileCatalog,
} from "../runtime-profiles.js";
import { envBool as bool } from "@x402s/shared/env";
import type { Role } from "./role.js";
import type { ControllerConfig } from "./types.js";

export interface ClusterFlags {
  kubeEnabled: boolean;
  leaderElection: boolean;
}

export type ExecutionSettings = Pick<
  ControllerConfig,
  "executionMode" | "runtimeClass" | "allowInsecureDev" | "guestImageDigest" | "guestImageRef"
>;

export function parseClusterFlags(env: NodeJS.ProcessEnv): ClusterFlags {
  const kubeEnabled = bool(env.KUBERNETES_ENABLED, true);
  // Leader election needs an API server to hold the Lease. Without one this
  // process is the only writer by construction, so it runs solo.
  const leaderElection = kubeEnabled && bool(env.LEADER_ELECTION, true);
  return { kubeEnabled, leaderElection };
}

export function parseExecution(
  env: NodeJS.ProcessEnv,
  kubeEnabled: boolean,
  role: Role,
): ExecutionSettings {
  const executionMode = (env.EXECUTION_MODE ?? "dev") as "dev" | "kata";
  if (!["dev", "kata"].includes(executionMode)) {
    throw new Error(`invalid EXECUTION_MODE ${executionMode}`);
  }

  const runtimeClass = env.RUNTIME_CLASS ?? "x402-sandbox";
  // Gates guest-image digest enforcement only; no execution mode is
  // hardware-backed, so there is nothing else to acknowledge.
  const allowInsecureDev = bool(env.ALLOW_INSECURE_DEV, true);

  const guestImage = env.GUEST_IMAGE ?? DEFAULT_GUEST_IMAGE;
  const guestImageDigest = env.GUEST_IMAGE_DIGEST ?? "sha256:unpinned-dev-image";
  assertDigestAllowed("GUEST_IMAGE_DIGEST", guestImageDigest, { kubeEnabled, role, allowInsecureDev });

  const guestImageRef = imageRefFor(guestImage, guestImageDigest);
  return { executionMode, runtimeClass, allowInsecureDev, guestImageDigest, guestImageRef };
}

export function parseRuntimeProfilesFor(
  env: NodeJS.ProcessEnv,
  execution: ExecutionSettings,
  cluster: ClusterFlags,
  role: Role,
): RuntimeProfileCatalog {
  return parseRuntimeProfiles(
    env,
    {
      image: env.GUEST_IMAGE ?? DEFAULT_GUEST_IMAGE,
      digest: execution.guestImageDigest,
      imageRef: execution.guestImageRef,
    },
    {
      kubeEnabled: cluster.kubeEnabled,
      role,
      allowInsecureDev: execution.allowInsecureDev,
    },
  );
}

export type KubernetesSettings = Pick<
  ControllerConfig,
  | "sandboxNamespace"
  | "controlNamespace"
  | "executionMode"
  | "runtimeClass"
  | "allowInsecureDev"
  | "guestImageDigest"
  | "guestImageRef"
  | "runtimeProfiles"
  | "kubeEnabled"
  | "leaderElection"
  | "leaderIdentity"
  | "leaderLeaseName"
>;

export function parseKubernetes(
  env: NodeJS.ProcessEnv,
  cluster: ClusterFlags,
  execution: ExecutionSettings,
  runtimeProfiles: RuntimeProfileCatalog,
): KubernetesSettings {
  return {
    sandboxNamespace: env.SANDBOX_NAMESPACE ?? "sandbox-workloads",
    controlNamespace: env.CONTROL_NAMESPACE ?? "sandbox-system",
    ...execution,
    runtimeProfiles,
    kubeEnabled: cluster.kubeEnabled,
    leaderElection: cluster.leaderElection,
    leaderIdentity: env.POD_NAME?.trim() || hostname(),
    leaderLeaseName: env.LEADER_LEASE_NAME ?? "controller-leader",
  };
}
