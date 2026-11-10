/**
 * Pod creation and replacement for a provisioned session.
 *
 * Extracted from the provisioning use case because the pod spec, the guest
 * credential and the relay registration are one atomic admission: the token
 * registered with the relay is the token the guest boots with, so they cannot
 * be split into separate effect calls. A future `start_pod` execution runs from
 * here, which is why the endpoints are a dependency rather than a local call.
 */
import { log } from "@x402s/shared";
import { proxyTokenFor } from "../config.js";
import type { ControllerConfig } from "../config.js";
import type { CapacityService } from "../capacity/service.js";
import type { Provisioner } from "../k8s.js";
import type { RelayClient } from "../relay-client.js";
import type { SessionRecord } from "../store/models.js";
import type { ProvisioningStore } from "../store/ports.js";
import { relayCredential } from "./endpoints.js";
import type { DataPlaneEndpoints, Endpoint } from "./endpoints.js";

type PodCreationStore = Pick<
  ProvisioningStore,
  "mergeTimings" | "setProvisioning" | "setProvisioningPod" | "setRelayToken"
>;

/** The narrow view of the reconciler that pod construction is allowed to use. */
export interface PodCreationRuntime {
  readonly cfg: ControllerConfig;
  readonly store: PodCreationStore;
  readonly provisioner: Pick<
    Provisioner,
    "createPod" | "deletePod" | "getPod" | "listSandboxPods"
  >;
  readonly relay: Pick<RelayClient, "registerCurrent">;
  readonly capacity: Pick<CapacityService, "updatePod">;
  readonly endpoints: DataPlaneEndpoints;
  now(): number;
}

export class PodCreation {
  /** Relay generation that accepted each provisioning pod. */
  private readonly relayGeneration = new Map<string, string>();

  constructor(private readonly ctx: PodCreationRuntime) {}

  /** The relay generation that accepted this session's pod, if one is recorded. */
  generationFor(sessionId: string): string | undefined {
    return this.relayGeneration.get(sessionId);
  }

  recordGeneration(sessionId: string, generation: string): void {
    this.relayGeneration.set(sessionId, generation);
  }

  /** Drop the recorded generation once the handshake settles the session. */
  forgetGeneration(sessionId: string): void {
    this.relayGeneration.delete(sessionId);
  }

  /**
   * Adopt a pod Kubernetes already has for this session, or return false.
   *
   * The controller crashed after Kubernetes accepted the Pod but before the
   * session row was marked PROVISIONING. Adopt it instead of creating a second
   * Pod or rotating the relay token the guest already holds.
   *
   * True means the caller must stop this pass whether or not the row was
   * marked: the pod exists, so a create would conflict.
   */
  async adoptExistingPod(session: SessionRecord): Promise<boolean> {
    const existingPod = await this.ctx.provisioner
      .listSandboxPods()
      .then((pods) => pods.find((pod) => pod.sessionId === session.id && pod.phase !== "Failed" && pod.phase !== "Succeeded"))
      .catch(() => undefined);
    if (!existingPod) return false;
    if (this.ctx.store.setProvisioning(session.id, existingPod.name)) {
      this.ctx.capacity.updatePod(session.id, existingPod.name);
      this.ctx.store.mergeTimings(session.id, {
        podRequestedAt: this.ctx.now(),
        podCreateCallMs: 0,
      });
      log.info("sandbox_pod_adopted", { sessionId: session.id, podName: existingPod.name });
    }
    return true;
  }

