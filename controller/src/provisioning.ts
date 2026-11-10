/**
 * Provisioning use case: cold pod or warm claim, then the readiness handshake.
 */
import {
  LATENCY_BUCKETS,
  lifetimeExpired,
  metrics,
  MIN_SUPPORTED_GUEST_PROTOCOL_VERSION,
  supportsGuestProtocolVersion,
  transition,
  verifyAttestation,
} from "@x402s/shared";
import type { AttestationEnvelope, RelaySessionState } from "@x402s/shared";
import { proxyTokenFor } from "./config.js";
import { log } from "@x402s/shared";
import type { ReconcilerContext } from "./reconciler-context.js";
import type { EffectStore, ProvisioningStore } from "./store/ports.js";

type ProvisioningContext = Omit<ReconcilerContext, "store"> & {
  store: ProvisioningStore & EffectStore;
};
type Endpoint = { host: string; port: number };
type EndpointPair = { relay: Endpoint | null; proxy: Endpoint | null };
import { newOpaqueToken, sha256Hex, guestTokenFor } from "./tokens.js";
import { pinnedShard, shardClaim } from "./data-plane-shard.js";
import type { DataPlaneService } from "./data-plane-shard.js";
import type { SessionRecord } from "./store/models.js";
import { snapshotOf } from "./session-snapshot.js";
import type { WarmPool } from "./warm-pool.js";
import { effectContext, executeEffects, isOk } from "./effects.js";

export class Provisioning {
  /**
   * Session ids holding an in-process provisioning slot. The persisted
   * PROVISIONING set is authoritative across restarts, but it only changes
   * after the pod create starts; concurrent passes need this set to enforce
   * the configured cap in the window between admission and the state write.
   *
   * Both sets can overlap: a session stays in this set after it is persisted
   * as PROVISIONING. Admission deduplicates by id rather than taking a max of
   * two counts, which would undercount one persisted session plus a different
   * in-flight one.
   */
  private readonly inFlight = new Set<string>();
  /** Relay generation that accepted each provisioning pod. */
  private readonly relayGeneration = new Map<string, string>();

  constructor(
    private readonly ctx: ProvisioningContext,
    private readonly warm: WarmPool,
  ) {}

  /**
   * Relay endpoint for this session.
   *
   * With one replica this is the existing ClusterIP/endpoint lookup, unchanged.
   * Above one it is the ready endpoint Pod IP for the session's shard. A
   * hostname would be dialled by a guest that runs with `dnsPolicy: None` and
   * no DNS egress, so it can never resolve one.
   */
  private relayAddress(sessionId: string) {
    return this.endpoint("relay", sessionId);
  }

  /** Proxy endpoint for this session; same single/multi-replica split. */
  private proxyAddress(sessionId: string) {
    return this.endpoint("proxy", sessionId);
  }

  /**
   * Resolve `service` for a session.
   *
   * At one replica this is the shardless Service lookup, byte-identical to the
   * pre-shard path. Above one it is the shard's ready endpoint and never the
   * ClusterIP, which load-balances across replicas.
   */
  private endpoint(service: DataPlaneService, sessionId: string) {
    const name =
      service === "relay" ? this.ctx.cfg.relayServiceName : this.ctx.cfg.proxyServiceName;
    const shard = pinnedShard(this.ctx.cfg, service, sessionId);
    return shard === null
      ? this.ctx.serviceAddress(name)
      : this.ctx.serviceAddress(name, shard);
  }

  /**
   * Both data-plane endpoints for a session.
   *
   * Exposed for the resume path, which has to report an unavailable data plane
   * as an error rather than terminate the session.
   */
  async endpointsFor(sessionId: string): Promise<EndpointPair> {
    return {
      relay: await this.relayAddress(sessionId),
      proxy: await this.proxyAddress(sessionId),
    };
  }

