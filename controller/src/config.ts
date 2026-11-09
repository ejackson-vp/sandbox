import {
  loadPlatformLimits,
  loadTiers,
  type PlatformLimits,
  type TierTable,
  envBool as bool,
  envInt as int,
} from "@x402s/shared";
import { KubeProvisioner, NullProvisioner, type Provisioner } from "./k8s.js";
import { LocalProvisioner } from "./local-provisioner.js";
import { RelayClient } from "./relay-client.js";
import { mintProxyToken } from "./tokens.js";

export type Role = "controller" | "relay" | "proxy" | "all";

export interface ControllerConfig {
  role: Role;
  controllerPort: number;
  /** Optional HTTPS listener for the API; a client cert with CN=api is required. */
  tlsPort?: number;
  tlsCertFile?: string;
  tlsKeyFile?: string;
  tlsCaFile?: string;
  relayPort: number;
  proxyPort: number;
  adminToken: string;
  relayAdminToken: string;
  /** Low-privilege token the relay uses to nudge the reconciler. */
  wakeToken: string;
  controllerUrl: string;
  proxyTokenSecret: string;
  dbPath: string;
  sandboxNamespace: string;
  controlNamespace: string;
  guestImageDigest: string;
  /** Image reference actually used in the pod spec: `repo@sha256:…` when pinned. */
  guestImageRef: string;
  runtimeClass: string;
  executionMode: "dev" | "kata";
  allowInsecureDev: boolean;
  kubeEnabled: boolean;
  relayEnabled: boolean;
  proxyEnabled: boolean;
  relayBaseUrl: string;
  relayServiceName: string;
  proxyServiceName: string;
  workspaceDir: string;
  provisioningTimeoutMs: number;
  leaseGraceMs: number;
  reconcileIntervalMs: number;
  maxPodAgeMs: number;
  relayResponseWaitMs: number;
  allowedPorts: number[];
  allowedHostSuffixes: string[];
  deniedCidrs: string[];
  tiers: TierTable;
  platformLimits: PlatformLimits;
  /** Pre-booted, unleased sandboxes kept ready for fast claims (0 = off). */
  warmPoolSize: number;
  warmPoolTier: keyof TierTable;
  warmPoolTtlMs: number;
  warmClaimTimeoutMs: number;
  /** Pin a resumed checkpoint to the node that owns its local-path PVC. */
  pinCheckpointNode: boolean;
  /** 0 = unlimited; otherwise the number of concurrent cold provisions. */
  maxConcurrentProvisioning: number;
  /** 0 = no queue timeout; otherwise fail a PAID session after this wait. */
  provisionQueueTimeoutMs: number;
  /** Capacity admission is on by default; disable only for local debugging. */
  capacityEnabled: boolean;
  /** baseline = guarantee requests; peak = reserve limits (no overcommit). */
  capacityAccounting: "baseline" | "peak";
  /** Provisional payment hold lifetime. */
  capacityHoldTtlMs: number;
  /** Per-node headroom withheld from sandboxes for system workloads. */
  capacityPlatformOverhead: { cpuMillicores: number; memoryMiB: number; storageMiB: number };
  /** Optional test/demo ceilings; 0 means use the node's allocatable values. */
  capacityNodeCpuOverrideMillis: number;
  capacityNodeMemoryOverrideMiB: number;
}

/**
 * Fail-closed configuration validation.
 */
function parseRole(env: NodeJS.ProcessEnv): Role {
  const role = (env.ROLE ?? "controller") as Role;
  if (!["controller", "relay", "proxy", "all"].includes(role)) {
    throw new Error(`invalid ROLE ${role}`);
  }
  return role;
}

function parseExecution(env: NodeJS.ProcessEnv): Pick<ControllerConfig, "executionMode" | "runtimeClass" | "allowInsecureDev" | "guestImageDigest" | "guestImageRef"> {
  const executionMode = (env.EXECUTION_MODE ?? "dev") as "dev" | "kata";
  if (!["dev", "kata"].includes(executionMode)) {
    throw new Error(`invalid EXECUTION_MODE ${executionMode}`);
  }

  const runtimeClass = env.RUNTIME_CLASS ?? "x402-sandbox";
  // Gates guest-image digest enforcement only; no execution mode is
  // hardware-backed, so there is nothing else to acknowledge.
  const allowInsecureDev = bool(env.ALLOW_INSECURE_DEV, true);

  const PINNED_DIGEST = /^sha256:[0-9a-f]{64}$/;
  const guestImage = env.GUEST_IMAGE ?? "x402-sandbox/guest:dev";
  const guestImageDigest = env.GUEST_IMAGE_DIGEST ?? "sha256:unpinned-dev-image";
  const devPlaceholder = /^sha256:(dev-)?unpinned/.test(guestImageDigest);
  if (!devPlaceholder && !PINNED_DIGEST.test(guestImageDigest)) {
    throw new Error("GUEST_IMAGE_DIGEST must be sha256:<64 hex> or the dev placeholder");
  }
  if (!allowInsecureDev && !PINNED_DIGEST.test(guestImageDigest)) {
    throw new Error(
      "GUEST_IMAGE_DIGEST must be a pinned sha256 digest when ALLOW_INSECURE_DEV is false",
    );
  }

  // Pull by digest whenever one is configured, dev mode or not. ALLOW_INSECURE_DEV
  // decides whether a digest is *required*; it must not decide whether a
  // configured digest is honoured. Honouring it is what stops a moved tag — or a
  // compromised controller — from changing the image running inside the VM.
  const guestImageRef = PINNED_DIGEST.test(guestImageDigest)
    ? `${guestImage.replace(/:[^/:]+$/, "")}@${guestImageDigest}`
    : guestImage;
  return { executionMode, runtimeClass, allowInsecureDev, guestImageDigest, guestImageRef };
}

