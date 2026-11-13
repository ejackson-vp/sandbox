/**
 * Relay and egress-proxy placement.
 *
 * Enablement, the URLs peers dial and the Service names are read with the
 * scheduler settings. Replica counts, host templates and the shard ordinal are
 * read at the end of the loader, which is where the original loader validated
 * them: a replica count above 1 without a `{shard}` template would silently
 * send every session to the same hostname, so it fails at startup instead.
 */
import { envBool as bool, envInt as int } from "@x402s/shared/env";
import type { Role } from "./role.js";
import type { ControllerConfig } from "./types.js";

type RelayServiceSettings = Pick<
  ControllerConfig,
  | "relayEnabled"
  | "proxyEnabled"
  | "relayBaseUrl"
  | "relayServiceName"
  | "relayGuestAddress"
  | "proxyServiceName"
  | "relayHeadlessService"
  | "proxyHeadlessService"
>;

type DataPlanePlacement = Pick<
  ControllerConfig,
  "relayReplicas" | "proxyReplicas" | "relayHostTemplate" | "proxyHostTemplate" | "shardIndex"
>;

function parseGuestAddress(value: string | undefined): "pod" | "service" {
  if (value === undefined || value === "" || value === "service") return "service";
  if (value === "pod") return "pod";
  throw new Error(`RELAY_GUEST_ADDRESS must be "service" or "pod", got ${value}`);
}

export function parseRelayServices(
  env: NodeJS.ProcessEnv,
  role: Role,
): RelayServiceSettings {
  return {
    relayEnabled: bool(env.RELAY_ENABLED, role === "all" || role === "relay"),
    proxyEnabled: bool(env.PROXY_ENABLED, role === "all" || role === "proxy"),
    relayBaseUrl: env.RELAY_URL ?? "http://127.0.0.1:8443",
    relayGuestAddress: parseGuestAddress(env.RELAY_GUEST_ADDRESS),
    relayServiceName: env.RELAY_SERVICE_NAME ?? "relay",
    proxyServiceName: env.PROXY_SERVICE_NAME ?? "egress-proxy",
    relayHeadlessService:
      env.RELAY_HEADLESS_SERVICE ?? `${env.RELAY_SERVICE_NAME ?? "relay"}-headless`,
    proxyHeadlessService:
      env.PROXY_HEADLESS_SERVICE ?? `${env.PROXY_SERVICE_NAME ?? "egress-proxy"}-headless`,
  };
}

interface ReplicaSettings {
  relayReplicas: number;
  proxyReplicas: number;
  relayHostTemplate: string;
  proxyHostTemplate: string;
}

function parseReplicas(env: NodeJS.ProcessEnv): ReplicaSettings {
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

  return { relayReplicas, proxyReplicas, relayHostTemplate, proxyHostTemplate };
}

function parseShardIndex(env: NodeJS.ProcessEnv): number | undefined {
  // In Kubernetes the pod ordinal arrives as the pod name (`relay-0`), so
  // accept both "0" and a trailing "-<ordinal>".
  const rawShard = env.SHARD_INDEX?.trim();
  if (!rawShard) return undefined;
  const ordinal = /(?:^|-)(\d+)$/.exec(rawShard);
  if (!ordinal) throw new Error(`invalid SHARD_INDEX ${rawShard}`);
  return Number(ordinal[1]);
}

/**
 * Every refusal that depends on the role: a shard must fall inside that
 * role's replica range, and more than one replica without an ordinal would
 * route guests into the wrong in-memory registry silently.
 */
function assertShardPlacement(
  shardIndex: number | undefined,
  role: Role,
  replicas: ReplicaSettings,
): void {
  if (shardIndex !== undefined) {
    const count = role === "proxy" ? replicas.proxyReplicas : role === "relay" ? replicas.relayReplicas : 0;
    if (count > 0 && shardIndex >= count) {
      throw new Error(
        `SHARD_INDEX ${shardIndex} is outside the ${count}-replica range for this role`,
      );
    }
  }
  // Affinity is only enforced when the ordinal is known. More than one replica
  // without it would route guests into the wrong in-memory registry silently,
  // so refuse to start rather than run blind.
  if (shardIndex === undefined && role === "relay" && replicas.relayReplicas > 1) {
    throw new Error("SHARD_INDEX is required when RELAY_REPLICAS > 1");
  }
  if (shardIndex === undefined && role === "proxy" && replicas.proxyReplicas > 1) {
    throw new Error("SHARD_INDEX is required when PROXY_REPLICAS > 1");
  }
}

export function parseDataPlanePlacement(
  env: NodeJS.ProcessEnv,
  role: Role,
): DataPlanePlacement {
  const replicas = parseReplicas(env);
  const shardIndex = parseShardIndex(env);
  assertShardPlacement(shardIndex, role, replicas);

  return {
    ...replicas,
    ...(shardIndex !== undefined ? { shardIndex } : {}),
  };
}
