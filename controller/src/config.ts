import { KubeProvisioner, NullProvisioner, type Provisioner } from "./k8s.js";
import { LocalProvisioner } from "./local-provisioner.js";
import { RelayClient } from "./relay-client.js";
import { mintProxyToken } from "./tokens.js";

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function int(v: string | undefined, def: number, min: number, max: number): number {
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`invalid int ${v}`);
  return n;
}

export type Role = "controller" | "relay" | "proxy" | "all";

export interface ControllerConfig {
  role: Role;
  controllerPort: number;
  relayPort: number;
  proxyPort: number;
  adminToken: string;
  relayAdminToken: string;
  proxyTokenSecret: string;
  dbPath: string;
  sandboxNamespace: string;
  controlNamespace: string;
  guestImage: string;
  guestImageDigest: string;
  runtimeClass: string;
  executionMode: "dev" | "kata" | "confidential";
  allowInsecureDev: boolean;
  kubeEnabled: boolean;
  relayEnabled: boolean;
  proxyEnabled: boolean;
  relayBaseUrl: string;
  relayServiceName: string;
  proxyServiceName: string;
  provisioningTimeoutMs: number;
  executionGraceMs: number;
  resultTtlMs: number;
  reconcileIntervalMs: number;
  maxPodAgeMs: number;
  relayResultWaitMs: number;
  allowedPorts: number[];
  allowedHostSuffixes: string[];
  deniedCidrs: string[];
  devAttestationKey: string;
  devAttestationKeyId: string;
}

/**
 * Fail-closed configuration validation.
 * - confidential mode demands genuine hardware evidence and a CoCo runtime class.
 * - dev/kata never masquerade as confidential.
 */
export function loadControllerConfig(env: NodeJS.ProcessEnv = process.env): ControllerConfig {
  const role = (env.ROLE ?? "controller") as Role;
  if (!["controller", "relay", "proxy", "all"].includes(role)) {
    throw new Error(`invalid ROLE ${role}`);
  }

  const executionMode = (env.EXECUTION_MODE ?? "dev") as "dev" | "kata" | "confidential";
  if (!["dev", "kata", "confidential"].includes(executionMode)) {
    throw new Error(`invalid EXECUTION_MODE ${executionMode}`);
  }

  const runtimeClass = env.RUNTIME_CLASS ?? "x402-sandbox";
  const allowInsecureDev = bool(env.ALLOW_INSECURE_DEV, executionMode !== "confidential");

  if (executionMode === "confidential") {
    if (allowInsecureDev) {
      throw new Error("ALLOW_INSECURE_DEV must be false in confidential mode");
    }
    if (!/coco|sev|tdx|kata/.test(runtimeClass)) {
      throw new Error(
        `confidential mode requires a confidential RuntimeClass (got ${runtimeClass}); refusing to downgrade`,
      );
    }
  }
  if (executionMode !== "confidential" && !allowInsecureDev) {
    throw new Error("non-confidential modes require ALLOW_INSECURE_DEV=true (explicit acknowledgement)");
  }

  const adminToken = env.ADMIN_TOKEN ?? "";
  if (["controller", "all"].includes(role) && adminToken.length < 16) {
    throw new Error("ADMIN_TOKEN must be set (>=16 chars) for controller roles");
  }

  return {
    role,
    controllerPort: int(env.X402_CONTROLLER_PORT ?? env.CONTROLLER_PORT, 3001, 1, 65535),
    relayPort: int(env.X402_RELAY_PORT ?? env.RELAY_PORT, 8443, 1, 65535),
    proxyPort: int(env.X402_PROXY_PORT ?? env.PROXY_PORT, 3128, 1, 65535),
    adminToken,
    relayAdminToken: env.RELAY_ADMIN_TOKEN ?? adminToken,
    proxyTokenSecret: env.PROXY_TOKEN_SECRET ?? env.ADMIN_TOKEN ?? "",
    dbPath: env.DB_PATH ?? "/data/controller.db",
    sandboxNamespace: env.SANDBOX_NAMESPACE ?? "sandbox-workloads",
    controlNamespace: env.CONTROL_NAMESPACE ?? "sandbox-system",
    guestImage: env.GUEST_IMAGE ?? "x402-sandbox/guest:dev",
    guestImageDigest: env.GUEST_IMAGE_DIGEST ?? "sha256:unpinned-dev-image",
    runtimeClass,
    executionMode,
    allowInsecureDev,
    kubeEnabled: bool(env.KUBERNETES_ENABLED, true),
    relayEnabled: bool(env.RELAY_ENABLED, role === "all" || role === "relay"),
    proxyEnabled: bool(env.PROXY_ENABLED, role === "all" || role === "proxy"),
    relayBaseUrl: env.RELAY_URL ?? "http://127.0.0.1:8443",
    relayServiceName: env.RELAY_SERVICE_NAME ?? "relay",
    proxyServiceName: env.PROXY_SERVICE_NAME ?? "egress-proxy",
    provisioningTimeoutMs: int(env.PROVISIONING_TIMEOUT_MS, 90_000, 10_000, 600_000),
    executionGraceMs: int(env.EXECUTION_GRACE_MS, 3_000, 0, 60_000),
    resultTtlMs: int(env.RESULT_TTL_MS, 120_000, 10_000, 900_000),
    reconcileIntervalMs: int(env.RECONCILE_INTERVAL_MS, 250, 50, 10_000),
    maxPodAgeMs: int(env.MAX_POD_AGE_MS, 900_000, 120_000, 3_600_000),
    relayResultWaitMs: int(env.RELAY_RESULT_WAIT_MS, 20_000, 0, 60_000),
    allowedPorts: (env.EGRESS_ALLOWED_PORTS ?? "443").split(",").map((p) => Number(p.trim())).filter((n) => Number.isInteger(n)),
    allowedHostSuffixes: (env.EGRESS_ALLOWED_HOST_SUFFIXES ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    deniedCidrs: (env.EGRESS_DENIED_CIDRS ?? "10.244.0.0/16,10.96.0.0/12")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    devAttestationKey: env.DEV_ATTESTATION_KEY ?? "",
    devAttestationKeyId: env.DEV_ATTESTATION_KEY_ID ?? "",
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
  return mintProxyToken(cfg.proxyTokenSecret, sessionId, 20 * 60_000);
}
