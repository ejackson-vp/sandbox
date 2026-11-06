/**
 * Reconciliation loop: the only component that mutates session state.
 *
 *  PAID          -> register relay session + create pod
 *  PROVISIONING  -> READY when the guest hello (with evidence) arrives; the
 *                   immutable lease deadline is set here (ready + duration)
 *  READY/ACTIVE  -> TERMINATING on lease expiry or client destroy
 *  TERMINATING   -> ask the guest to stop, delete the pod, purge relay state,
 *                   then finalise as EXPIRED / DESTROYED / FAILED
 *
 * Deadline enforcement never depends on the untrusted guest cooperating: the
 * controller's clock decides, and pod deletion is the backstop.
 */
import { LATENCY_BUCKETS, metrics, type RelaySessionState, type SessionLimits, type WarmClaim } from "@x402s/shared";
import { randomBytes } from "node:crypto";
import type { ControllerConfig } from "./config.js";
import { GUEST_TOOLS, type Provisioner, type WarmPodInfo } from "./k8s.js";
import type { RelayClient } from "./relay-client.js";
import type { SessionRecord, Store } from "./store.js";
import { newOpaqueToken, sha256Hex } from "./tokens.js";
import { proxyTokenFor } from "./config.js";
import { log } from "./log.js";

export interface ReconcilerDeps {
  cfg: ControllerConfig;
  store: Store;
  provisioner: Provisioner;
  relay: RelayClient;
  now?: () => number;
  /** Override for tests: resolves service addresses without Kubernetes. */
  serviceAddress?: (name: string) => Promise<{ host: string; port: number } | null>;
}

