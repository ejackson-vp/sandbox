/**
 * Provisioning use case: cold pod or warm claim, then the readiness handshake.
 *
 * Both create transitions run through the table: `PAID + provision_requested`
 * and `SUSPENDED + resume_requested` return the effect list, and this class is
 * the `CreatePath` those effects are executed against (`register_relay`,
 * `ensure_workspace_pvc`, `start_pod`). Admission is the shell's work and stays
 * in front of each transition: a session whose relay, slot, reservation or shard
 * endpoint is not ready returns from its current state and is retried.
 *
 * This module is the create half only. The readiness handshake that turns
 * `guest_ready` into READY lives in `provisioning/readiness.ts`, because it is a
 * different use case with its own timeouts and its own failure path.
 */
import { lifetimeExpired, transition } from "@x402s/shared/protocol";
import { LATENCY_BUCKETS, log, metrics } from "@x402s/shared/runtime";
import { sessionRuntime } from "./config.js";
import type { SessionRecord } from "./store/models.js";
import { snapshotOf } from "./session-snapshot.js";
import type { WarmPoolManager } from "./warm-pool-manager.js";
import { createPath, effectContext, executeEffects, isOk } from "./effects.js";
import type { CreatePath, StartPodRequest } from "./effects.js";
import { DataPlaneEndpoints } from "./provisioning/endpoints.js";
import type { EndpointPair, RelayRegistration } from "./provisioning/endpoints.js";
import { PodCreation } from "./provisioning/pod-creation.js";
import { ProvisioningAdmission } from "./provisioning/admission.js";
import { PodStatus } from "./provisioning/pod-status.js";
import { Readiness } from "./provisioning/readiness.js";
import type { ProvisioningContext } from "./provisioning/context.js";

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
  /** The handshake that turns `guest_ready` into READY. */
  private readonly readiness: Readiness;

  constructor(
    private readonly ctx: ProvisioningContext,
    private readonly warm: WarmPoolManager,
    /** Shared with the warm pool so a warm and a cold guest dial the same address. */
    endpoints?: DataPlaneEndpoints,
  ) {
    this.endpoints = endpoints ?? new DataPlaneEndpoints(ctx);
    this.admission = new ProvisioningAdmission(ctx);
    this.pods = new PodCreation({ ...ctx, endpoints: this.endpoints });
    this.podStatus = new PodStatus(ctx);
    this.readiness = new Readiness(ctx, this.pods, this.podStatus);
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
        (await this.ctx.store.listNonTerminal())
          .filter((s) => s.state === "PROVISIONING")
          .map((s) => s.id),
      );
      let occupied = persisted.size;
      for (const id of this.inFlight) {
        if (!persisted.has(id)) occupied += 1;
      }
      if (occupied >= limit) {
        await this.deferForSlot(session);
        return;
      }
      // The read above awaits, so the persisted half of `occupied` can be out
      // of date by the time we get here. That is unchanged in effect: a
      // concurrent pass that starts afterwards sees this id in `inFlight`,
      // because the check below and the claim are still one synchronous step
      // with no await between them.
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

  private async deferForSlot(session: SessionRecord): Promise<void> {
    const queued = session.timingsJson
      ? (JSON.parse(session.timingsJson) as Record<string, unknown>)
      : {};
    if (typeof queued.provisionQueueEnteredAt !== "number") {
      await this.ctx.store.mergeTimings(session.id, { provisionQueueEnteredAt: this.ctx.now() });
    }
    const waited = session.paidAt === null ? 0 : this.ctx.now() - session.paidAt;
    if (this.ctx.cfg.provisionQueueTimeoutMs > 0 && waited > this.ctx.cfg.provisionQueueTimeoutMs) {
      await this.ctx.store.requestTermination(session.id, "failure:provisioning_queue_timeout", {
        code: "provisioning_queue_timeout",
        message: "the provisioning queue did not drain in time",
      });
      log.warn("sandbox_provisioning_queue_timeout", { sessionId: session.id, waitedMs: waited });
    }
  }

  private async provisionWithSlot(session: SessionRecord): Promise<void> {
    // Admission, in front of the transition: a paid session whose profile,
    // relay, slot, reservation or shard endpoint is not ready must stay PAID
    // so the next pass can retry. None of these is an effect, so none of them
    // can leave the row half-moved.
    //
    // The runtime profile comes first: a session that asks for a profile this
    // controller does not run can never be provisioned, so it is terminated
    // before it reserves compute or a provisioning slot.
    const profile = await this.admission.runtimeProfile(session);
    if (!profile) return;
    if (!(await this.admission.relayReady(session))) return;
    const reservation = await this.admission.reserve(session);
    if (!reservation) return;
    const provisionBeginAt = this.ctx.now();
    const endpoints = await this.endpoints.podEndpoints(session);
    if (!endpoints) return;

    if (lifetimeExpired(snapshotOf(session), this.ctx.now())) {
      await this.ctx.store.requestTermination(session.id, "max_lifetime");
      return;
    }

    // A Pod Kubernetes already has from an earlier attempt (the controller died
    // after the create) is adopted before the effect list replays
    // `register_relay`. Replaying it mints a fresh guest token, and the guest
    // that is already running and connected still holds the old one: rotating
    // it under a live guest strands the session on a 401 it can never retry
    // away. Adoption instead moves PAID -> PROVISIONING and `awaitReady`
    // re-registers the row's existing token hash if the relay lost it.
    if (await this.pods.adoptExistingPod(session)) return;

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
    if (!(await this.ctx.store.setProvisioning(session.id, podName))) return false;
    await this.ctx.capacity.updatePod(session.id, podName);
    await this.ctx.store.mergeTimings(session.id, { podCreateCallMs: Date.now() - createStarted });
    this.pods.recordGeneration(session.id, relayGeneration);
    metrics
      .histogram("sandbox_provision_duration_seconds", "Entitlement to pod create", LATENCY_BUCKETS)
      .observe((Date.now() - (session.paidAt ?? session.createdAt)) / 1000);
    log.info("sandbox_provisioning", {
      sessionId: session.id,
      podName,
      runtimeClass: this.ctx.cfg.runtimeClass,
      runtime: sessionRuntime(session),
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
    await this.ctx.capacity.updatePod(session.id, podName);
    if (!(await this.ctx.store.markResuming(session.id, podName))) {
      // The row moved on under the create. Return the compute and the pod: the
      // caller retries from SUSPENDED, and a leftover pod would collide with
      // the deterministic name.
      await this.ctx.provisioner.deletePod(podName, 0).catch(() => undefined);
      await this.ctx.relay.purge(session.id).catch(() => undefined);
      await this.ctx.capacity.suspend(session.id);
      return false;
    }
    // The reaper may have seen the session as SUSPENDED while the pod was being
    // created and re-suspended the reservation we just admitted. The session is
    // RESUMING now, so reassert the allocation before it is observable as READY
    // with suspended capacity.
    await this.ctx.capacity.reassertAllocated(session.id);
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

  /**
   * The readiness handshake lives in its own module: the create half above
   * starts a pod, this half decides when the guest behind it is ready.
   */
  async awaitReady(session: SessionRecord): Promise<void> {
    return this.readiness.awaitReady(session);
  }
}
