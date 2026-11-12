/**
 * Deterministic data-plane placement.
 *
 * The relay's session registry and the egress proxy's per-session connection
 * counter are process memory. Running either with more than one replica is only
 * correct if every replica, and the controller, can compute the same owner for
 * a session from the session id alone: there is no shared counter store, and
 * putting one in front of the control plane's store would make egress
 * depend on control-plane availability.
 *
 * So placement is a pure function of the id. sha256 is used rather than a cheap
 * rolling hash because ids are opaque `sbx_…` strings with no internal
 * structure to spread; the hash carries the whole distribution.
 */
import { createHash } from "node:crypto";

/** The placement-relevant subset of the controller config. */
export interface DataPlanePlacement {
  relayReplicas: number;
  relayHostTemplate: string;
  relayPort: number;
  proxyReplicas: number;
  proxyHostTemplate: string;
  proxyPort: number;
}

export type DataPlaneService = "relay" | "proxy";

/**
 * Which replica of a data-plane service owns `sessionId`.
 *
 * Purity matters: the relay, the proxy and the controller must agree without
 * communicating, so there is no I/O, clock or randomness here. `replicas <= 1`
 * returns 0 unconditionally, which keeps the single-replica path trivial.
 */
export function dataPlaneShard(sessionId: string, replicas: number): number {
  const count = Math.trunc(replicas);
  if (!Number.isFinite(count) || count <= 1) return 0;
  const digest = createHash("sha256").update(sessionId).digest();
  // First 4 bytes as an unsigned big-endian integer, then modulo the replica
  // count. A 32-bit space is far larger than the 1..64 replica range, so the
  // modulo bias is negligible.
  return digest.readUInt32BE(0) % count;
}

/** Substitute the shard into a pod host template (`relay-{shard}.relay-headless`). */
export function shardHost(template: string, shard: number): string {
  return template.replaceAll("{shard}", String(shard));
}

/**
 * The shard `service` is pinned to for this session, or null at one replica
 * where the shardless Service lookup applies.
 *
 * A shard above one replica is not addressable by name from a guest: sandbox
 * pods run with `dnsPolicy: None` and no DNS egress, so a headless Service's
 * `relay-<n>.relay-headless` never resolves inside the microVM. Callers must
 * resolve the Service's EndpointSlice to the matching pod IP instead (the
 * StatefulSet publishes the pod name as the endpoint hostname). The controller
 * runs in-cluster with working DNS, so its admin path may keep the hostname.
 */
export function pinnedShard(
  placement: DataPlanePlacement,
  service: DataPlaneService,
  sessionId: string,
): number | null {
  const replicas = service === "relay" ? placement.relayReplicas : placement.proxyReplicas;
  return replicas > 1 ? dataPlaneShard(sessionId, replicas) : null;
}

/**
 * The shard claim a per-session credential should carry, or undefined when the
 * service has one replica and no placement to enforce.
 */
export function shardClaim(placement: DataPlanePlacement, service: DataPlaneService, sessionId: string): number | undefined {
  return pinnedShard(placement, service, sessionId) ?? undefined;
}
