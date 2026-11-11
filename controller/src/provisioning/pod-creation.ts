/**
 * Pod creation and replacement for a provisioned session.
 *
 * Extracted from the provisioning use case because the pod spec and the guest
 * credential are one admission: the token registered with the relay is the
 * token the guest boots with. Registration and creation are two methods so the
 * transition table can name them (`register_relay`, then `start_pod`), with the
 * token carried between them; a caller that has no transition of its own
 * (replacing a pod whose guest can no longer reach the relay) passes no
 * registration and `createPod` performs both steps. Endpoints are a dependency
 * rather than a local call for the same reason: the pod spec needs them, and so
 * does the effect that starts the pod.
 */
import { log } from "@x402s/shared/runtime";
import {
  proxyTokenFor,
  resolveRuntimeProfile,
  runtimeProfileEnv,
  sessionRuntime,
  type ControllerConfig,
  type RuntimeProfile,
} from "../config.js";
import type { CapacityService } from "../capacity/service.js";
import type { Provisioner } from "../k8s.js";
import type { RelayClient } from "../relay-client.js";
import type { SessionRecord } from "../store/models.js";
import type { ProvisioningStore } from "../store/ports.js";
import { relayCredential } from "./endpoints.js";
import type { DataPlaneEndpoints, Endpoint, RelayRegistration } from "./endpoints.js";

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

  /**
   * The image this session's pod must run.
   *
   * Read from the catalog on every create rather than carried in an argument,
   * so a replacement pod is built for the same profile as the original: the
   * session's `runtime` is immutable, and admission has already rejected an
   * unknown name before any pod exists.
   */
  private profileFor(session: SessionRecord): RuntimeProfile {
    const requested = sessionRuntime(session);
    const profile = resolveRuntimeProfile(this.ctx.cfg.runtimeProfiles, requested);
    if (!profile) {
      // Admission terminates an unknown profile; reaching here means a caller
      // bypassed it. Refuse rather than boot the base image.
      throw new Error(
        `runtime profile ${requested.slice(0, 64)} is not configured on this controller`,
      );
    }
    return profile;
  }

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
    if (await this.ctx.store.setProvisioning(session.id, existingPod.name)) {
      await this.ctx.capacity.updatePod(session.id, existingPod.name);
      await this.ctx.store.mergeTimings(session.id, {
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
    if (!(await this.ctx.store.setProvisioningPod(session.id, created.podName))) return false;
    await this.ctx.capacity.updatePod(session.id, created.podName);
    this.relayGeneration.set(session.id, created.relayGeneration);
    await this.ctx.store.mergeTimings(session.id, {
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

  /**
   * Give the relay the credential this session's pod will present.
   *
   * The registration half of a create, split out because the transition table
   * names it (`register_relay` before `start_pod`). The token it mints is the
   * token the pod boots with and is never persisted: only its hash is written
   * to the row, and the token travels in the effect's staged registration.
   *
   * Registered against the generation serving now and proven to have survived
   * the call: a registration accepted by a terminating relay is discarded and
   * retried, so the pod never boots against a registry about to disappear. A
   * stale entry from a resumed session is replaced.
   */
  async registerRelay(session: SessionRecord): Promise<RelayRegistration> {
    const { guestToken, tokenHash } = relayCredential(this.ctx.cfg, session.id);
    const ttlMs = this.ctx.cfg.provisioningTimeoutMs + session.durationSeconds * 1000 + 5 * 60_000;
    const registration = await this.ctx.relay.registerCurrent(session.id, tokenHash, ttlMs, {
      deadlineMs: this.ctx.cfg.relayRegistrationTimeoutMs,
      replaceConnected: true,
      onRetry: (attempt, err) => log.warn("sandbox_relay_register_retry", {
        sessionId: session.id,
        attempt,
        error: err.message,
      }),
    });
    await this.ctx.store.setRelayToken(session.id, tokenHash);
    return { guestToken, tokenHash, generation: registration.generation };
  }

  async createPod(
    session: SessionRecord,
    relayAddr: Endpoint,
    proxyAddr: Endpoint,
    opts: {
      workspacePvc?: string;
      resume?: boolean;
      nodeName?: string;
      /**
       * Credential an earlier `register_relay` staged. Absent on the paths that
       * have no transition of their own (a replacement of a stranded pod), so
       * they mint and register one here.
       */
      registration?: RelayRegistration;
    } = {},
  ): Promise<{ podName: string; createStarted: number; relayGeneration: string }> {
    await this.ctx.store.mergeTimings(session.id, {
      provisionStartAt: Date.now(),
      podRequestedAt: Date.now(),
    });
    // The image is part of the boot identity, so resolve it before any work
    // that could leave a half-registered credential behind.
    const profile = this.profileFor(session);
    // Empty for `base`: its image carries no profile manifest.
    const runtimeProfile = runtimeProfileEnv(profile);
    const registration = opts.registration ?? (await this.registerRelay(session));
    const { guestToken } = registration;

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
      image: profile.imageRef,
      imageDigest: profile.digest,
      ...(runtimeProfile ? { runtimeProfile } : {}),
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