function parseTls(env: NodeJS.ProcessEnv): Pick<ControllerConfig, "tlsPort" | "tlsCertFile" | "tlsKeyFile" | "tlsCaFile"> | Record<string, never> {
  const tlsPortRaw = env.CONTROLLER_TLS_PORT ?? "0";
  const tlsPortNum = Number(tlsPortRaw);
  const tlsPort =
    Number.isInteger(tlsPortNum) && tlsPortNum > 0 && tlsPortNum <= 65535 ? tlsPortNum : undefined;
  if (tlsPortRaw !== "0" && !tlsPort) throw new Error(`invalid CONTROLLER_TLS_PORT ${tlsPortRaw}`);
  const tlsFiles = [env.TLS_CERT_FILE, env.TLS_KEY_FILE, env.TLS_CA_FILE];
  if (tlsPort && tlsFiles.some((v) => !v)) {
    throw new Error("CONTROLLER_TLS_PORT requires TLS_CERT_FILE, TLS_KEY_FILE and TLS_CA_FILE");
  }
  if (!tlsPort && tlsFiles.some(Boolean)) {
    throw new Error("TLS_CERT_FILE/TLS_KEY_FILE/TLS_CA_FILE require CONTROLLER_TLS_PORT");
  }
  const tls =
    tlsPort && env.TLS_CERT_FILE && env.TLS_KEY_FILE && env.TLS_CA_FILE
      ? {
          tlsPort,
          tlsCertFile: env.TLS_CERT_FILE,
          tlsKeyFile: env.TLS_KEY_FILE,
          tlsCaFile: env.TLS_CA_FILE,
        }
      : {};
  return tls;
}

function parseTokens(env: NodeJS.ProcessEnv, role: Role, adminToken: string): Pick<ControllerConfig, "relayAdminToken" | "wakeToken" | "proxyTokenSecret"> {
  const requireDistinctToken = (name: string, value: string | undefined): string => {
    if (!value || value.length < 16) {
      throw new Error(`${name} must be set (>=16 chars) and must not reuse ADMIN_TOKEN`);
    }
    if (value === adminToken) {
      throw new Error(`${name} must differ from ADMIN_TOKEN (key separation)`);
    }
    return value;
  };
  const needsRelayTokens = role === "all" || role === "controller" || role === "relay";
  const needsProxyToken = role === "all" || role === "controller" || role === "proxy";
  const relayAdminToken = needsRelayTokens
    ? requireDistinctToken("RELAY_ADMIN_TOKEN", env.RELAY_ADMIN_TOKEN)
    : (env.RELAY_ADMIN_TOKEN ?? "");
  const wakeToken = needsRelayTokens
    ? requireDistinctToken("WAKE_TOKEN", env.WAKE_TOKEN)
    : (env.WAKE_TOKEN ?? "");
  const proxyTokenSecret = needsProxyToken
    ? requireDistinctToken("PROXY_TOKEN_SECRET", env.PROXY_TOKEN_SECRET)
    : (env.PROXY_TOKEN_SECRET ?? "");
  return { relayAdminToken, wakeToken, proxyTokenSecret };
}

