/**
 * Shard-aware data-plane endpoints and the claims a guest credential carries.
 *
 * Extracted from the provisioning use case so the address decision has one
 * home: the pod spec needs it before a create, the resume path needs it to
 * report an unavailable data plane, and a future `start_pod` execution needs it
 * as an effect context. Nothing here mutates session state or the store, so it
 * is safe to call from any of those.
 */
import { log } from "@x402s/shared/runtime";
import { pinnedShard, shardClaim } from "../data-plane-shard.js";
import type { DataPlanePlacement, DataPlaneService } from "../data-plane-shard.js";
import type { SessionRecord } from "../store/models.js";
import { newOpaqueToken, sha256Hex } from "../secrets.js";
import { guestTokenFor } from "../tokens.js";

export type Endpoint = { host: string; port: number };
export type EndpointPair = { relay: Endpoint | null; proxy: Endpoint | null };

/** What address resolution needs: placement config plus the Service lookups. */
interface EndpointRuntime {
  readonly cfg: DataPlanePlacement & {
    relayServiceName: string;
    proxyServiceName: string;
    relayHeadlessService: string;
    proxyHeadlessService: string;
  };
  serviceAddress(name: string, shard?: number, podPrefix?: string): Promise<Endpoint | null>;
  stableServiceAddress(name: string, shard?: number, podPrefix?: string): Promise<Endpoint | null>;
}

export class DataPlaneEndpoints {
  constructor(private readonly ctx: EndpointRuntime) {}

  /**
   * Relay endpoint a guest dials for this session.
   *
   * Always a ClusterIP, never an endpoint Pod IP: the guest URL is baked into
   * the Pod at create, and a Pod IP dies with the relay Pod. A guest runs with
   * `dnsPolicy: None` and no DNS egress, so a Service name is not an option
   * either. At one replica this is the `relay` ClusterIP; above one it is the
   * session shard's per-shard ClusterIP Service (`relay-0`), which selects that
   * StatefulSet Pod only.
   */
  async relayAddress(sessionId: string): Promise<Endpoint | null> {
    const shard = pinnedShard(this.ctx.cfg, "relay", sessionId);
    return shard === null
      ? this.ctx.stableServiceAddress(this.ctx.cfg.relayServiceName)
      : this.ctx.stableServiceAddress(
          this.ctx.cfg.relayServiceName,
          shard,
          this.ctx.cfg.relayServiceName,
        );
  }

  /** Proxy endpoint for this session; same single/multi-replica split. */
  async proxyAddress(sessionId: string): Promise<Endpoint | null> {
    return this.endpoint("proxy", sessionId);
  }

  /**
   * Resolve the egress proxy for a session.
   *
   * The proxy is still addressed by endpoint Pod IP: a restart of the proxy
   * breaks egress for the rest of the session (recorded as a residual in ADR
   * 0012), but it does not kill the session or the relay link.
   */
  private endpoint(service: DataPlaneService, sessionId: string): Promise<Endpoint | null> {
    const name =
      service === "relay" ? this.ctx.cfg.relayServiceName : this.ctx.cfg.proxyServiceName;
    // Only the headless Service publishes endpoint hostnames (`relay-0`), so a
    // shard can only be matched there. The ClusterIP Service's endpoints carry
    // addresses with no hostname.
    const headless =
      service === "relay"
        ? this.ctx.cfg.relayHeadlessService
        : this.ctx.cfg.proxyHeadlessService;
    const shard = pinnedShard(this.ctx.cfg, service, sessionId);
    return shard === null
      ? this.ctx.serviceAddress(name)
      : this.ctx.serviceAddress(headless, shard, name);
  }

  /**
   * Both data-plane endpoints for a session.
   *
   * Exposed for the resume path, which has to report an unavailable data plane
   * as an error rather than terminate the session. The relay half is the
   * stable guest address, but a ready endpoint is still required first: a
   * sharded Service with no ready backend leaves this null and the resume fails
   * as before, instead of booting a guest that can only retry.
   */
  async endpointsFor(sessionId: string): Promise<EndpointPair> {
    const [relayReady, relay, proxy] = await Promise.all([
      this.endpoint("relay", sessionId),
      this.relayAddress(sessionId),
      this.proxyAddress(sessionId),
    ]);
    return { relay: relayReady ? relay : null, proxy };
  }

  /**
   * Endpoints for a pod this pass will create, or null when it must not.
   *
   * A null is always a defer-and-retry, never a silent fallback. The Service or
   * the pinned shard may come back inside the provisioning timeout, and that
   * timeout already terminates and refunds. Failing a paid session the moment a
   * replica rolls would make a normal restart look like a customer-visible
   * failure. Falling back to a hostname is not an option either: sandbox pods
   * have no DNS, so a guest handed a name can never connect. The relay address
   * here is already the stable ClusterIP; a missing one (for example a sharded
   * deployment without its per-shard Services) defers the create instead of
   * booting a guest that cannot dial.
   */
  async podEndpoints(session: SessionRecord): Promise<{ relay: Endpoint; proxy: Endpoint } | null> {
    const { relay, proxy } = await this.endpointsFor(session.id);
    if (relay && proxy) return { relay, proxy };

    const pinned = (["relay", "proxy"] as const).some(
      (service) => (service === "relay" ? !relay : !proxy) && pinnedShard(this.ctx.cfg, service, session.id) !== null,
    );
    log.warn(pinned ? "sandbox_data_plane_endpoint_unavailable" : "sandbox_services_unavailable", {
      sessionId: session.id,
      relay: Boolean(relay),
      proxy: Boolean(proxy),
    });
    return null;
  }
}

/**
 * The relay credential a new pod presents, and the hash the relay stores.
 *
 * The token carries the relay shard claim, so a guest that dials the wrong
 * replica is refused rather than served by a registry that does not know it.
 */
export function relayCredential(
  placement: DataPlanePlacement,
  sessionId: string,
): { guestToken: string; tokenHash: string } {
  const guestToken = guestTokenFor(newOpaqueToken(32), shardClaim(placement, "relay", sessionId));
  return { guestToken, tokenHash: sha256Hex(guestToken) };
}

/**
 * A credential the relay has accepted, and the generation that accepted it.
 *
 * The guest token is the secret the pod boots with; it is never written to the
 * session row (only `tokenHash` is). Registration and pod creation are separate
 * steps because the transition table names them separately, so the token has to
 * travel from `register_relay` to the `start_pod` that follows it in the same
 * effect list.
 */
export interface RelayRegistration {
  readonly guestToken: string;
  readonly tokenHash: string;
  /** Relay generation that accepted this registration. */
  readonly generation: string;
}
