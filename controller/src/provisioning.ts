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
import { log } from "@x402s/shared";
import type { ReconcilerContext } from "./reconciler-context.js";
import type { EffectStore, ProvisioningStore } from "./store/ports.js";

type ProvisioningContext = Omit<ReconcilerContext, "store"> & {
  store: ProvisioningStore & EffectStore;
};
import type { SessionRecord } from "./store/models.js";
import { snapshotOf } from "./session-snapshot.js";
import type { WarmPool } from "./warm-pool.js";
import { effectContext, executeEffects } from "./effects.js";
import { DataPlaneEndpoints } from "./provisioning/endpoints.js";
import type { EndpointPair } from "./provisioning/endpoints.js";
import { PodCreation } from "./provisioning/pod-creation.js";
import { ProvisioningAdmission } from "./provisioning/admission.js";
import { PodStatus } from "./provisioning/pod-status.js";

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
    if (!(await this.admission.relayReady(session))) return;
    const reservation = await this.admission.reserve(session);
    if (!reservation) return;
    const provisionBeginAt = this.ctx.now();
    const endpoints = await this.endpoints.podEndpoints(session);
    if (!endpoints) return;
    const { relay: relayAddr, proxy: proxyAddr } = endpoints;

    if (lifetimeExpired(snapshotOf(session), this.ctx.now())) {
      this.ctx.store.requestTermination(session.id, "max_lifetime");
      return;
    }

    const suspendable = Boolean(session.idlePolicyJson);
    let workspacePvc = session.workspacePvc ?? undefined;
    if (suspendable) {
      workspacePvc = await this.admission.workspaceFor(session);
    } else if (await this.warm.tryClaim(session, relayAddr, proxyAddr, provisionBeginAt)) {
      return;
    }

    if (await this.pods.adoptExistingPod(session)) return;

    const { podName, createStarted, relayGeneration } = await this.pods.createPod(session, relayAddr, proxyAddr, {
      ...(workspacePvc ? { workspacePvc } : {}),
      ...(reservation && reservation.nodeId !== "disabled" ? { nodeName: reservation.nodeId } : {}),
    });
    this.ctx.store.setProvisioning(session.id, podName);
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
      suspendable,
    });
  }

  async createPod(
    session: SessionRecord,
    relayAddr: { host: string; port: number },
    proxyAddr: { host: string; port: number },
    opts: { workspacePvc?: string; resume?: boolean; nodeName?: string } = {},
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
            (
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
              )
            ).ok;
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