  /**
   * Replace a provisioning pod whose guest cannot reach the current relay.
   *
   * The old pod is deleted first so the deterministic pod name can be reused;
   * if it is still terminating we leave the session in PROVISIONING and retry
   * on the next reconcile pass rather than racing Kubernetes with a 409.
   */
  async recreatePod(session: SessionRecord): Promise<boolean> {
    const oldPod = session.podName;
    if (!oldPod) return false;
    await this.ctx.provisioner.deletePod(oldPod, 0).catch(() => undefined);
    for (let i = 0; i < 50; i += 1) {
      const pod = await this.ctx.provisioner.getPod(oldPod).catch(() => null);
      if (!pod) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (await this.ctx.provisioner.getPod(oldPod).catch(() => null)) {
      log.warn("sandbox_pod_reprovision_pending", { sessionId: session.id, podName: oldPod });
      return false;
    }

    const endpoints = await this.ctx.endpoints.podEndpoints(session);
    if (!endpoints) return false;
    const { relay: relayAddr, proxy: proxyAddr } = endpoints;
    const timings = session.timingsJson
      ? (JSON.parse(session.timingsJson) as Record<string, unknown>)
      : {};
    const created = await this.createPod(session, relayAddr, proxyAddr, {
      ...(session.workspacePvc ? { workspacePvc: session.workspacePvc } : {}),
      ...(session.state === "RESUMING" ? { resume: true } : {}),
    });
    if (!this.ctx.store.setProvisioningPod(session.id, created.podName)) return false;
    this.ctx.capacity.updatePod(session.id, created.podName);
    this.relayGeneration.set(session.id, created.relayGeneration);
    this.ctx.store.mergeTimings(session.id, {
      reprovisionCount: Number(timings.reprovisionCount ?? 0) + 1,
    });
    log.warn("sandbox_pod_reprovisioned", {
      sessionId: session.id,
      oldPod,
      podName: created.podName,
      relayGeneration: created.relayGeneration,
    });
    return true;
  }

  async createPod(
    session: SessionRecord,
    relayAddr: Endpoint,
    proxyAddr: Endpoint,
    opts: { workspacePvc?: string; resume?: boolean; nodeName?: string } = {},
  ): Promise<{ podName: string; createStarted: number; relayGeneration: string }> {
    this.ctx.store.mergeTimings(session.id, {
      provisionStartAt: Date.now(),
      podRequestedAt: Date.now(),
    });
    const { guestToken, tokenHash } = relayCredential(this.ctx.cfg, session.id);
    const ttlMs = this.ctx.cfg.provisioningTimeoutMs + session.durationSeconds * 1000 + 5 * 60_000;
    // Register against the relay generation that is serving now and prove it
    // survived the call. A registration accepted by a terminating relay is
    // discarded and retried, so the pod never boots against a registry that is
    // about to disappear. A stale entry from a resumed session is replaced.
    const registration = await this.ctx.relay.registerCurrent(session.id, tokenHash, ttlMs, {
      deadlineMs: this.ctx.cfg.relayRegistrationTimeoutMs,
      replaceConnected: true,
      onRetry: (attempt, err) => log.warn("sandbox_relay_register_retry", {
        sessionId: session.id,
        attempt,
        error: err.message,
      }),
    });
    this.ctx.store.setRelayToken(session.id, tokenHash);

    // Registration may have waited through a relay replacement. Resolve the
    // relay endpoint again after it succeeds so the pod boots against the relay
    // that accepted the registration, not the one that was cached before it.
    // Above one replica this re-resolves the shard's ready endpoint, so the pod
    // lands on its shard and is never handed a hostname the guest cannot
    // resolve. The proxy endpoint is stable and already resolved by the caller.
    const relay = (await this.ctx.endpoints.relayAddress(session.id)) ?? relayAddr;
    const proxy = proxyAddr;

    const createStarted = Date.now();
    const { podName } = await this.ctx.provisioner.createPod({
      sessionId: session.id,
      leaseSeconds: session.durationSeconds,
      limits: session.limits,
      clientPublicKey: session.clientPublicKey,
      clientNonce: session.clientNonce,
      guestToken,
      relayUrl: `ws://${relay.host}:${relay.port}/guest?session=${encodeURIComponent(session.id)}`,
      relayHost: relay.host,
      relayPort: relay.port,
      proxyUrl: `http://${proxy.host}:${proxy.port}`,
      proxyToken: proxyTokenFor(this.ctx.cfg, session.id),
      image: this.ctx.cfg.guestImageRef,
      imageDigest: this.ctx.cfg.guestImageDigest,
      runtimeClass: this.ctx.cfg.runtimeClass,
      executionMode: this.ctx.cfg.executionMode,
      workspaceDir: this.ctx.cfg.workspaceDir,
      ...(opts.workspacePvc ? { workspacePvc: opts.workspacePvc } : {}),
      ...(opts.resume ? { resume: true } : {}),
      ...(session.baselineCpuMillis ? { baselineCpuMillis: session.baselineCpuMillis } : {}),
      ...(session.baselineMemoryMib ? { baselineMemoryMiB: session.baselineMemoryMib } : {}),
      ...(opts.nodeName ? { nodeName: opts.nodeName } : {}),
    });
    return { podName, createStarted, relayGeneration: registration.generation };
  }
}
