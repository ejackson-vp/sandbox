/**
 * Provisioning use case: cold pod or warm claim, then the readiness handshake.
 *
 * Both create transitions run through the table: `PAID + provision_requested`
 * and `SUSPENDED + resume_requested` return the effect list, and this class is
 * the `CreatePath` those effects are executed against (`register_relay`,
 * `ensure_workspace_pvc`, `start_pod`). Admission is the shell's work and stays
 * in front of each transition: a session whose relay, slot, reservation or shard
 * endpoint is not ready returns from its current state and is retried.
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
import { log } from "@x402s/shared";
import type { ReconcilerContext } from "./reconciler-context.js";
import type { EffectStore, ProvisioningStore } from "./store/ports.js";

type ProvisioningContext = Omit<ReconcilerContext, "store"> & {
  store: ProvisioningStore & EffectStore;
};
import type { SessionRecord } from "./store/models.js";
import { snapshotOf } from "./session-snapshot.js";
import type { WarmPool } from "./warm-pool.js";
import { createPath, effectContext, executeEffects, isOk } from "./effects.js";
import type { CreatePath, StartPodRequest } from "./effects.js";
import { DataPlaneEndpoints } from "./provisioning/endpoints.js";
import type { EndpointPair, RelayRegistration } from "./provisioning/endpoints.js";
import { PodCreation } from "./provisioning/pod-creation.js";
import { ProvisioningAdmission } from "./provisioning/admission.js";
import { PodStatus } from "./provisioning/pod-status.js";

export class Provisioning implements CreatePath {
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
  /** Shard-aware address resolution and the relay shard claim. */
  private readonly endpoints: DataPlaneEndpoints;
  /** Relay gate, compute reservation and workspace volume before a create. */
  private readonly admission: ProvisioningAdmission;
  /** Pod spec assembly, warm registration and replacement. */
  private readonly pods: PodCreation;
  /** Placement and phase observations for an already-created pod. */
  private readonly podStatus: PodStatus;

  constructor(
    private readonly ctx: ProvisioningContext,
    private readonly warm: WarmPool,
  ) {
    this.endpoints = new DataPlaneEndpoints(ctx);
    this.admission = new ProvisioningAdmission(ctx);
    this.pods = new PodCreation({ ...ctx, endpoints: this.endpoints });
    this.podStatus = new PodStatus(ctx);
  }

  /**
   * Both data-plane endpoints for a session.
   *
   * Exposed for the resume path, which has to report an unavailable data plane
   * as an error rather than terminate the session.
   */
  async endpointsFor(sessionId: string): Promise<EndpointPair> {
    return this.endpoints.endpointsFor(sessionId);
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
    // Admission, in front of the transition: a paid session whose relay, slot,
    // reservation or shard endpoint is not ready must stay PAID so the next
    // pass can retry. None of these is an effect, so none of them can leave the
    // row half-moved.
    if (!(await this.admission.relayReady(session))) return;
    const reservation = await this.admission.reserve(session);
    if (!reservation) return;
    const provisionBeginAt = this.ctx.now();
    const endpoints = await this.endpoints.podEndpoints(session);
    if (!endpoints) return;

    if (lifetimeExpired(snapshotOf(session), this.ctx.now())) {
      this.ctx.store.requestTermination(session.id, "max_lifetime");
      return;
    }

    // PAID + provision_requested is the table's decision: register the guest
    // credential, ensure the workspace a suspendable session needs, then claim
    // a warm pod or create a cold one. The last effect performs the guarded
    // write that moves the row to PROVISIONING, so a lost race to a destroy
    // stops the sequence instead of creating a pod nobody owns.
    const decision = transition(snapshotOf(session), { type: "provision_requested" });
    if (!decision.ok) {
      log.info("sandbox_provision_not_applicable", {
        sessionId: session.id,
        state: session.state,
        reason: decision.error.code,
      });
      return;
    }
    const outcome = await executeEffects(
      decision.value.effects,
      effectContext(this.ctx, session, {
        create: createPath(this, {
          relay: endpoints.relay,
          proxy: endpoints.proxy,
          provisionBeginAt,
          ...(reservation.nodeId !== "disabled" ? { nodeName: reservation.nodeId } : {}),
        }),
      }),
    );
    if (!isOk(outcome)) {
      log.info("sandbox_provision_stopped", {
        sessionId: session.id,
        status: outcome.status,
        effect: outcome.effect,
        reason: outcome.reason,
      });
    }
  }

  /**
   * `register_relay` for a paid create: the credential the pod will boot with.
   *
   * The token is registered before the pod exists so a relay restart cannot
   * leave a booted guest holding a credential no relay knows; `start_pod` then
   * creates the pod with that same token.
   */
  async registerRelay(session: SessionRecord): Promise<RelayRegistration> {
    return this.pods.registerRelay(session);
  }

  /** `ensure_workspace_pvc`: the volume a suspendable session boots against. */
  async ensureWorkspace(session: SessionRecord): Promise<string | undefined> {
    return this.admission.workspaceFor(session);
  }

  /**
   * `start_pod`, for both create transitions.
   *
   * The shared part is one create. The tails differ in what the guarded write
   * is (`setProvisioning` from PAID, `markResuming` from SUSPENDED), what a lost
   * write has to roll back, and the bookkeeping that follows a started pod, so
   * they are two methods rather than one with a mode flag.
   */
  async startPod(
    session: SessionRecord,
    registration: RelayRegistration,
    request: StartPodRequest,
  ): Promise<boolean> {
    return request.resume
      ? this.startResumePod(session, registration, request)
      : this.startProvisionPod(session, registration, request);
  }

  private async startProvisionPod(
    session: SessionRecord,
    registration: RelayRegistration,
    request: StartPodRequest,
  ): Promise<boolean> {
    // The warm path stays inline, on purpose: a claim is pick + reserve +
    // relabel + a rewritten claim message against a pooled pod, and a second
    // implementation here would drift from the pool's own bookkeeping. The
    // table decides that a warm claim is allowed (a suspendable session cannot
    // take one, its volume is immutable at claim time); the pool decides
    // whether it can serve one, and a miss falls through to a cold create.
    const provisionBeginAt = request.provisionBeginAt ?? this.ctx.now();
    if (
      request.warm &&
      (await this.warm.tryClaim(session, request.relay, request.proxy, provisionBeginAt))
    ) {
      return true;
    }

    // A pod Kubernetes already has (the controller died after the create) is
    // adopted instead of a second create; adoption writes the row itself.
    if (await this.pods.adoptExistingPod(session)) return true;

    // The volume this create mounts: the one `ensure_workspace_pvc` just made,
    // or the one the row already names from an earlier attempt.
    const workspacePvc = request.workspacePvc ?? session.workspacePvc ?? undefined;
    const { podName, createStarted, relayGeneration } = await this.createPod(
      session,
      request.relay,
      request.proxy,
      {
        ...(workspacePvc ? { workspacePvc } : {}),
        ...(request.nodeName ? { nodeName: request.nodeName } : {}),
        registration,
      },
    );
    if (!this.ctx.store.setProvisioning(session.id, podName)) return false;
    this.ctx.capacity.updatePod(session.id, podName);
    this.ctx.store.mergeTimings(session.id, { podCreateCallMs: Date.now() - createStarted });
    this.pods.recordGeneration(session.id, relayGeneration);
    metrics
      .histogram("sandbox_provision_duration_seconds", "Entitlement to pod create", LATENCY_BUCKETS)
      .observe((Date.now() - (session.paidAt ?? session.createdAt)) / 1000);
    log.info("sandbox_provisioning", {
      sessionId: session.id,
      podName,
      runtimeClass: this.ctx.cfg.runtimeClass,
      tier: session.tier,
      leaseSeconds: session.durationSeconds,
      suspendable: Boolean(session.idlePolicyJson),
    });
    return true;
  }

  private async startResumePod(
    session: SessionRecord,
    registration: RelayRegistration,
    request: StartPodRequest,
  ): Promise<boolean> {
    const { podName } = await this.createPod(session, request.relay, request.proxy, {
      ...(session.workspacePvc ? { workspacePvc: session.workspacePvc } : {}),
      resume: true,
      ...(request.nodeName ? { nodeName: request.nodeName } : {}),
      registration,
    });
    this.ctx.capacity.updatePod(session.id, podName);
    if (!this.ctx.store.markResuming(session.id, podName)) {
      // The row moved on under the create. Return the compute and the pod: the
      // caller retries from SUSPENDED, and a leftover pod would collide with
      // the deterministic name.
      await this.ctx.provisioner.deletePod(podName, 0).catch(() => undefined);
      await this.ctx.relay.purge(session.id).catch(() => undefined);
      this.ctx.capacity.suspend(session.id);
      return false;
    }
    // The reaper may have seen the session as SUSPENDED while the pod was being
    // created and re-suspended the reservation we just admitted. The session is
    // RESUMING now, so reassert the allocation before it is observable as READY
    // with suspended capacity.
    this.ctx.capacity.reassertAllocated(session.id);
    metrics.counter("sandbox_sessions_resumed_total", "Sessions resumed").inc();
    log.info("sandbox_resuming", {
      sessionId: session.id,
      podName,
      resumeCount: session.resumeCount + 1,
    });
    return true;
  }

  /**
   * Build the pod spec and create the pod.
   *
   * `start_pod` uses it after `register_relay` has staged the credential; a
   * caller with no transition of its own (a replacement) omits the registration
   * and the credential is minted here.
   */
  async createPod(
    session: SessionRecord,
    relayAddr: { host: string; port: number },
    proxyAddr: { host: string; port: number },
    opts: {
      workspacePvc?: string;
      resume?: boolean;
      nodeName?: string;
      registration?: RelayRegistration;
    } = {},
  ): Promise<{ podName: string; createStarted: number; relayGeneration: string }> {
    return this.pods.createPod(session, relayAddr, proxyAddr, opts);
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
        const generationAtCreate = this.pods.generationFor(session.id) ?? null;
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
          if (await this.pods.recreatePod(session)) return;
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
            this.pods.forgetGeneration(session.id);
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

    await this.podStatus.reconcile(session);
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
