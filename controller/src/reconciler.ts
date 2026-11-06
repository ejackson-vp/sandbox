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

export class LifecycleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 409,
  ) {
    super(message);
    this.name = "LifecycleError";
  }
}

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
  private housekeepingTimer: NodeJS.Timeout | null = null;
  private housekeepingRunning = false;
  private running = false;
  private wakeRequested = false;
  /** Last pod-health probe per session (guards K8s API traffic). */
  private readonly healthCheckedAt = new Map<string, number>();
  /** Consecutive *successful* probes reporting a missing/terminal pod. */
  private readonly healthStrikes = new Map<string, number>();
  /** ClusterIPs are stable; avoid two K8s Service reads on every provision. */
  private readonly serviceCache = new Map<string, { host: string; port: number; at: number }>();
  /** Warm pods claimed in this tick, before their labels are patched. */
  private readonly warmClaimed = new Set<string>();
  /** Short-lived cache of pool pods, refreshed by the 1s housekeeping pass. */
  private warmCache: { pods: WarmPodInfo[]; at: number } | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: ReconcilerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.deps.cfg.reconcileIntervalMs);
    // Pool replenishment and orphan sweeping are deliberately on a slower,
    // separate timer: they must never sit in front of a paid session's
    // readiness tick (the wake path is measured in single-digit ms).
    this.housekeepingTimer = setInterval(() => {
      void this.housekeeping();
    }, 1_000);
    void this.tick();
    void this.housekeeping();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.housekeepingTimer) clearInterval(this.housekeepingTimer);
    this.timer = null;
    this.housekeepingTimer = null;
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
      const nonTerminal = this.deps.store.listNonTerminal();
      const active = nonTerminal.filter((s) => s.state === "READY" || s.state === "ACTIVE").length;
      const provisioning = nonTerminal.filter((s) => s.state === "PROVISIONING").length;
      const queued = nonTerminal.filter((s) => s.state === "PAID").length;
      metrics.gauge("sandbox_sessions_active", "Sessions in READY or ACTIVE").set({}, active);
      metrics.gauge("sandbox_provisioning_active", "Sessions in PROVISIONING").set({}, provisioning);
      metrics.gauge("sandbox_provisioning_queued", "PAID sessions waiting for a provisioning slot").set({}, queued);
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

  /** Slow path: pool replenishment and orphan reaping, off the readiness tick. */
  private async housekeeping(): Promise<void> {
    if (this.housekeepingRunning) return;
    this.housekeepingRunning = true;
    try {
      await this.sweepOrphanPods();
      await this.reconcileWarmPool();
      await this.enforceLifecyclePolicies();
      await this.cleanupTerminalPvcs();
    } catch (err) {
      log.warn("housekeeping_failed", { error: (err as Error).message });
    } finally {
      this.housekeepingRunning = false;
    }
  }

  /** Idle suspension, suspended expiry, and the wall-clock lifetime cap. */
  private async enforceLifecyclePolicies(): Promise<void> {
    const now = this.now();
    for (const session of this.deps.store.listNonTerminal()) {
      if (this.lifetimeExceeded(session)) {
        this.deps.store.requestTermination(session.id, "max_lifetime");
        continue;
      }
      const idle = session.idlePolicyJson
        ? (JSON.parse(session.idlePolicyJson) as {
            maxIdleSeconds?: number;
            suspendedDurationSeconds?: number;
          })
        : null;
      if (
        idle?.maxIdleSeconds &&
        (session.state === "READY" || session.state === "ACTIVE") &&
        session.lastActivityAt &&
        now - session.lastActivityAt > idle.maxIdleSeconds * 1000
      ) {
        try {
          await this.suspendSession(session.id);
        } catch (err) {
          log.warn("auto_suspend_failed", { sessionId: session.id, error: (err as Error).message });
        }
        continue;
      }
      if (
        idle?.suspendedDurationSeconds &&
        session.state === "SUSPENDED" &&
        session.suspendedAt &&
        now - session.suspendedAt > idle.suspendedDurationSeconds * 1000
      ) {
        this.deps.store.requestTermination(session.id, "suspended_expired");
      }
    }
  }

  private async cleanupTerminalPvcs(): Promise<void> {
    for (const session of this.deps.store.listTerminalWithPvc()) {
      if (!session.workspacePvc) continue;
      await this.deps.provisioner.deleteWorkspacePvc(session.workspacePvc).catch(() => undefined);
      this.deps.store.clearWorkspacePvc(session.id);
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
    const cached = this.serviceCache.get(name);
    if (cached && this.now() - cached.at < 30_000) {
      return { host: cached.host, port: cached.port };
    }
    const addr = this.deps.serviceAddress
      ? await this.deps.serviceAddress(name)
      : await this.deps.provisioner.getServiceAddress(name);
    if (addr) this.serviceCache.set(name, { ...addr, at: this.now() });
    return addr;
  }

  private async provision(session: SessionRecord): Promise<void> {
    const limit = this.deps.cfg.maxConcurrentProvisioning;
    if (limit > 0) {
      const active = this.deps.store
        .listNonTerminal()
        .filter((s) => s.state === "PROVISIONING").length;
      if (active >= limit) {
        const waited = session.paidAt === null ? 0 : this.now() - session.paidAt;
        if (this.deps.cfg.provisionQueueTimeoutMs > 0 && waited > this.deps.cfg.provisionQueueTimeoutMs) {
          this.deps.store.requestTermination(session.id, "failure:provisioning_queue_timeout", {
            code: "provisioning_queue_timeout",
            message: "the provisioning queue did not drain in time",
          });
          log.warn("sandbox_provisioning_queue_timeout", { sessionId: session.id, waitedMs: waited });
        }
        return;
      }
    }
    const provisionBeginAt = this.now();
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

    if (this.lifetimeExceeded(session)) {
      this.deps.store.requestTermination(session.id, "max_lifetime");
      return;
    }

    const suspendable = Boolean(session.idlePolicyJson);
    let workspacePvc = session.workspacePvc ?? undefined;
    if (suspendable) {
      // A checkpointed session needs its workspace to outlive the pod. It also
      // cannot use a warm pod: volumes are immutable at claim time.
      if (!workspacePvc) {
        workspacePvc = await this.deps.provisioner.createWorkspacePvc(session.id, session.limits.diskMiB);
        this.deps.store.setWorkspacePvc(session.id, workspacePvc);
      } else if (!(await this.deps.provisioner.workspacePvcExists(workspacePvc).catch(() => false))) {
        // A stale name from a failed attempt; create a fresh PVC rather than
        // leaving the first pod Pending forever.
        workspacePvc = await this.deps.provisioner.createWorkspacePvc(session.id, session.limits.diskMiB);
        this.deps.store.setWorkspacePvc(session.id, workspacePvc);
      }
    } else if (await this.tryWarmClaim(session, relayAddr, proxyAddr, provisionBeginAt)) {
      return;
    }

    const { podName, createStarted } = await this.createSandboxPod(session, relayAddr, proxyAddr, {
      ...(workspacePvc ? { workspacePvc } : {}),
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
      suspendable,
    });
  }

  private async createSandboxPod(
    session: SessionRecord,
    relayAddr: { host: string; port: number },
    proxyAddr: { host: string; port: number },
    opts: { workspacePvc?: string; resume?: boolean; nodeName?: string } = {},
  ): Promise<{ podName: string; createStarted: number }> {
    this.deps.store.mergeTimings(session.id, {
      provisionStartAt: Date.now(),
      podRequestedAt: Date.now(),
    });
    const guestToken = newOpaqueToken(32);
    const tokenHash = sha256Hex(guestToken);
    const ttlMs = this.deps.cfg.provisioningTimeoutMs + session.durationSeconds * 1000 + 5 * 60_000;
    try {
      await this.deps.relay.register(session.id, tokenHash, ttlMs);
    } catch (err) {
      if ((err as { status?: number }).status === 409) {
        // A resumed session may still have a stale relay entry (purge raced a
        // relay restart). Replace it so the new guest token is the valid one.
        await this.deps.relay.purge(session.id).catch(() => undefined);
        await this.deps.relay.register(session.id, tokenHash, ttlMs);
      } else {
        throw err;
      }
    }
    this.deps.store.setRelayToken(session.id, tokenHash);

    const createStarted = Date.now();
    const { podName } = await this.deps.provisioner.createPod({
      sessionId: session.id,
      leaseSeconds: session.durationSeconds,
      limits: session.limits,
      clientPublicKey: session.clientPublicKey,
      clientNonce: session.clientNonce,
      guestToken,
      relayUrl: `ws://${relayAddr.host}:${relayAddr.port}/guest?session=${encodeURIComponent(session.id)}`,
      relayHost: relayAddr.host,
      relayPort: relayAddr.port,
      proxyUrl: `http://${proxyAddr.host}:${proxyAddr.port}`,
      proxyToken: proxyTokenFor(this.deps.cfg, session.id),
      image: this.deps.cfg.guestImage,
      imageDigest: this.deps.cfg.guestImageDigest,
      runtimeClass: this.deps.cfg.runtimeClass,
      executionMode: this.deps.cfg.executionMode,
      workspaceDir: this.deps.cfg.workspaceDir,
      ...(opts.workspacePvc ? { workspacePvc: opts.workspacePvc } : {}),
      ...(opts.resume ? { resume: true } : {}),
      ...(session.baselineCpuMillis ? { baselineCpuMillis: session.baselineCpuMillis } : {}),
      ...(session.baselineMemoryMib ? { baselineMemoryMiB: session.baselineMemoryMib } : {}),
      ...(opts.nodeName ? { nodeName: opts.nodeName } : {}),
    });
    return { podName, createStarted };
  }

  private lifetimeExceeded(session: SessionRecord): boolean {
    return Boolean(
      session.maxLifetimeSeconds &&
        this.now() - session.createdAt > session.maxLifetimeSeconds * 1000,
    );
  }

  /**
   * Checkpoint a live session: stop the workload, keep its workspace PVC, and
   * release compute. There is no memory snapshot in this mode; the guest is
   * booted fresh on resume and sees the persisted files.
   */
  async suspendSession(id: string): Promise<void> {
    const session = this.deps.store.getSession(id);
    if (!session) throw new LifecycleError("not_found", "session not found", 404);
    if (session.state !== "READY" && session.state !== "ACTIVE") {
      throw new LifecycleError("not_suspendable", `session is ${session.state}`, 409);
    }
    if (!session.workspacePvc) {
      throw new LifecycleError("not_suspendable", "session has no persistent workspace", 409);
    }
    try {
      await this.deps.relay.shutdown(id, "suspend");
    } catch {
      /* relay may already be gone */
    }
    if (session.podName) {
      if (!session.nodeName && session.workspacePvc) {
        const pod = await this.deps.provisioner.getPod(session.podName).catch(() => null);
        if (pod?.nodeName) {
          this.deps.store.setNodeName(id, pod.nodeName);
          session.nodeName = pod.nodeName;
        }
      }
      await this.deps.provisioner.suspendPod(session.podName);
      this.deps.store.clearPod(id);
    }
    const suspendedAt = this.now();
    if (!this.deps.store.markSuspended(id, suspendedAt)) {
      throw new LifecycleError("not_suspendable", "session changed state while suspending", 409);
    }
    await this.deps.relay.purge(id).catch(() => undefined);
    metrics.counter("sandbox_sessions_suspended_total", "Sessions suspended").inc();
    log.info("sandbox_suspended", { sessionId: id, suspendedAt });
  }

  /** Boot a fresh guest against the persisted workspace. */
  async resumeSession(id: string): Promise<void> {
    const session = this.deps.store.getSession(id);
    if (!session) throw new LifecycleError("not_found", "session not found", 404);
    if (session.state !== "SUSPENDED") {
      throw new LifecycleError("not_suspended", `session is ${session.state}`, 409);
    }
    if (this.lifetimeExceeded(session)) {
      this.deps.store.requestTermination(id, "max_lifetime");
      throw new LifecycleError("max_lifetime", "session exceeded its maximum lifetime", 409);
    }
    const idle = session.idlePolicyJson
      ? (JSON.parse(session.idlePolicyJson) as { suspendedDurationSeconds?: number })
      : {};
    if (
      idle.suspendedDurationSeconds &&
      session.suspendedAt &&
      this.now() - session.suspendedAt > idle.suspendedDurationSeconds * 1000
    ) {
      this.deps.store.requestTermination(id, "suspended_expired");
      throw new LifecycleError("suspended_expired", "session was suspended for too long", 409);
    }
    if (!session.workspacePvc) {
      throw new LifecycleError("not_resumable", "session has no persistent workspace", 409);
    }
    if (!(await this.deps.provisioner.workspacePvcExists(session.workspacePvc).catch(() => false))) {
      this.deps.store.requestTermination(id, "failure:checkpoint_missing", {
        code: "checkpoint_missing",
        message: "the checkpoint workspace no longer exists",
      });
      throw new LifecycleError(
        "resume_unavailable",
        "the checkpoint workspace no longer exists; the session cannot be resumed",
        409,
      );
    }
    if (this.deps.cfg.pinCheckpointNode && session.nodeName) {
      const available = await this.deps.provisioner.nodeAvailable(session.nodeName).catch(() => false);
      if (!available) {
        throw new LifecycleError(
          "resume_unavailable",
          `the checkpoint's node ${session.nodeName} is unavailable; it cannot be resumed on another node`,
          409,
        );
      }
    }
    const relayAddr = await this.serviceAddress(this.deps.cfg.relayServiceName);
    const proxyAddr = await this.serviceAddress(this.deps.cfg.proxyServiceName);
    if (!relayAddr || !proxyAddr) {
      throw new LifecycleError("control_plane_unavailable", "relay or proxy unavailable", 503);
    }
    const { podName } = await this.createSandboxPod(session, relayAddr, proxyAddr, {
      workspacePvc: session.workspacePvc,
      resume: true,
      ...(this.deps.cfg.pinCheckpointNode && session.nodeName ? { nodeName: session.nodeName } : {}),
    });
    if (!this.deps.store.markResuming(id, podName)) {
      await this.deps.provisioner.deletePod(podName, 0).catch(() => undefined);
      await this.deps.relay.purge(id).catch(() => undefined);
      throw new LifecycleError("not_suspended", "session changed state while resuming", 409);
    }
    metrics.counter("sandbox_sessions_resumed_total", "Sessions resumed").inc();
    log.info("sandbox_resuming", { sessionId: id, podName, resumeCount: session.resumeCount + 1 });
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
    provisionBeginAt: number,
  ): Promise<boolean> {
    const cfg = this.deps.cfg;
    if (cfg.warmPoolSize === 0) return false;
    const poolLimits = this.warmPoolLimits();
    const poolBaseline = {
      cpuMillis: Math.max(50, Math.floor(poolLimits.cpuMillis / 4)),
      memoryMiB: Math.max(64, Math.floor(poolLimits.memoryMiB / 4)),
    };
    if (
      !this.warmLimitsFit(session.limits, poolLimits) ||
      (session.baselineCpuMillis ?? 0) > poolBaseline.cpuMillis ||
      (session.baselineMemoryMib ?? 0) > poolBaseline.memoryMiB
    ) {
      metrics.counter("sandbox_warm_pool_total", "Warm pool claim outcomes").inc({ result: "miss_limits" });
      return false;
    }

    const pickStarted = this.now();
    const warm = await this.pickWarmPod();
    const warmPickMs = this.now() - pickStarted;
    if (!warm) {
      metrics.counter("sandbox_warm_pool_total", "Warm pool claim outcomes").inc({ result: "miss_empty" });
      return false;
    }
    // Reserve it immediately so a second session in this tick cannot take it.
    this.warmClaimed.add(warm.warmId);

    const registerStarted = this.now();
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
    const warmRegisterMs = this.now() - registerStarted;

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

    const claimCallStarted = this.now();
    try {
      await this.deps.relay.claim(warm.poolId, claim);
    } catch (err) {
      log.warn("warm_claim_failed", { sessionId: session.id, warmId: warm.warmId, error: (err as Error).message });
      this.warmClaimed.delete(warm.warmId);
      await this.deps.provisioner.deletePod(warm.name, 0).catch(() => undefined);
      await this.deps.relay.purge(warm.poolId).catch(() => undefined);
      return false;
    }

    const warmClaimCallMs = this.now() - claimCallStarted;
    // The guest accepted the claim and is reconnecting as the real session.
    // Relabel before the next sweep so the pod is owned by that session.
    const relabelStarted = this.now();
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
      provisionBeginAt,
      warmPoolHit: 1,
      warmPickMs,
      warmRegisterMs,
      warmClaimCallMs,
      warmRelabelMs: this.now() - relabelStarted,
    });
    if (this.warmCache) {
      this.warmCache.pods = this.warmCache.pods.filter((p) => p.warmId !== warm.warmId);
    }
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
    const now = this.now();
    let pods: WarmPodInfo[];
    if (this.warmCache && now - this.warmCache.at < 2_000) {
      pods = this.warmCache.pods;
    } else {
      try {
        pods = await this.deps.provisioner.listWarmPods();
        this.warmCache = { pods, at: now };
      } catch (err) {
        log.warn("warm_pool_list_failed", { error: (err as Error).message });
        return null;
      }
    }
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
      if (pod?.nodeName && session.workspacePvc && !session.nodeName) {
        this.deps.store.setNodeName(session.id, pod.nodeName);
        session.nodeName = pod.nodeName;
      }
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
    if (session.workspacePvc) {
      await this.deps.provisioner.deleteWorkspacePvc(session.workspacePvc).catch((err) => {
        log.warn("workspace_pvc_delete_failed", {
          sessionId: session.id,
          pvc: session.workspacePvc,
          error: (err as Error).message,
        });
      });
      this.deps.store.clearWorkspacePvc(session.id);
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
