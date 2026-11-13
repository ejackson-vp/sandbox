/**
 * Kubernetes and execution mode.
 *
 * `kubeEnabled` is parsed before the guest image because a real cluster
 * deployment must pin the image by digest independently of the
 * payment/attestation dev switch. Leader election follows from it: a Lease
 * needs an API server, and without one this process is the only writer by
 * construction.
 *
 * This module also owns the one check that turns `EXECUTION_MODE=kata` from a
 * label into a fact: `verifyRuntimeClass` reads the RuntimeClass named by
 * `RUNTIME_CLASS` and refuses to start unless its handler is a microVM one.
 */
import { hostname } from "node:os";
import * as k8s from "@kubernetes/client-node";
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

interface ClusterFlags {
  kubeEnabled: boolean;
  leaderElection: boolean;
}

type ExecutionSettings = Pick<
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

/** The RuntimeClass every sandbox and warm pod is scheduled with. */
export const DEFAULT_RUNTIME_CLASS = "x402-sandbox";

/**
 * Handlers that put the sandbox in its own guest kernel.
 *
 * This is an allowlist, not a denylist: a new handler is a decision someone
 * makes here, never a name that inherits trust because it was not recognised.
 * The defaults are the names the supported distributions register (`kata` is
 * the Cloud Hypervisor handler on Talos, `kata-qemu` the QEMU one, `kata-clh`
 * what the Confidential Containers chart installs). An operator whose
 * distribution uses a different name sets `KATA_RUNTIME_HANDLERS`.
 */
export const DEFAULT_MICROVM_HANDLERS = ["kata", "kata-qemu", "kata-clh"];

/**
 * Accepted handlers, from `KATA_RUNTIME_HANDLERS` when set.
 *
 * A malformed value throws instead of falling back to the defaults: an operator
 * who typed a list and got it wrong would otherwise be told the deployment is
 * safe because the defaults still matched.
 */
export function parseMicrovmHandlers(env: NodeJS.ProcessEnv): string[] {
  const raw = (env.KATA_RUNTIME_HANDLERS ?? "").trim();
  if (raw === "") return [...DEFAULT_MICROVM_HANDLERS];
  const handlers = raw
    .split(",")
    .map((handler) => handler.trim())
    .filter((handler) => handler !== "");
  if (handlers.length === 0) {
    throw new Error(
      "KATA_RUNTIME_HANDLERS is set but lists no handler; " +
        "expected a comma-separated list such as kata,kata-qemu",
    );
  }
  return handlers;
}

/**
 * What the API server said about the RuntimeClass, or why nothing was asked.
 *
 * `handler` is null when the check did not apply (`EXECUTION_MODE=dev` or
 * `KUBERNETES_ENABLED=false`), which is not a claim about isolation: it is the
 * local-development path where no RuntimeClass is consulted at all.
 */
export interface RuntimeClassCheck {
  enforced: boolean;
  runtimeClass: string;
  handler: string | null;
  allowed: string[];
}

export interface RuntimeClassCheckOptions {
  executionMode: string;
  runtimeClass: string;
  kubeEnabled: boolean;
  /** Defaults to `process.env`; injected so tests can set the allowlist. */
  env?: NodeJS.ProcessEnv;
  /** Injected by tests (the fake apiserver) and by the process (default config). */
  kubeConfig?: k8s.KubeConfig;
}

function handlerRefusal(runtimeClass: string, handler: string, allowed: string[]): string {
  return (
    `refusing to start: RuntimeClass "${runtimeClass}" uses handler ` +
    `"${handler || "<none>"}", which is not a microVM handler. EXECUTION_MODE=kata ` +
    `claims a separate guest kernel per sandbox, and this cluster would run the ` +
    `guest on the host kernel instead. Accepted handlers: ${allowed.join(", ")}. ` +
    `Fix: install Kata on the nodes and point RUNTIME_CLASS at the RuntimeClass it ` +
    `registers (kubectl get runtimeclass), or add this handler to ` +
    `KATA_RUNTIME_HANDLERS if it really is a microVM runtime. For a run with no ` +
    `isolation claim, set EXECUTION_MODE=dev and KUBERNETES_ENABLED=false.`
  );
}

function readRefusal(runtimeClass: string, reason: string): string {
  return (
    `refusing to start: could not read RuntimeClass "${runtimeClass}" from the API ` +
    `server (${reason}). EXECUTION_MODE=kata needs the handler verified before the ` +
    `first sandbox exists, so a missing object or a denied read blocks the process ` +
    `rather than silently scheduling guests with an unchecked runtime. Fix: apply ` +
    `the overlay that creates it (kubectl apply -k deploy/kata or deploy/talos) and ` +
    `grant the controller get on node.k8s.io/runtimeclasses, then restart.`
  );
}

/**
 * Read the RuntimeClass and refuse a handler that is not a microVM one.
 *
 * Fail closed on every path: a read error, a missing object and an empty or
 * unrecognised handler are all startup errors. The failure this prevents is
 * silent, not loud: a drifted overlay leaves the ControllerConfig saying `kata`
 * while the pods run under `runc`, and every downstream claim about a guest
 * kernel is then false. The check is skipped only where there is nothing to
 * check, `EXECUTION_MODE=dev` or no Kubernetes API.
 */
export async function verifyRuntimeClass(
  opts: RuntimeClassCheckOptions,
): Promise<RuntimeClassCheck> {
  const env = opts.env ?? process.env;
  const allowed = parseMicrovmHandlers(env);
  const enforced = opts.kubeEnabled && opts.executionMode === "kata";
  if (!enforced) {
    return { enforced: false, runtimeClass: opts.runtimeClass, handler: null, allowed };
  }

  const kc = opts.kubeConfig ?? new k8s.KubeConfig();
  if (!opts.kubeConfig) kc.loadFromDefault();
  const api = kc.makeApiClient(k8s.NodeV1Api);

  let resource: k8s.V1RuntimeClass;
  try {
    resource = await api.readRuntimeClass({ name: opts.runtimeClass });
  } catch (error) {
    throw new Error(readRefusal(opts.runtimeClass, reasonOf(error)));
  }

  const handler = (resource.handler ?? "").trim();
  if (!allowed.includes(handler)) {
    throw new Error(handlerRefusal(opts.runtimeClass, handler, allowed));
  }
  return { enforced: true, runtimeClass: opts.runtimeClass, handler, allowed };
}

/** An apiserver refusal carries its HTTP status; anything else carries a message. */
function reasonOf(error: unknown): string {
  const status = (error as { code?: number }).code;
  if (typeof status === "number") return `HTTP ${status}`;
  const message = (error as { message?: string }).message;
  return message ? message : "unknown error";
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

  const runtimeClass = env.RUNTIME_CLASS ?? DEFAULT_RUNTIME_CLASS;
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

type KubernetesSettings = Pick<
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