  /**
   * Endpoints for a pod this pass will create, or null when it must not.
   *
   * A null is always a defer-and-retry, never a silent fallback. The Service or
   * the pinned shard may come back inside the provisioning timeout, and that
   * timeout already terminates and refunds. Failing a paid session the moment a
   * replica rolls would make a normal restart look like a customer-visible
   * failure. Falling back to a hostname is not an option either: sandbox pods
   * have no DNS, so a guest handed a name can never connect.
   */
  private async podEndpoints(session: SessionRecord): Promise<{ relay: Endpoint; proxy: Endpoint } | null> {
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

  async provision(session: SessionRecord): Promise<void> {
    const limit = this.ctx.cfg.maxConcurrentProvisioning;
    const holdsSlot = limit > 0;
    if (holdsSlot) {
      const persisted = new Set(
        this.ctx.store
          .listNonTerminal()
          .filter((s) => s.state === "PROVISIONING")
          .map((s) => s.id),
      );
      let occupied = persisted.size;
      for (const id of this.inFlight) {
        if (!persisted.has(id)) occupied += 1;
      }
      if (occupied >= limit) {
        this.deferForSlot(session);
        return;
      }
      // No await between the check and the claim: a concurrent worker cannot
      // slip into the same slot.
      this.inFlight.add(session.id);
    }
    try {
      await this.provisionWithSlot(session);
    } finally {
      // Covers every path: warm claim, relay-not-ready, early returns and
      // errors. Leaving a slot behind would shrink capacity permanently.
      if (holdsSlot) this.inFlight.delete(session.id);
    }
  }

  private deferForSlot(session: SessionRecord): void {
    const queued = session.timingsJson
      ? (JSON.parse(session.timingsJson) as Record<string, unknown>)
      : {};
    if (typeof queued.provisionQueueEnteredAt !== "number") {
      this.ctx.store.mergeTimings(session.id, { provisionQueueEnteredAt: this.ctx.now() });
    }
    const waited = session.paidAt === null ? 0 : this.ctx.now() - session.paidAt;
    if (this.ctx.cfg.provisionQueueTimeoutMs > 0 && waited > this.ctx.cfg.provisionQueueTimeoutMs) {
      this.ctx.store.requestTermination(session.id, "failure:provisioning_queue_timeout", {
        code: "provisioning_queue_timeout",
        message: "the provisioning queue did not drain in time",
      });
      log.warn("sandbox_provisioning_queue_timeout", { sessionId: session.id, waitedMs: waited });
    }
  }

  private async provisionWithSlot(session: SessionRecord): Promise<void> {
    // Admission gate: a paid create must not start while the relay is being
    // replaced. Its registry is in memory, so a pod created now can dial a
    // relay that never accepted the registration and never recover inside the
    // provisioning budget. Holding the session in PAID costs nothing: no pod,
    // no capacity claim, and the next tick re-checks after the relay is ready.
    if (!(await this.ctx.relay.isReady())) {
      const waited = session.paidAt === null ? 0 : this.ctx.now() - session.paidAt;
      if (this.ctx.cfg.provisioningTimeoutMs > 0 && waited > this.ctx.cfg.provisioningTimeoutMs) {
        metrics
          .counter("sandbox_provisioning_relay_gate_total", "Creates held for relay readiness")
          .inc({ result: "timeout" });
        this.ctx.store.requestTermination(session.id, "failure:provisioning_timeout", {
          code: "provisioning_timeout",
          message: "the relay did not become ready in time",
        });
        log.warn("sandbox_relay_not_ready_timeout", { sessionId: session.id, waitedMs: waited });
      } else {
        metrics
          .counter("sandbox_provisioning_relay_gate_total", "Creates held for relay readiness")
          .inc({ result: "wait" });
        log.info("sandbox_relay_not_ready_deferred", { sessionId: session.id, waitedMs: waited });
      }
      return;
    }

    let reservation = this.ctx.capacity.getReservation(session.id);
    if (!reservation) {
      const admission = await this.ctx.capacity.attach(
        session.paymentKey,
        session.id,
        "",
        { limits: session.limits, ...(session.baselineCpuMillis && session.baselineMemoryMib ? {
          baseline: { cpuMillis: session.baselineCpuMillis, memoryMiB: session.baselineMemoryMib },
        } : {}) },
      );
      if (!admission.admitted) {
        metrics.counter("sandbox_capacity_provision_deferred_total", "Paid sessions waiting for capacity").inc({
          reason: admission.reason,
        });
        log.warn("sandbox_capacity_deferred", { sessionId: session.id, reason: admission.reason });
        return;
      }
      reservation = admission.reservation;
    }
    const queued = session.timingsJson
      ? (JSON.parse(session.timingsJson) as Record<string, unknown>)
      : {};
    if (typeof queued.provisionQueueEnteredAt === "number" && typeof queued.provisionQueueWaitMs !== "number") {
      const waitMs = Math.max(0, this.ctx.now() - queued.provisionQueueEnteredAt);
      metrics
        .histogram("sandbox_provisioning_wait_seconds", "Time spent waiting for a provisioning slot", LATENCY_BUCKETS)
        .observe(waitMs / 1000);
      this.ctx.store.mergeTimings(session.id, { provisionQueueWaitMs: waitMs });
    }
    const provisionBeginAt = this.ctx.now();
    const endpoints = await this.podEndpoints(session);
    if (!endpoints) return;
    const { relay: relayAddr, proxy: proxyAddr } = endpoints;

    if (lifetimeExpired(snapshotOf(session), this.ctx.now())) {
      this.ctx.store.requestTermination(session.id, "max_lifetime");
      return;
    }

    const suspendable = Boolean(session.idlePolicyJson);
    let workspacePvc = session.workspacePvc ?? undefined;
    if (suspendable) {
      // A checkpointed session needs its workspace to outlive the pod. It also
      // cannot use a warm pod: volumes are immutable at claim time.
      if (!workspacePvc) {
        workspacePvc = await this.ctx.provisioner.createWorkspacePvc(session.id, session.limits.diskMiB);
        this.ctx.store.setWorkspacePvc(session.id, workspacePvc);
      } else if (!(await this.ctx.provisioner.workspacePvcExists(workspacePvc).catch(() => false))) {
        // A stale name from a failed attempt; create a fresh PVC rather than
        // leaving the first pod Pending forever.
        workspacePvc = await this.ctx.provisioner.createWorkspacePvc(session.id, session.limits.diskMiB);
        this.ctx.store.setWorkspacePvc(session.id, workspacePvc);
      }
    } else if (await this.warm.tryClaim(session, relayAddr, proxyAddr, provisionBeginAt)) {
      return;
    }

    const existingPod = await this.ctx.provisioner
      .listSandboxPods()
      .then((pods) => pods.find((pod) => pod.sessionId === session.id && pod.phase !== "Failed" && pod.phase !== "Succeeded"))
      .catch(() => undefined);
    if (existingPod) {
      // The controller crashed after Kubernetes accepted the Pod but before the
      // session row was marked PROVISIONING. Adopt it instead of creating a
      // second Pod or rotating the relay token the guest already holds.
      if (this.ctx.store.setProvisioning(session.id, existingPod.name)) {
        this.ctx.capacity.updatePod(session.id, existingPod.name);
        this.ctx.store.mergeTimings(session.id, {
          podRequestedAt: this.ctx.now(),
          podCreateCallMs: 0,
        });
        log.info("sandbox_pod_adopted", { sessionId: session.id, podName: existingPod.name });
      }
      return;
    }

    const { podName, createStarted, relayGeneration } = await this.createPod(session, relayAddr, proxyAddr, {
      ...(workspacePvc ? { workspacePvc } : {}),
      ...(reservation && reservation.nodeId !== "disabled" ? { nodeName: reservation.nodeId } : {}),
    });
    this.ctx.store.setProvisioning(session.id, podName);
    this.ctx.capacity.updatePod(session.id, podName);
    this.ctx.store.mergeTimings(session.id, { podCreateCallMs: Date.now() - createStarted });
    this.relayGeneration.set(session.id, relayGeneration);
    metrics
      .histogram("sandbox_provision_duration_seconds", "Entitlement to pod create", LATENCY_BUCKETS)
      .observe((Date.now() - (session.paidAt ?? session.createdAt)) / 1000);
    log.info("sandbox_provisioning", {
      sessionId: session.id,
      podName,
      runtimeClass: this.ctx.cfg.runtimeClass,
      tier: session.tier,
      leaseSeconds: session.durationSeconds,
      suspendable,
    });
  }


  /**
   * Replace a provisioning pod whose guest cannot reach the current relay.
   *
   * The old pod is deleted first so the deterministic pod name can be reused;
   * if it is still terminating we leave the session in PROVISIONING and retry
   * on the next reconcile pass rather than racing Kubernetes with a 409.
   */
  private async recreatePod(session: SessionRecord): Promise<boolean> {
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

    const endpoints = await this.podEndpoints(session);
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
    relayAddr: { host: string; port: number },
    proxyAddr: { host: string; port: number },
    opts: { workspacePvc?: string; resume?: boolean; nodeName?: string } = {},
  ): Promise<{ podName: string; createStarted: number; relayGeneration: string }> {
    this.ctx.store.mergeTimings(session.id, {
      provisionStartAt: Date.now(),
      podRequestedAt: Date.now(),
    });
    const guestToken = guestTokenFor(newOpaqueToken(32), shardClaim(this.ctx.cfg, "relay", session.id));
    const tokenHash = sha256Hex(guestToken);
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
    const relay = (await this.relayAddress(session.id)) ?? relayAddr;
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


  async awaitReady(session: SessionRecord): Promise<void> {
    const timings = session.timingsJson ? (JSON.parse(session.timingsJson) as Record<string, unknown>) : {};
    if (
      timings.warmPoolHit === 1 &&
      typeof timings.warmClaimAt === "number" &&
      this.ctx.now() - timings.warmClaimAt > this.ctx.cfg.warmClaimTimeoutMs
    ) {
      this.ctx.store.requestTermination(session.id, "failure:warm_claim_timeout", {
        code: "warm_claim_timeout",
        message: "the warm sandbox did not attach to the session in time",
      });
      log.warn("sandbox_warm_claim_timeout", {
        sessionId: session.id,
        warmClaimAt: timings.warmClaimAt,
      });
      return;
    }

    const startedAt =
      session.state === "RESUMING" ? session.updatedAt : (session.paidAt ?? session.createdAt);
    const age = this.ctx.now() - startedAt;
    if (age > this.ctx.cfg.provisioningTimeoutMs) {
      this.ctx.store.requestTermination(session.id, "failure:provisioning_timeout", {
        code: "provisioning_timeout",
        message: "sandbox did not become ready in time",
      });
      log.warn("sandbox_provisioning_timeout", { sessionId: session.id, ageMs: age });
      return;
    }

    if (session.relayTokenHash) {
      try {
        // Bracket the handshake with generation probes. A relay restart between
        // these two reads means the hello came from a relay that is being
        // replaced; marking READY here would charge the customer for a guest
        // that is about to exit. Re-register on the next pass instead.
        const before = await this.ctx.relay.healthFor(session.id).catch(() => null);
        let state = await this.ctx.relay.state(session.id);
        const generationAtCreate = this.relayGeneration.get(session.id) ?? null;
        const relayChanged = Boolean(
          before && generationAtCreate && before.generation !== generationAtCreate,
        );
        // A relay replacement can land after the pod was created but before
        // the guest dials. The guest holds the old endpoint IP, so it can never
        // reach the replacement. Recreate the pod against the current endpoint
        // instead of waiting out the provisioning timeout. Warm pods are
        // already running and are handled by their own reconnection path.
        if (
          session.podName &&
          timings.warmPoolHit !== 1 &&
          (!state.registered || (relayChanged && !state.connected))
        ) {
          if (await this.recreatePod(session)) return;
        }
        if (!state.registered) {
          // The replacement relay does not know this session yet. Re-register
          // inside this pass (bounded, so one slow relay cannot stall the
          // reconcile loop) rather than waiting for the next tick or for the
          // guest's dial window to run out.
          await this.ctx.relay
            .registerCurrent(
              session.id,
              session.relayTokenHash,
              this.ctx.cfg.provisioningTimeoutMs + session.durationSeconds * 1000 + 300_000,
              { deadlineMs: this.ctx.cfg.relayRegistrationTimeoutMs },
            )
            .catch((err: Error) => {
              log.warn("relay_reregister_failed", { sessionId: session.id, error: err.message });
            });
          state = await this.ctx.relay.state(session.id);
        }
        if (state.connected && state.attestation) {
          const after = await this.ctx.relay.healthFor(session.id).catch(() => null);
          if (!before || !after || before.generation !== after.generation) {
            log.warn("sandbox_relay_generation_changed", {
              sessionId: session.id,
              before: before?.generation ?? null,
              after: after?.generation ?? null,
            });
            return;
          }
          // Reject an unsupported guest while the session is still pre-READY,
          // where termination is refundable. A versionless hello is accepted.
          if (this.rejectUnsupportedGuest(session, state, state.attestation)) return;
          const readyAt = this.ctx.now();
          const leaseExpiresAt = readyAt + session.durationSeconds * 1000;
          // PROVISIONING/RESUMING + guest_ready is the table's decision; its
          // single effect is the guarded write, so a lost race skips the
          // bookkeeping below exactly as a refused setReady did before.
          const decision = transition(snapshotOf(session), { type: "guest_ready" });
          const persisted =
            decision.ok &&
            isOk(
              await executeEffects(
                decision.value.effects,
                effectContext(this.ctx, session, {
                  ready: {
                    readyAt,
                    leaseExpiresAt,
                    attestationJson: JSON.stringify(state.attestation),
                    guestPublicKey: state.attestation.guestPublicKey,
                  },
                }),
              ),
            );
          if (persisted) {
            const warm = timings.warmPoolHit === 1;
            const podInfo = warm || !session.podName
              ? null
              : await this.ctx.provisioner.getPod(session.podName).catch(() => null);
            this.ctx.store.mergeTimings(session.id, {
              ...(warm
                ? {}
                : {
                    podCreatedAt: podInfo?.createdAt,
                    podScheduledAt: podInfo?.scheduledAt,
                    containerStartedAt: podInfo?.startedAt,
                  }),
              guestHelloAt: state.helloAt ?? readyAt,
              readyAt,
              leaseExpiresAt,
            });
            metrics
              .histogram("sandbox_ready_duration_seconds", "Entitlement to READY", LATENCY_BUCKETS)
              .observe((readyAt - startedAt) / 1000);
            this.relayGeneration.delete(session.id);
            log.info("sandbox_ready", {
              sessionId: session.id,
              evidenceType: state.attestation.evidenceType,
              insecureDevOnly: state.attestation.insecureDevOnly,
              leaseExpiresAt: new Date(leaseExpiresAt).toISOString(),
            });
          }
        }
      } catch (err) {
        log.warn("relay_state_check_failed", { sessionId: session.id, error: (err as Error).message });
      }
    }

    if (session.podName) {
      const pod = await this.ctx.provisioner.getPod(session.podName).catch(() => null);
      if (pod?.nodeName) {
        const reservation = this.ctx.capacity.getReservation(session.id);
        if (reservation && reservation.nodeId !== pod.nodeName && reservation.nodeId !== "disabled") {
          this.ctx.capacity.pinSessionNode(session.id, pod.nodeName);
          metrics.counter("sandbox_capacity_placement_reconciled_total", "Placement intents reconciled with Kubernetes").inc();
          log.warn("sandbox_placement_reconciled", {
            sessionId: session.id,
            intended: reservation.nodeId,
            actual: pod.nodeName,
          });
        }
        if (session.workspacePvc && !session.nodeName) {
          this.ctx.store.setNodeName(session.id, pod.nodeName);
          session.nodeName = pod.nodeName;
        }
      }
      if (pod && pod.phase === "Running") {
        // Record the first observation of a running container (tick resolution).
        const timings = session.timingsJson ? (JSON.parse(session.timingsJson) as Record<string, unknown>) : {};
        if (!timings.podRunningObservedAt && timings.warmPoolHit !== 1) {
          this.ctx.store.mergeTimings(session.id, { podRunningObservedAt: this.ctx.now() });
        }
      }
      if (pod && (pod.phase === "Failed" || pod.phase === "Succeeded")) {
        this.ctx.store.requestTermination(session.id, "failure:pod_terminated", {
          code: "pod_terminated",
          message: `pod reached phase ${pod.phase}`,
        });
      }
    }
  }

  /**
   * Refuse a guest before the lease starts (READY), so the termination is
   * refundable, in two independent cases.
   *
   *  - The hello's frame protocol is below the floor this build can serve. An
   *    absent version resolves to the floor and is accepted: a warm pool still
   *    holds pods from the previous image during a controller rollout.
   *  - The operator configured a measurement allowlist. This reuses the shared
   *    verifier the SDK already runs; the controller is the server-side pin.
   *    With no allowlist this method does no verification at all, preserving
   *    the previous behaviour (accept, and the verifier's "not pinned" warning
   *    remains a client-side concern).
   */
  private rejectUnsupportedGuest(
    session: SessionRecord,
    state: RelaySessionState,
    evidence: AttestationEnvelope,
  ): boolean {
    if (!supportsGuestProtocolVersion(state.protocolVersion)) {
      this.ctx.store.requestTermination(session.id, "failure:guest_protocol_unsupported", {
        code: "guest_protocol_unsupported",
        message: `guest protocol ${state.protocolVersion} is below the supported minimum ${MIN_SUPPORTED_GUEST_PROTOCOL_VERSION}`,
      });
      log.warn("sandbox_guest_protocol_unsupported", {
        sessionId: session.id,
        protocolVersion: state.protocolVersion ?? null,
        minSupported: MIN_SUPPORTED_GUEST_PROTOCOL_VERSION,
      });
      return true;
    }

    const allowlist = this.ctx.cfg.guestMeasurementAllowlist;
    if (allowlist.length === 0) return false;

    const verdict = verifyAttestation(evidence, {
      mode: this.ctx.cfg.executionMode,
      expectedSessionId: session.id,
      expectedClientNonce: session.clientNonce,
      expectedClientPublicKey: session.clientPublicKey,
      allowedMeasurements: allowlist,
      allowInsecureDev: this.ctx.cfg.allowInsecureDev,
      now: this.ctx.now(),
    });
    if (verdict.ok) {
      log.info("sandbox_guest_measurement_pinned", {
        sessionId: session.id,
        guestMeasurement: verdict.guestMeasurement,
      });
      return false;
    }

    const reason =
      verdict.code === "measurement_not_allowed" ? "guest_measurement_not_allowed" : "guest_attestation_rejected";
    this.ctx.store.requestTermination(session.id, `failure:${reason}`, {
      code: reason,
      message: verdict.message,
    });
    log.warn("sandbox_guest_attestation_rejected", { sessionId: session.id, verdict: verdict.code });
    return true;
  }
}
