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
import { RelayClient, type RelayClientTlsOptions } from "./relay-client.js";
import type { RelayTlsOptions } from "./relay.js";
import { mintProxyToken } from "./tokens.js";
import { shardClaim } from "./data-plane-shard.js";
import { parseBackupKey } from "./backup-key.js";

export type Role = "controller" | "relay" | "proxy" | "all";

export interface ControllerConfig {
  role: Role;
  controllerPort: number;
  /** Private scrape listener. 0 disables it (tests / non-Kubernetes runs). */
  metricsPort: number;
  metricsHost: string;
  /** Optional HTTPS listener for the API; a client cert with CN=api is required. */
  tlsPort?: number;
  tlsCertFile?: string;
  tlsKeyFile?: string;
  tlsCaFile?: string;
  relayPort: number;
  /** mTLS listener for the controller-facing relay control routes. */
  relayControlPort: number;
  /** Server certificate/key/client CA for the relay control listener. */
  relayTls?: RelayTlsOptions;
  /** Controller client certificate/key/CA for the relay control listener. */
  relayClientTls?: RelayClientTlsOptions;
  proxyPort: number;
  adminToken: string;
  relayAdminToken: string;
  /** Low-privilege token the relay uses to nudge the reconciler. */
  wakeToken: string;
  controllerUrl: string;
  proxyTokenSecret: string;
  dbPath: string;
  /** Empty disables scheduled backups. */
  backupDir: string;
  backupIntervalMs: number;
  backupRetention: number;
  /** Required when backupDir is set; null when backups are disabled. */
  backupKey: Buffer | null;
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
  /**
   * How long one create may retry relay registration against the current
   * generation before the pass gives up (the session stays PAID and is retried
   * on the next tick).
   */
  relayRegistrationTimeoutMs: number;
  leaseGraceMs: number;
  reconcileIntervalMs: number;
  /** Max sessions reconciled in parallel per phase; 1 restores sequential passes. */
  reconcileConcurrency: number;
  /**
   * Max sessions selected for dispatch in one readiness pass. Bounds both the
   * SQL read and the work a tick can enqueue when many sessions are due.
   */
  reconcileBudget: number;
  maxPodAgeMs: number;
  relayResponseWaitMs: number;
  allowedPorts: number[];
  allowedHostSuffixes: string[];
  deniedCidrs: string[];
  egressMaxConnectionsPerSession: number;
  egressMaxGlobalConnections: number;
  tiers: TierTable;
  platformLimits: PlatformLimits;
  /** Pre-booted, unleased sandboxes kept ready for fast claims (0 = off). */
  warmPoolSize: number;
  warmPoolTier: keyof TierTable;
  warmPoolTtlMs: number;
  warmClaimTimeoutMs: number;
  /** Pin a resumed checkpoint to the node that owns its local-path PVC. */
  pinCheckpointNode: boolean;
  /**
   * Delete a workspace PVC that no session owns once it is this old. Checkpoint
   * volumes are plaintext, so this bounds the exposure window for a volume left
   * behind by a lost session row.
   */
  orphanPvcGraceMs: number;
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
  /**
   * SHA-256 hex digests of guest measurements the controller accepts on hello.
   * Empty (the default) means measurement is not pinned, matching the behaviour
   * before this option existed.
   */
  guestMeasurementAllowlist: string[];
  /**
   * Relay and proxy replica counts. Above 1, provisioning pins each session to
   * a shard-specific pod address and the credential carries the shard, so a
   * misrouted connection can be rejected instead of served.
   */
  relayReplicas: number;
  proxyReplicas: number;
  /** Pod host template for a shard; must contain `{shard}` when replicas > 1. */
  relayHostTemplate: string;
  proxyHostTemplate: string;
  /**
   * Pod ordinal of this relay/proxy process. Unset (the default) accepts any
   * shard, which is the single-replica behaviour and keeps existing tokens
   * valid.
   */
  shardIndex?: number;
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

function parseExecution(
  env: NodeJS.ProcessEnv,
  kubeEnabled: boolean,
  role: Role,
): Pick<ControllerConfig, "executionMode" | "runtimeClass" | "allowInsecureDev" | "guestImageDigest" | "guestImageRef"> {
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
  // A cluster deployment must pull an immutable image, regardless of the
  // payment/attestation dev switch. The placeholder is only meaningful for the
  // local process provisioner, where no pod spec references the tag.
  // Only the controller provisions a guest Pod. The relay, proxy and
  // facilitator share this config loader but never reference the guest image,
  // so requiring a digest there only creates a startup failure with no
  // security benefit.
  if (kubeEnabled && (role === "controller" || role === "all") && !PINNED_DIGEST.test(guestImageDigest)) {
    throw new Error(
      "GUEST_IMAGE_DIGEST must be a pinned sha256:<64 hex> digest when KUBERNETES_ENABLED is true; " +
        "the dev placeholder is only valid for the local process provisioner (KUBERNETES_ENABLED=false)",
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

/**
 * All three files must be set together or none of them. Returns undefined when
 * the feature is disabled, so callers can fail closed only where it matters.
 */
function parseTlsFiles(
  env: NodeJS.ProcessEnv,
  prefix: string,
): { certFile: string; keyFile: string; caFile: string } | undefined {
  const certFile = env[`${prefix}_CERT_FILE`];
  const keyFile = env[`${prefix}_KEY_FILE`];
  const caFile = env[`${prefix}_CA_FILE`];
  const set = [certFile, keyFile, caFile];
  if (set.every((value) => !value)) return undefined;
  if (set.some((value) => !value)) {
    throw new Error(`${prefix}_CERT_FILE, ${prefix}_KEY_FILE and ${prefix}_CA_FILE must be set together`);
  }
  return { certFile: certFile!, keyFile: keyFile!, caFile: caFile! };
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

  // Parsed before parseExecution because a real cluster deployment must pin the
  // guest image by digest independently of the payment/attestation dev switch.
  const kubeEnabled = bool(env.KUBERNETES_ENABLED, true);
  const execution = parseExecution(env, kubeEnabled, role);
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
  const relayTls = parseTlsFiles(env, "RELAY_TLS");
  const relayClientTls = parseTlsFiles(env, "RELAY_CLIENT_TLS");
  // A cluster relay must never expose the control routes over plaintext. The
  // local process and unit tests may run without certificates.
  if (kubeEnabled && (role === "relay" || role === "all") && !relayTls) {
    throw new Error("RELAY_TLS_CERT_FILE/RELAY_TLS_KEY_FILE/RELAY_TLS_CA_FILE are required for a relay when KUBERNETES_ENABLED is true");
  }
  if (relayClientTls && !/^https:/i.test(env.RELAY_URL ?? "")) {
    throw new Error("RELAY_CLIENT_TLS_* requires an https:// RELAY_URL");
  }
  if (!relayClientTls && /^https:/i.test(env.RELAY_URL ?? "")) {
    throw new Error("RELAY_CLIENT_TLS_CERT_FILE/RELAY_CLIENT_TLS_KEY_FILE/RELAY_CLIENT_TLS_CA_FILE are required for an https:// RELAY_URL");
  }
  const tokens = parseTokens(env, role, adminToken);
  const backupEnabled = role === "controller" || role === "all";
  const backupDir = backupEnabled ? (env.BACKUP_DIR ?? "") : "";
  const backupKey =
    backupEnabled && backupDir && env.BACKUP_ENCRYPTION_KEY
      ? parseBackupKey(env.BACKUP_ENCRYPTION_KEY)
      : null;
  if (backupDir && !backupKey) {
    throw new Error("BACKUP_ENCRYPTION_KEY is required when BACKUP_DIR is set");
  }

  return {
    role,
    controllerPort: int(env.X402_CONTROLLER_PORT ?? env.CONTROLLER_PORT, 3001, 1, 65535),
    metricsPort: int(env.METRICS_PORT, 9100, 0, 65535),
    metricsHost: env.METRICS_HOST ?? "0.0.0.0",
    ...tls,
    relayPort: int(env.X402_RELAY_PORT ?? env.RELAY_PORT, 8443, 1, 65535),
    relayControlPort: int(env.RELAY_CONTROL_PORT, 8444, 1, 65535),
    ...(relayTls ? { relayTls } : {}),
    ...(relayClientTls ? { relayClientTls } : {}),
    proxyPort: int(env.X402_PROXY_PORT ?? env.PROXY_PORT, 3128, 1, 65535),
    adminToken,
    ...tokens,
    controllerUrl: env.CONTROLLER_URL ?? "http://127.0.0.1:3001",
    dbPath: env.DB_PATH ?? "/data/controller.db",
    backupDir,
    backupIntervalMs: int(env.BACKUP_INTERVAL_MS, 21_600_000, 60_000, 604_800_000),
    backupRetention: int(env.BACKUP_RETENTION, 14, 1, 365),
    backupKey,
    sandboxNamespace: env.SANDBOX_NAMESPACE ?? "sandbox-workloads",
    controlNamespace: env.CONTROL_NAMESPACE ?? "sandbox-system",
    ...execution,
    kubeEnabled,
    relayEnabled: bool(env.RELAY_ENABLED, role === "all" || role === "relay"),
    proxyEnabled: bool(env.PROXY_ENABLED, role === "all" || role === "proxy"),
    relayBaseUrl: env.RELAY_URL ?? "http://127.0.0.1:8443",
    relayServiceName: env.RELAY_SERVICE_NAME ?? "relay",
    proxyServiceName: env.PROXY_SERVICE_NAME ?? "egress-proxy",
    workspaceDir: env.WORKSPACE_DIR ?? "/workspace",
    provisioningTimeoutMs: int(env.PROVISIONING_TIMEOUT_MS, 90_000, 10_000, 600_000),
    relayRegistrationTimeoutMs: int(env.RELAY_REGISTRATION_TIMEOUT_MS, 5_000, 500, 60_000),
    leaseGraceMs: int(env.LEASE_GRACE_MS, 2_000, 0, 60_000),
    reconcileIntervalMs: int(env.RECONCILE_INTERVAL_MS, 250, 50, 10_000),
    reconcileConcurrency: int(env.RECONCILE_CONCURRENCY, 8, 1, 256),
    // Upper bound keeps one pass from enqueuing an unbounded batch; lower
    // bound keeps the loop making progress (a budget of 0 would starve).
    reconcileBudget: int(env.RECONCILE_BUDGET, 1_000, 1, 10_000),
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
    egressMaxConnectionsPerSession: int(env.EGRESS_MAX_CONNECTIONS_PER_SESSION, 16, 1, 1024),
    egressMaxGlobalConnections: int(env.EGRESS_MAX_GLOBAL_CONNECTIONS, 512, 1, 65_536),
    tiers,
    platformLimits: loadPlatformLimits(env),
    warmPoolSize,
    warmPoolTier,
    warmPoolTtlMs: int(env.WARM_POOL_TTL_MS, 300_000, 30_000, 3_600_000),
    warmClaimTimeoutMs: int(env.WARM_CLAIM_TIMEOUT_MS, 8_000, 1_000, 60_000),
    pinCheckpointNode: bool(env.PIN_CHECKPOINT_NODE, true),
    orphanPvcGraceMs: int(env.ORPHAN_PVC_GRACE_MS, 3_600_000, 60_000, 86_400_000),
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
    // Append-only: another branch adds fields above this line.
    guestMeasurementAllowlist: (() => {
      const values = (env.GUEST_MEASUREMENT_ALLOWLIST ?? "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      for (const value of values) {
        // sha256 hex only: a typo must fail startup, never silently unpin.
        if (!/^[0-9a-f]{64}$/.test(value)) {
          throw new Error(`invalid GUEST_MEASUREMENT_ALLOWLIST entry ${value}`);
        }
      }
      return values;
    })(),
    ...parseDataPlanePlacement(env, role),
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
  return new RelayClient({
    baseUrl: cfg.relayBaseUrl,
    adminToken: cfg.relayAdminToken,
    ...(cfg.relayClientTls ? { tls: cfg.relayClientTls } : {}),
    // Per-session control calls follow the guest to the same shard. With one
    // replica both values are inert and baseUrl is used unchanged.
    relayReplicas: cfg.relayReplicas,
    relayHostTemplate: cfg.relayHostTemplate,
    relayControlPort: cfg.relayControlPort,
  });
}

export function proxyTokenFor(cfg: ControllerConfig, sessionId: string): string {
  const shard = shardClaim(cfg, "proxy", sessionId);
  return mintProxyToken(cfg.proxyTokenSecret, sessionId, 60 * 60_000, shard);
}

/**
 * Relay/proxy placement, appended (never interleaved) so concurrent config
 * changes do not conflict.
 *
 * A replica count above 1 without a `{shard}` template would silently send
 * every session to the same hostname, so it fails at startup instead.
 */
function parseDataPlanePlacement(
  env: NodeJS.ProcessEnv,
  role: Role,
): Pick<
  ControllerConfig,
  "relayReplicas" | "proxyReplicas" | "relayHostTemplate" | "proxyHostTemplate" | "shardIndex"
> {
  const relayReplicas = int(env.RELAY_REPLICAS, 1, 1, 64);
  const proxyReplicas = int(env.PROXY_REPLICAS, 1, 1, 64);
  const relayHostTemplate = env.RELAY_HOST_TEMPLATE ?? "relay-{shard}.relay-headless";
  const proxyHostTemplate = env.PROXY_HOST_TEMPLATE ?? "egress-proxy-{shard}.egress-proxy-headless";

  if (relayReplicas > 1 && !relayHostTemplate.includes("{shard}")) {
    throw new Error("RELAY_HOST_TEMPLATE must contain {shard} when RELAY_REPLICAS > 1");
  }
  if (proxyReplicas > 1 && !proxyHostTemplate.includes("{shard}")) {
    throw new Error("PROXY_HOST_TEMPLATE must contain {shard} when PROXY_REPLICAS > 1");
  }

  // In Kubernetes the pod ordinal arrives as the pod name (`relay-0`), so
  // accept both "0" and a trailing "-<ordinal>".
  const rawShard = env.SHARD_INDEX?.trim();
  let shardIndex: number | undefined;
  if (rawShard) {
    const ordinal = /(?:^|-)(\d+)$/.exec(rawShard);
    if (!ordinal) throw new Error(`invalid SHARD_INDEX ${rawShard}`);
    shardIndex = Number(ordinal[1]);
  }
  if (shardIndex !== undefined) {
    const replicas = role === "proxy" ? proxyReplicas : role === "relay" ? relayReplicas : 0;
    if (replicas > 0 && shardIndex >= replicas) {
      throw new Error(
        `SHARD_INDEX ${shardIndex} is outside the ${replicas}-replica range for this role`,
      );
    }
  }
  // Affinity is only enforced when the ordinal is known. More than one replica
  // without it would route guests into the wrong in-memory registry silently,
  // so refuse to start rather than run blind.
  if (shardIndex === undefined && role === "relay" && relayReplicas > 1) {
    throw new Error("SHARD_INDEX is required when RELAY_REPLICAS > 1");
  }
  if (shardIndex === undefined && role === "proxy" && proxyReplicas > 1) {
    throw new Error("SHARD_INDEX is required when PROXY_REPLICAS > 1");
  }

  return {
    relayReplicas,
    proxyReplicas,
    relayHostTemplate,
    proxyHostTemplate,
    ...(shardIndex !== undefined ? { shardIndex } : {}),
  };
}