export function loadControllerConfig(env: NodeJS.ProcessEnv = process.env): ControllerConfig {
  const role = parseRole(env);

  const execution = parseExecution(env);
  const adminToken = env.ADMIN_TOKEN ?? "";
  if (["controller", "all"].includes(role) && adminToken.length < 16) {
    throw new Error("ADMIN_TOKEN must be set (>=16 chars) for controller roles");
  }

  const tiers = loadTiers(env);
  const warmPoolSize = int(env.WARM_POOL_SIZE, 0, 0, 50);
  const warmPoolTier = (env.WARM_POOL_TIER ?? "short") as keyof TierTable;
  if (!(warmPoolTier in tiers)) {
    throw new Error(`invalid WARM_POOL_TIER ${String(warmPoolTier)}`);
  }
  const tls = parseTls(env);
  const tokens = parseTokens(env, role, adminToken);

  return {
    role,
    controllerPort: int(env.X402_CONTROLLER_PORT ?? env.CONTROLLER_PORT, 3001, 1, 65535),
    ...tls,
    relayPort: int(env.X402_RELAY_PORT ?? env.RELAY_PORT, 8443, 1, 65535),
    proxyPort: int(env.X402_PROXY_PORT ?? env.PROXY_PORT, 3128, 1, 65535),
    adminToken,
    ...tokens,
    controllerUrl: env.CONTROLLER_URL ?? "http://127.0.0.1:3001",
    dbPath: env.DB_PATH ?? "/data/controller.db",
    sandboxNamespace: env.SANDBOX_NAMESPACE ?? "sandbox-workloads",
    controlNamespace: env.CONTROL_NAMESPACE ?? "sandbox-system",
    ...execution,
    kubeEnabled: bool(env.KUBERNETES_ENABLED, true),
    relayEnabled: bool(env.RELAY_ENABLED, role === "all" || role === "relay"),
    proxyEnabled: bool(env.PROXY_ENABLED, role === "all" || role === "proxy"),
    relayBaseUrl: env.RELAY_URL ?? "http://127.0.0.1:8443",
    relayServiceName: env.RELAY_SERVICE_NAME ?? "relay",
    proxyServiceName: env.PROXY_SERVICE_NAME ?? "egress-proxy",
    workspaceDir: env.WORKSPACE_DIR ?? "/workspace",
    provisioningTimeoutMs: int(env.PROVISIONING_TIMEOUT_MS, 90_000, 10_000, 600_000),
    leaseGraceMs: int(env.LEASE_GRACE_MS, 2_000, 0, 60_000),
    reconcileIntervalMs: int(env.RECONCILE_INTERVAL_MS, 250, 50, 10_000),
    maxPodAgeMs: int(env.MAX_POD_AGE_MS, 3_600_000, 120_000, 7_200_000),
    relayResponseWaitMs: int(env.RELAY_RESPONSE_WAIT_MS, 25_000, 0, 120_000),
    allowedPorts: (env.EGRESS_ALLOWED_PORTS ?? "443").split(",").map((p) => Number(p.trim())).filter((n) => Number.isInteger(n)),
    allowedHostSuffixes: (env.EGRESS_ALLOWED_HOST_SUFFIXES ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    deniedCidrs: (env.EGRESS_DENIED_CIDRS ?? "10.244.0.0/16,10.96.0.0/12")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    tiers,
    platformLimits: loadPlatformLimits(env),
    warmPoolSize,
    warmPoolTier,
    warmPoolTtlMs: int(env.WARM_POOL_TTL_MS, 300_000, 30_000, 3_600_000),
    warmClaimTimeoutMs: int(env.WARM_CLAIM_TIMEOUT_MS, 8_000, 1_000, 60_000),
    pinCheckpointNode: bool(env.PIN_CHECKPOINT_NODE, true),
    maxConcurrentProvisioning: int(env.MAX_CONCURRENT_PROVISIONING, 0, 0, 1_000),
    provisionQueueTimeoutMs: int(env.PROVISION_QUEUE_TIMEOUT_MS, 120_000, 0, 3_600_000),
    capacityEnabled: bool(env.CAPACITY_ENABLED, true),
    capacityAccounting: (() => {
      const mode = env.CAPACITY_ACCOUNTING ?? "baseline";
      if (mode !== "baseline" && mode !== "peak") {
        throw new Error(`invalid CAPACITY_ACCOUNTING ${mode}`);
      }
      return mode;
    })(),
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

export function makeProvisioner(cfg: ControllerConfig): Provisioner {
  if (cfg.kubeEnabled) return new KubeProvisioner(cfg.sandboxNamespace, cfg.controlNamespace);
  const binary = process.env.GUEST_BINARY;
  if (!binary) return new NullProvisioner();
  // Local process mode: real guest, no Kubernetes isolation.
  const relay = new URL(cfg.relayBaseUrl);
  const proxy = new URL(process.env.LOCAL_PROXY_URL ?? "http://127.0.0.1:3128");
  return new LocalProvisioner({
    binary,
    relayHost: relay.hostname,
    relayPort: Number(relay.port || 80),
    proxyHost: proxy.hostname,
    proxyPort: Number(proxy.port || 80),
    ...(process.env.LOCAL_WORK_ROOT ? { workRoot: process.env.LOCAL_WORK_ROOT } : {}),
  });
}

export function makeRelayClient(cfg: ControllerConfig): RelayClient {
  return new RelayClient({ baseUrl: cfg.relayBaseUrl, adminToken: cfg.relayAdminToken });
}

export function proxyTokenFor(cfg: ControllerConfig, sessionId: string): string {
  return mintProxyToken(cfg.proxyTokenSecret, sessionId, 60 * 60_000);
}
