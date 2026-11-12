/**
 * Controller configuration entry point.
 *
 * The loader is a sequence of section parsers so a change to one area of the
 * configuration does not require reading every other parser. The order of the
 * calls, and of the spreads below, is the startup validation order: a required
 * setting that used to be refused first is still refused first.
 *
 * Sections live in `controller/src/config/`. Types are re-exported here so
 * existing importers of `./config.js` are unaffected.
 */
import { KubeProvisioner, NullProvisioner, type Provisioner } from "./k8s.js";
import { LocalProvisioner } from "./local-provisioner.js";
import { RelayClient } from "./relay-client.js";
import { mintProxyToken } from "./tokens.js";
import { shardClaim } from "./data-plane-shard.js";
import { parseSettlement } from "./settlement-config.js";
import { parseGuestMeasurementAllowlist } from "./config/attestation.js";
import { parseBackup, parseBackupKeyMaterial } from "./config/backup.js";
import { parseCapacity } from "./config/capacity.js";
import { parseEgress } from "./config/egress.js";
import {
  parseClusterFlags,
  parseExecution,
  parseKubernetes,
  parseRuntimeProfilesFor,
} from "./config/kubernetes.js";
import { parseLimitTables, parseTierTable } from "./config/limits.js";
import { parsePaymentLimits } from "./config/payments.js";
import { parseProvisioning, parseProvisioningLimits } from "./config/provisioning.js";
import { parseDataPlanePlacement, parseRelayServices } from "./config/relay.js";
import { parseRole } from "./config/role.js";
import { parseServer } from "./config/server.js";
import { parseStore } from "./config/store.js";
import { parseAdminTokens, parseServiceTokens } from "./config/tokens.js";
import { parseTransportSecurity } from "./config/tls.js";
import type { ControllerConfig } from "./config/types.js";
import { parseWarmPool, parseWarmPoolAllocation } from "./config/warm-pool.js";

export type { Role } from "./config/role.js";
export type { ControllerConfig } from "./config/types.js";

// The runtime-profile vocabulary lives with the catalog so the controller has
// one definition of "which profiles exist"; re-exported here because callers
// already read their controller configuration from this module.
export {
  DEFAULT_RUNTIME_PROFILE,
  resolveRuntimeProfile,
  runtimeProfileEnv,
  sessionRuntime,
  type RuntimeProfile,
  type RuntimeProfileCatalog,
  type SessionRuntimeSource,
} from "./runtime-profiles.js";

/**
 * Fail-closed configuration validation, one section at a time.
 */
export function loadControllerConfig(env: NodeJS.ProcessEnv = process.env): ControllerConfig {
  const role = parseRole(env);

  // Parsed before parseExecution because a real cluster deployment must pin the
  // guest image by digest independently of the payment/attestation dev switch.
  const cluster = parseClusterFlags(env);
  const execution = parseExecution(env, cluster.kubeEnabled, role);
  const admin = parseAdminTokens(env, role);
  const tiers = parseTierTable(env);
  const warmPool = parseWarmPoolAllocation(env, tiers);
  const runtimeProfiles = parseRuntimeProfilesFor(env, execution, cluster, role);
  const security = parseTransportSecurity(env, cluster.kubeEnabled, role);
  const tokens = parseServiceTokens(env, role, admin.adminToken, admin.adminTokenPrevious);
  // Backup key material is checked before any listener port, matching the
  // original loader: a backup directory without a key is refused first.
  const backup = parseBackupKeyMaterial(env, role);

  return {
    role,
    ...parseServer(env, admin, tokens, security),
    ...parseStore(env, backup.backupDir),
    ...parseBackup(env, backup),
    ...parseKubernetes(env, cluster, execution, runtimeProfiles),
    ...parseRelayServices(env, role),
    ...parseProvisioning(env),
    ...parseEgress(env),
    ...parseLimitTables(env, tiers),
    ...parseWarmPool(env, warmPool),
    ...parseProvisioningLimits(env),
    ...parsePaymentLimits(env),
    ...parseSettlement(env),
    ...parseCapacity(env),
    ...parseGuestMeasurementAllowlist(env),
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