export class Reconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private wakeRequested = false;
  /** Last pod-health probe per session (guards K8s API traffic). */
  private readonly healthCheckedAt = new Map<string, number>();
  /** Consecutive *successful* probes reporting a missing/terminal pod. */
  private readonly healthStrikes = new Map<string, number>();
  /** Warm pods claimed in this tick, before their labels are patched. */
  private readonly warmClaimed = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: ReconcilerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.deps.cfg.reconcileIntervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Event-driven nudge: reconcile now instead of waiting for the next tick.
   * Used after entitlement creation and destroy requests so provisioning and
   * cleanup do not pay a full poll interval.
   */
  wake(): void {
    if (this.running) {
      this.wakeRequested = true;
      return;
    }
    void this.tick();
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const started = Date.now();
    try {
      for (const session of this.deps.store.listNonTerminal()) {
        try {
          await this.reconcileSession(session);
        } catch (err) {
          log.error("reconcile_session_failed", {
            sessionId: session.id,
            state: session.state,
            error: (err as Error).message,
          });
        }
      }
      for (const session of this.deps.store.listTerminalWithPod()) {
        if (!session.podName) continue;
        await this.deps.provisioner.deletePod(session.podName, 0).catch(() => undefined);
        this.deps.store.clearPod(session.id);
      }
      await this.sweepOrphanPods();
      await this.reconcileWarmPool();
      const active = this.deps.store
        .listNonTerminal()
        .filter((s) => s.state === "READY" || s.state === "ACTIVE").length;
      metrics.gauge("sandbox_sessions_active", "Sessions in READY or ACTIVE").set({}, active);
    } catch (err) {
      log.error("reconcile_pass_failed", { error: (err as Error).message });
    } finally {
      metrics
        .histogram("sandbox_reconcile_duration_seconds", "Reconcile pass duration", LATENCY_BUCKETS)
        .observe((Date.now() - started) / 1000);
      this.running = false;
      if (this.wakeRequested) {
        this.wakeRequested = false;
        void this.tick();
      }
    }
  }

  private async reconcileSession(session: SessionRecord): Promise<void> {
    switch (session.state) {
      case "PAID":
        await this.provision(session);
        break;
      case "PROVISIONING":
        await this.awaitReady(session);
        break;
      case "READY":
      case "ACTIVE":
        await this.enforceLease(session);
        break;
      case "TERMINATING":
        await this.terminate(session);
        break;
      default:
        break;
    }
  }

  private async serviceAddress(name: string): Promise<{ host: string; port: number } | null> {
    if (this.deps.serviceAddress) return this.deps.serviceAddress(name);
    return this.deps.provisioner.getServiceAddress(name);
  }

  private async provision(session: SessionRecord): Promise<void> {
    const relayAddr = await this.serviceAddress(this.deps.cfg.relayServiceName);
    const proxyAddr = await this.serviceAddress(this.deps.cfg.proxyServiceName);
    if (!relayAddr || !proxyAddr) {
      log.warn("sandbox_services_unavailable", {
        sessionId: session.id,
        relay: Boolean(relayAddr),
        proxy: Boolean(proxyAddr),
      });
      return;
    }

    if (await this.tryWarmClaim(session, relayAddr, proxyAddr)) return;

    this.deps.store.mergeTimings(session.id, {
      provisionStartAt: Date.now(),
      podRequestedAt: Date.now(),
    });
    const guestToken = newOpaqueToken(32);
    const tokenHash = sha256Hex(guestToken);
    const ttlMs =
      this.deps.cfg.provisioningTimeoutMs + session.durationSeconds * 1000 + 5 * 60_000;
    try {
      await this.deps.relay.register(session.id, tokenHash, ttlMs);
    } catch (err) {
      if ((err as { status?: number }).status !== 409) {
        log.warn("relay_register_failed", { sessionId: session.id, error: (err as Error).message });
        return;
      }
    }
    this.deps.store.setRelayToken(session.id, tokenHash);

    const relayUrl = `ws://${relayAddr.host}:${relayAddr.port}/guest?session=${encodeURIComponent(session.id)}`;
    const proxyUrl = `http://${proxyAddr.host}:${proxyAddr.port}`;

    const createStarted = Date.now();
    const { podName } = await this.deps.provisioner.createPod({
      sessionId: session.id,
      leaseSeconds: session.durationSeconds,
      limits: session.limits,
      clientPublicKey: session.clientPublicKey,
      clientNonce: session.clientNonce,
      guestToken,
      relayUrl,
      relayHost: relayAddr.host,
      relayPort: relayAddr.port,
      proxyUrl,
      proxyToken: proxyTokenFor(this.deps.cfg, session.id),
      image: this.deps.cfg.guestImage,
      imageDigest: this.deps.cfg.guestImageDigest,
      runtimeClass: this.deps.cfg.runtimeClass,
      executionMode: this.deps.cfg.executionMode,
      workspaceDir: this.deps.cfg.workspaceDir,
    });

    this.deps.store.setProvisioning(session.id, podName);
    this.deps.store.mergeTimings(session.id, { podCreateCallMs: Date.now() - createStarted });
    metrics
      .histogram("sandbox_provision_duration_seconds", "Entitlement to pod create", LATENCY_BUCKETS)
      .observe((Date.now() - (session.paidAt ?? session.createdAt)) / 1000);
    log.info("sandbox_provisioning", {
      sessionId: session.id,
      podName,
      runtimeClass: this.deps.cfg.runtimeClass,
      tier: session.tier,
      leaseSeconds: session.durationSeconds,
    });
  }

  private warmPoolLimits(): SessionLimits {
    const def = this.deps.cfg.tiers[this.deps.cfg.warmPoolTier];
    const platform = this.deps.cfg.platformLimits;
    return {
      cpuMillis: def.cpuMillis,
      memoryMiB: def.memoryMiB,
      diskMiB: def.diskMiB,
      maxOutputBytes: platform.maxOutputBytes,
      maxFileBytes: platform.maxFileBytes,
      maxCommandSeconds: Math.min(platform.maxCommandSeconds, def.durationSeconds),
      maxProcesses: platform.maxProcesses,
    };
  }

  /**
   * A warm pod is sized by its cgroup and emptyDir limits. Everything else
   * (output, file size, process count, command timeout) is re-sent in the
   * claim and enforced by the guest, so only the pod-shaped limits must fit.
   */
  private warmLimitsFit(need: SessionLimits, have: SessionLimits): boolean {
    return (
      need.cpuMillis <= have.cpuMillis &&
      need.memoryMiB <= have.memoryMiB &&
      need.diskMiB <= have.diskMiB
    );
  }

  private async tryWarmClaim(
    session: SessionRecord,
    relayAddr: { host: string; port: number },
    proxyAddr: { host: string; port: number },
  ): Promise<boolean> {
    const cfg = this.deps.cfg;
    if (cfg.warmPoolSize === 0) return false;
    if (!this.warmLimitsFit(session.limits, this.warmPoolLimits())) {
      metrics.counter("sandbox_warm_pool_total", "Warm pool claim outcomes").inc({ result: "miss_limits" });
      return false;
    }

    const warm = await this.pickWarmPod();
    if (!warm) {
      metrics.counter("sandbox_warm_pool_total", "Warm pool claim outcomes").inc({ result: "miss_empty" });
      return false;
    }
    // Reserve it immediately so a second session in this tick cannot take it.
    this.warmClaimed.add(warm.warmId);

    const guestToken = newOpaqueToken(32);
    const tokenHash = sha256Hex(guestToken);
    const ttlMs = cfg.provisioningTimeoutMs + session.durationSeconds * 1000 + 5 * 60_000;
    try {
      await this.deps.relay.register(session.id, tokenHash, ttlMs);
    } catch (err) {
      if ((err as { status?: number }).status !== 409) {
        log.warn("warm_relay_register_failed", { sessionId: session.id, error: (err as Error).message });
        this.warmClaimed.delete(warm.warmId);
        return false;
      }
    }
    this.deps.store.setRelayToken(session.id, tokenHash);

    const claim: WarmClaim = {
      sessionId: session.id,
      relayUrl: `ws://${relayAddr.host}:${relayAddr.port}/guest?session=${encodeURIComponent(session.id)}`,
      guestToken,
      clientPublicKey: session.clientPublicKey,
      clientNonce: session.clientNonce,
      leaseSeconds: session.durationSeconds,
      executionMode: cfg.executionMode,
      runtimeClass: cfg.runtimeClass,
      imageDigest: cfg.guestImageDigest,
      proxyUrl: `http://${proxyAddr.host}:${proxyAddr.port}`,
      proxyToken: proxyTokenFor(cfg, session.id),
      maxOutputBytes: session.limits.maxOutputBytes,
      maxFileBytes: session.limits.maxFileBytes,
      maxDiskMiB: session.limits.diskMiB,
      maxCommandSeconds: session.limits.maxCommandSeconds,
      maxProcesses: session.limits.maxProcesses,
      tools: GUEST_TOOLS.join(","),
    };

    try {
      await this.deps.relay.claim(warm.poolId, claim);
    } catch (err) {
      log.warn("warm_claim_failed", { sessionId: session.id, warmId: warm.warmId, error: (err as Error).message });
      this.warmClaimed.delete(warm.warmId);
      await this.deps.provisioner.deletePod(warm.name, 0).catch(() => undefined);
      await this.deps.relay.purge(warm.poolId).catch(() => undefined);
      return false;
    }

    // The guest accepted the claim and is reconnecting as the real session.
    // Relabel before the next sweep so the pod is owned by that session.
    try {
      await this.deps.provisioner.patchPodLabels(warm.name, {
        "x402.io/pool": "sandbox",
        "x402.io/session": session.id,
        "x402.io/warm-claimed": "true",
      });
    } catch (err) {
      log.warn("warm_relabel_failed", { sessionId: session.id, warmId: warm.warmId, error: (err as Error).message });
      this.warmClaimed.delete(warm.warmId);
      await this.deps.provisioner.deletePod(warm.name, 0).catch(() => undefined);
      await this.deps.relay.purge(session.id).catch(() => undefined);
      return false;
    }

    if (!this.deps.store.setProvisioning(session.id, warm.name)) {
      // The session moved on (destroyed, reaped) between selection and here.
      this.warmClaimed.delete(warm.warmId);
      await this.deps.provisioner.deletePod(warm.name, 0).catch(() => undefined);
      await this.deps.relay.purge(session.id).catch(() => undefined);
      return false;
    }

    const claimedAt = this.now();
    this.deps.store.mergeTimings(session.id, {
      provisionStartAt: claimedAt,
      podRequestedAt: claimedAt,
      warmClaimAt: claimedAt,
      warmPoolHit: 1,
    });
    this.warmClaimed.delete(warm.warmId);
    // The pooled identity is dead the moment the guest reconnects.
    await this.deps.relay.purge(warm.poolId).catch(() => undefined);
    metrics.counter("sandbox_warm_pool_total", "Warm pool claim outcomes").inc({ result: "hit" });
    log.info("sandbox_warm_claimed", {
      sessionId: session.id,
      warmId: warm.warmId,
      podName: warm.name,
    });
    return true;
  }

  private async pickWarmPod(): Promise<WarmPodInfo | null> {
    let pods: WarmPodInfo[];
    try {
      pods = await this.deps.provisioner.listWarmPods();
    } catch (err) {
      log.warn("warm_pool_list_failed", { error: (err as Error).message });
      return null;
    }
    const now = this.now();
    for (const pod of pods) {
      if (!pod.warmId || this.warmClaimed.has(pod.warmId)) continue;
      if (pod.phase !== "Running" && pod.phase !== "Pending") continue;
      if (pod.createdAt > 0 && now - pod.createdAt > this.deps.cfg.warmPoolTtlMs) continue;
      try {
        const state = await this.deps.relay.state(pod.poolId);
        // `attestation` here is the *pool* hello, not customer evidence. The
        // real session hello (with its own binding) arrives after the claim
        // and is what the session is judged on.
        if (state.registered && state.connected && state.attestation) return pod;
      } catch {
        /* try the next pod */
      }
    }
    return null;
  }

  /** Keep the pool topped up and recycle stale, dead or unrecoverable pods. */
  private async reconcileWarmPool(): Promise<void> {
    const cfg = this.deps.cfg;
    let pods: WarmPodInfo[];
    try {
      pods = await this.deps.provisioner.listWarmPods();
    } catch {
      return;
    }
    if (pods.length === 0 && cfg.warmPoolSize === 0) return;

    const now = this.now();
    let live = 0;
    for (const pod of pods) {
      if (!pod.warmId) continue;
      if (this.warmClaimed.has(pod.warmId)) {
        live++;
        continue;
      }
      const dead = pod.phase === "Failed" || pod.phase === "Succeeded";
      const tooOld = pod.createdAt > 0 && now - pod.createdAt > cfg.warmPoolTtlMs;
      const scaleDown = cfg.warmPoolSize === 0;
      if (dead || tooOld || scaleDown) {
        await this.deps.provisioner.deletePod(pod.name, 0).catch(() => undefined);
        await this.deps.relay.purge(pod.poolId).catch(() => undefined);
        log.info("warm_pod_recycled", {
          podName: pod.name,
          reason: scaleDown ? "scale_down" : dead ? "dead" : "ttl",
        });
        continue;
      }
      // A pool pod created before a controller/relay restart has no known
      // token hash; it can never authenticate again, so recycle it.
      const state = await this.deps.relay.state(pod.poolId).catch(() => null);
      if (state && !state.registered && pod.createdAt > 0 && now - pod.createdAt > 30_000) {
        await this.deps.provisioner.deletePod(pod.name, 0).catch(() => undefined);
        log.info("warm_pod_recycled", { podName: pod.name, reason: "unregistered" });
        continue;
      }
      live++;
    }

    metrics.gauge("sandbox_warm_pool_pods", "Warm pool pods (live)").set({}, live);
    if (cfg.warmPoolSize === 0) return;

    const missing = Math.max(0, cfg.warmPoolSize - live);
    if (missing === 0) return;

    const relayAddr = await this.serviceAddress(cfg.relayServiceName);
    const proxyAddr = await this.serviceAddress(cfg.proxyServiceName);
    if (!relayAddr || !proxyAddr) return;
    // Bounded per pass so a large pool does not burst the kubelet.
    for (let i = 0; i < Math.min(missing, 2); i++) {
      await this.createWarmPod(relayAddr, proxyAddr);
    }
  }

  private async createWarmPod(
    relayAddr: { host: string; port: number },
    proxyAddr: { host: string; port: number },
  ): Promise<void> {
    const cfg = this.deps.cfg;
    const warmId = randomBytes(6).toString("hex");
    const poolId = `warm_${warmId}`;
    const guestToken = newOpaqueToken(32);
    const tokenHash = sha256Hex(guestToken);
    const ttlMs = cfg.warmPoolTtlMs + 120_000;
    try {
      await this.deps.relay.register(poolId, tokenHash, ttlMs);
    } catch (err) {
      log.warn("warm_relay_register_failed", { poolId, error: (err as Error).message });
      return;
    }
    try {
      await this.deps.provisioner.createWarmPod({
        warmId,
        poolId,
        ttlMs,
        limits: this.warmPoolLimits(),
        guestToken,
        relayUrl: `ws://${relayAddr.host}:${relayAddr.port}/guest?session=${encodeURIComponent(poolId)}`,
        proxyUrl: `http://${proxyAddr.host}:${proxyAddr.port}`,
        proxyToken: proxyTokenFor(cfg, poolId),
        image: cfg.guestImage,
        imageDigest: cfg.guestImageDigest,
        runtimeClass: cfg.runtimeClass,
        executionMode: cfg.executionMode,
        workspaceDir: cfg.workspaceDir,
        tools: GUEST_TOOLS.join(","),
      });
      metrics.counter("sandbox_warm_pool_created_total", "Warm pods created").inc();
    } catch (err) {
      await this.deps.relay.purge(poolId).catch(() => undefined);
      log.warn("warm_pod_create_failed", { warmId, error: (err as Error).message });
    }
  }

  private async awaitReady(session: SessionRecord): Promise<void> {
    const timings = session.timingsJson ? (JSON.parse(session.timingsJson) as Record<string, unknown>) : {};
    if (
      timings.warmPoolHit === 1 &&
      typeof timings.warmClaimAt === "number" &&
      this.now() - timings.warmClaimAt > this.deps.cfg.warmClaimTimeoutMs
    ) {
      this.deps.store.requestTermination(session.id, "failure:warm_claim_timeout", {
        code: "warm_claim_timeout",
        message: "the warm sandbox did not attach to the session in time",
      });
      log.warn("sandbox_warm_claim_timeout", {
        sessionId: session.id,
        warmClaimAt: timings.warmClaimAt,
      });
      return;
    }

    const age = this.now() - (session.paidAt ?? session.createdAt);
    if (age > this.deps.cfg.provisioningTimeoutMs) {
      this.deps.store.requestTermination(session.id, "failure:provisioning_timeout", {
        code: "provisioning_timeout",
        message: "sandbox did not become ready in time",
      });
      log.warn("sandbox_provisioning_timeout", { sessionId: session.id, ageMs: age });
      return;
    }

    if (session.relayTokenHash) {
      try {
        const state = await this.deps.relay.state(session.id);
        if (!state.registered) {
          await this.deps.relay.register(
            session.id,
            session.relayTokenHash,
            this.deps.cfg.provisioningTimeoutMs + session.durationSeconds * 1000 + 300_000,
          );
        }
        if (state.connected && state.attestation) {
          const readyAt = this.now();
          const leaseExpiresAt = readyAt + session.durationSeconds * 1000;
          const ok = this.deps.store.setReady(
            session.id,
            readyAt,
            leaseExpiresAt,
            JSON.stringify(state.attestation),
            state.attestation.guestPublicKey,
          );
          if (ok) {
            const warm = timings.warmPoolHit === 1;
            const podInfo = warm || !session.podName
              ? null
              : await this.deps.provisioner.getPod(session.podName).catch(() => null);
            this.deps.store.mergeTimings(session.id, {
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
              .observe((readyAt - (session.paidAt ?? session.createdAt)) / 1000);
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
      const pod = await this.deps.provisioner.getPod(session.podName).catch(() => null);
      if (pod && pod.phase === "Running") {
        // Record the first observation of a running container (tick resolution).
        const timings = session.timingsJson ? (JSON.parse(session.timingsJson) as Record<string, unknown>) : {};
        if (!timings.podRunningObservedAt && timings.warmPoolHit !== 1) {
          this.deps.store.mergeTimings(session.id, { podRunningObservedAt: this.now() });
        }
      }
      if (pod && (pod.phase === "Failed" || pod.phase === "Succeeded")) {
        this.deps.store.requestTermination(session.id, "failure:pod_terminated", {
          code: "pod_terminated",
          message: `pod reached phase ${pod.phase}`,
        });
      }
    }
  }

  private async enforceLease(session: SessionRecord): Promise<void> {
    if (session.destroyRequested) {
      this.deps.store.requestTermination(session.id, "client_destroy");
      return;
    }

    // Detect a dead guest/pod between operations (crash, OOM, relay loss).
    // Probed at most every 2s per session to bound Kubernetes API traffic.
    //
    // Safety: a *failed probe* (API timeout, 429, connection reset) must never
    // terminate a paid session. Only a successful read that reports the pod
    // missing or terminal counts, and it must happen twice in a row. This was
    // found by the density benchmark: an earlier version treated a transient
    // Kubernetes error as "pod gone" and mass-terminated 20 sessions.
    const readyAt = session.readyAt ?? 0;
    if (session.podName && this.now() - readyAt > 2000 && this.now() - (this.healthCheckedAt.get(session.id) ?? 0) > 2000) {
      this.healthCheckedAt.set(session.id, this.now());
      try {
        const pod = await this.deps.provisioner.getPod(session.podName);
        if (!pod || pod.phase === "Failed" || pod.phase === "Succeeded") {
          const strikes = (this.healthStrikes.get(session.id) ?? 0) + 1;
          this.healthStrikes.set(session.id, strikes);
          if (strikes >= 2) {
            this.deps.store.requestTermination(session.id, "failure:guest_exited", {
              code: "guest_exited",
              message: "the sandbox guest exited before the lease ended",
            });
            this.healthStrikes.delete(session.id);
            return;
          }
        } else {
          this.healthStrikes.delete(session.id);
        }
      } catch (err) {
        log.warn("pod_health_probe_failed", { sessionId: session.id, error: (err as Error).message });
      }
    }
    const deadline = session.leaseExpiresAt;
    if (deadline === null) return;
    const now = this.now();
    if (now > deadline + this.deps.cfg.leaseGraceMs) {
      this.deps.store.requestTermination(session.id, "lease_expired");
      log.warn("sandbox_lease_expired", { sessionId: session.id, state: session.state, overrunMs: now - deadline });
    }
  }

  private async terminate(session: SessionRecord): Promise<void> {
    const cleanupStarted = session.terminatingAt ?? this.now();
    // Ask the guest to stop so it can kill descendants before the pod goes away.
    try {
      await this.deps.relay.shutdown(session.id, session.terminationReason ?? "terminated");
    } catch {
      /* relay may already be gone */
    }

    if (session.podName) {
      await this.deps.provisioner.deletePod(session.podName, 1).catch(() => undefined);
      this.deps.store.clearPod(session.id);
    }
    if (session.relayPurgedAt === null) {
      try {
        await this.deps.relay.purge(session.id);
        this.deps.store.markRelayPurged(session.id);
      } catch (err) {
        log.warn("relay_purge_failed", { sessionId: session.id, error: (err as Error).message });
      }
    }
    const cleanupMs = Date.now() - cleanupStarted;
    this.deps.store.mergeTimings(session.id, {
      terminationStartedAt: cleanupStarted,
      podDeletedAt: Date.now(),
      cleanupMs,
    });
    metrics
      .histogram("sandbox_cleanup_duration_seconds", "TERMINATING to cleanup complete", LATENCY_BUCKETS)
      .observe(cleanupMs / 1000);
    this.healthCheckedAt.delete(session.id);
    this.healthStrikes.delete(session.id);
    const finalState = this.deps.store.finalizeTermination(session.id);
    if (finalState === "FAILED" || finalState === "EXPIRED") {
      metrics
        .counter("sandbox_sessions_failed_total", "Sessions that ended in FAILED or EXPIRED")
        .inc({ final_state: finalState, reason: (session.terminationReason ?? "unknown").split(":")[0]! });
    }
    log.info("sandbox_destroyed", {
      sessionId: session.id,
      state: finalState ?? "unknown",
      reason: session.terminationReason ?? "unknown",
    });
  }

  /** Delete pods that no session owns, or that outlived every possible deadline. */
  private async sweepOrphanPods(): Promise<void> {
    let pods;
    try {
      pods = await this.deps.provisioner.listSandboxPods();
    } catch {
      return;
    }
    const now = this.now();
    for (const pod of pods) {
      const session = pod.sessionId ? this.deps.store.getSession(pod.sessionId) : null;
      const terminal =
        !session || ["DESTROYED", "EXPIRED", "FAILED", "TERMINATING"].includes(session.state);
      const tooOld = pod.createdAt > 0 && now - pod.createdAt > this.deps.cfg.maxPodAgeMs;
      if (terminal || tooOld) {
        await this.deps.provisioner.deletePod(pod.name, 0).catch(() => undefined);
        log.warn("orphan_pod_reaped", {
          podName: pod.name,
          sessionId: pod.sessionId || undefined,
          reason: terminal ? "no_live_session" : "max_age",
        });
        if (session && session.state !== "TERMINATING") {
          this.deps.store.requestTermination(session.id, "failure:reaped", {
            code: "reaped",
            message: "sandbox exceeded the maximum pod age",
          });
        }
      }
    }
  }
}

export type { RelaySessionState };
