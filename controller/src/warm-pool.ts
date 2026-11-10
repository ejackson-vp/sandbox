/**
 * Warm pool: pre-booted, unleased pods. Policy and lifecycle live here; the
 * reconciler only schedules the calls.
 */
import { randomBytes } from "node:crypto";
import { metrics, type SessionLimits, type WarmClaim } from "@x402s/shared";
import { GUEST_TOOLS, type WarmPodInfo } from "./k8s.js";
import { proxyTokenFor } from "./config.js";
import { warmPoolIdentity } from "./warm-pool-identity.js";
import { newOpaqueToken, sha256Hex, guestTokenFor } from "./tokens.js";
import { pinnedShard, shardClaim } from "./data-plane-shard.js";
import { log } from "@x402s/shared";
import type { ReconcilerContext } from "./reconciler-context.js";
import type { WarmPoolStore } from "./store/ports.js";

type WarmPoolContext = Omit<ReconcilerContext, "store"> & { store: WarmPoolStore };
import type { SessionRecord } from "./store/models.js";

export class WarmPool {
  private readonly claimed = new Set<string>();
  /** Serializes pick+reserve; two concurrent provisions must not take one pod. */
  private claimTail: Promise<void> = Promise.resolve();
  private cache: { pods: WarmPodInfo[]; at: number } | null = null;

  constructor(private readonly ctx: WarmPoolContext) {}

  limits(): SessionLimits {
    const def = this.ctx.cfg.tiers[this.ctx.cfg.warmPoolTier];
    const platform = this.ctx.cfg.platformLimits;
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

  /** The identity a warm pod must carry to be claimable right now. */
  private identity(): string {
    const cfg = this.ctx.cfg;
    return warmPoolIdentity({
      imageDigest: cfg.guestImageDigest,
      runtimeClass: cfg.runtimeClass,
      executionMode: cfg.executionMode,
      workspaceDir: cfg.workspaceDir,
      limits: this.limits(),
    });
  }

  /**
   * A warm pod is sized by its cgroup and emptyDir limits. Everything else
   * (output, file size, process count, command timeout) is re-sent in the
   * claim and enforced by the guest, so only the pod-shaped limits must fit.
   */
  private fits(need: SessionLimits, have: SessionLimits): boolean {
    return (
      need.cpuMillis <= have.cpuMillis &&
      need.memoryMiB <= have.memoryMiB &&
      need.diskMiB <= have.diskMiB
    );
  }

  async tryClaim(
    session: SessionRecord,
    relayAddr: { host: string; port: number },
    proxyAddr: { host: string; port: number },
    provisionBeginAt: number,
  ): Promise<boolean> {
    const cfg = this.ctx.cfg;
    if (cfg.warmPoolSize === 0) return false;
    const poolLimits = this.limits();
    const poolBaseline = {
      cpuMillis: Math.max(50, Math.floor(poolLimits.cpuMillis / 4)),
      memoryMiB: Math.max(64, Math.floor(poolLimits.memoryMiB / 4)),
    };
    if (
      !this.fits(session.limits, poolLimits) ||
      (session.baselineCpuMillis ?? 0) > poolBaseline.cpuMillis ||
      (session.baselineMemoryMib ?? 0) > poolBaseline.memoryMiB
    ) {
      metrics.counter("sandbox_warm_pool_total", "Warm pool claim outcomes").inc({ result: "miss_limits" });
      return false;
    }

    const pickStarted = this.ctx.now();
    // `pick` awaits Kubernetes and relay reads, so the reserve has to be
    // atomic with the pick: two sessions in the same bounded reconcile pass
    // would otherwise both observe the same free pod.
    const warm = await this.claimLocked(async () => {
      const candidate = await this.pick();
      if (candidate) this.claimed.add(candidate.warmId);
      return candidate;
    });
    const warmPickMs = this.ctx.now() - pickStarted;
    if (!warm) {
      metrics.counter("sandbox_warm_pool_total", "Warm pool claim outcomes").inc({ result: "miss_empty" });
      return false;
    }

    const registerStarted = this.ctx.now();
    const guestToken = guestTokenFor(newOpaqueToken(32), shardClaim(cfg, "relay", session.id));
    const tokenHash = sha256Hex(guestToken);
    const ttlMs = cfg.provisioningTimeoutMs + session.durationSeconds * 1000 + 5 * 60_000;
    try {
      // A warm claim is a create too: register against the current relay
      // generation so a restart between the readiness gate and here cannot
      // leave the claim pointing at a registry that is already gone.
      await this.ctx.relay.registerCurrent(session.id, tokenHash, ttlMs, {
        deadlineMs: Math.min(cfg.relayRegistrationTimeoutMs, 2_000),
        replaceConnected: true,
      });
    } catch (err) {
      log.warn("warm_relay_register_failed", { sessionId: session.id, error: (err as Error).message });
      this.claimed.delete(warm.warmId);
      return false;
    }
    this.ctx.store.setRelayToken(session.id, tokenHash);
    const warmRegisterMs = this.ctx.now() - registerStarted;

    // As in the cold path, registration may have waited through a relay
    // replacement. The claim must point at the endpoint that accepted it;
    // above one replica that is the session's shard, recomputed from the
    // session id rather than inherited from the warm pod's own shard. It has to
    // be the shard's ready pod IP: the claimed guest still has no DNS. The
    // caller's addresses are this session's shard already, so they are the
    // fallback when a re-read races a pod restart.
    const relayShard = pinnedShard(cfg, "relay", session.id);
    const proxyShard = pinnedShard(cfg, "proxy", session.id);
    const relay = relayShard === null
      ? (await this.ctx.serviceAddress(cfg.relayServiceName)) ?? relayAddr
      : (await this.ctx.serviceAddress(cfg.relayHeadlessService, relayShard, cfg.relayServiceName)) ?? relayAddr;
    const proxy = proxyShard === null
      ? proxyAddr
      : (await this.ctx.serviceAddress(cfg.proxyHeadlessService, proxyShard, cfg.proxyServiceName)) ?? proxyAddr;
    const claim: WarmClaim = {
      sessionId: session.id,
      relayUrl: `ws://${relay.host}:${relay.port}/guest?session=${encodeURIComponent(session.id)}`,
      guestToken,
      clientPublicKey: session.clientPublicKey,
      clientNonce: session.clientNonce,
      leaseSeconds: session.durationSeconds,
      executionMode: cfg.executionMode,
      runtimeClass: cfg.runtimeClass,
      imageDigest: cfg.guestImageDigest,
      proxyUrl: `http://${proxy.host}:${proxy.port}`,
      proxyToken: proxyTokenFor(cfg, session.id),
      maxOutputBytes: session.limits.maxOutputBytes,
      maxFileBytes: session.limits.maxFileBytes,
      maxDiskMiB: session.limits.diskMiB,
      maxCommandSeconds: session.limits.maxCommandSeconds,
      maxProcesses: session.limits.maxProcesses,
      tools: GUEST_TOOLS.join(","),
    };

    const claimCallStarted = this.ctx.now();
    try {
      await this.ctx.relay.claim(warm.poolId, claim);
    } catch (err) {
      log.warn("warm_claim_failed", { sessionId: session.id, warmId: warm.warmId, error: (err as Error).message });
      this.claimed.delete(warm.warmId);
      await this.ctx.provisioner.deletePod(warm.name, 0).catch(() => undefined);
      await this.ctx.relay.purge(warm.poolId).catch(() => undefined);
      return false;
    }

    const warmClaimCallMs = this.ctx.now() - claimCallStarted;
    // The guest accepted the claim and is reconnecting as the real session.
    // Relabel before the next sweep so the pod is owned by that session.
    const relabelStarted = this.ctx.now();
    try {
      await this.ctx.provisioner.patchPodLabels(warm.name, {
        "x402.io/pool": "sandbox",
        "x402.io/session": session.id,
        "x402.io/warm-claimed": "true",
      });
    } catch (err) {
      log.warn("warm_relabel_failed", { sessionId: session.id, warmId: warm.warmId, error: (err as Error).message });
      this.claimed.delete(warm.warmId);
      await this.ctx.provisioner.deletePod(warm.name, 0).catch(() => undefined);
      await this.ctx.relay.purge(session.id).catch(() => undefined);
      return false;
    }

    if (!this.ctx.store.setProvisioning(session.id, warm.name)) {
      // The session moved on (destroyed, reaped) between selection and here.
      this.claimed.delete(warm.warmId);
      await this.ctx.provisioner.deletePod(warm.name, 0).catch(() => undefined);
      await this.ctx.relay.purge(session.id).catch(() => undefined);
      return false;
    }

    if (warm.nodeName) {
      this.ctx.capacity.pinSessionNode(session.id, warm.nodeName);
    }
    const claimedAt = this.ctx.now();
    this.ctx.store.mergeTimings(session.id, {
      provisionStartAt: claimedAt,
      podRequestedAt: claimedAt,
      warmClaimAt: claimedAt,
      provisionBeginAt,
      warmPoolHit: 1,
      warmPickMs,
      warmRegisterMs,
      warmClaimCallMs,
      warmRelabelMs: this.ctx.now() - relabelStarted,
    });
    if (this.cache) {
      this.cache.pods = this.cache.pods.filter((p) => p.warmId !== warm.warmId);
    }
    this.claimed.delete(warm.warmId);
    // The pooled identity is dead the moment the guest reconnects.
    await this.ctx.relay.purge(warm.poolId).catch(() => undefined);
    metrics.counter("sandbox_warm_pool_total", "Warm pool claim outcomes").inc({ result: "hit" });
    log.info("sandbox_warm_claimed", {
      sessionId: session.id,
      warmId: warm.warmId,
      podName: warm.name,
    });
    return true;
  }

  /** Run one pick+reserve at a time; claims are short and in-process only. */
  private async claimLocked<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.claimTail;
    let release!: () => void;
    this.claimTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async pick(): Promise<WarmPodInfo | null> {
    const now = this.ctx.now();
    const identity = this.identity();
    let pods: WarmPodInfo[];
    if (this.cache && now - this.cache.at < 2_000) {
      pods = this.cache.pods;
    } else {
      try {
        pods = await this.ctx.provisioner.listWarmPods();
        this.cache = { pods, at: now };
      } catch (err) {
        log.warn("warm_pool_list_failed", { error: (err as Error).message });
        return null;
      }
    }
    for (const pod of pods) {
      if (!pod.warmId || this.claimed.has(pod.warmId)) continue;
      if (pod.phase !== "Running" && pod.phase !== "Pending") continue;
      if (pod.createdAt > 0 && now - pod.createdAt > this.ctx.cfg.warmPoolTtlMs) continue;
      // A pod from an older image/config must never be claimed: the guest would
      // run stale code and could attest the claim's digest instead of its own.
      if (pod.identity !== identity || pod.imageDigest !== this.ctx.cfg.guestImageDigest) continue;
      try {
        const state = await this.ctx.relay.state(pod.poolId);
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
  async reconcile(): Promise<void> {
    const cfg = this.ctx.cfg;
    let pods: WarmPodInfo[];
    try {
      pods = await this.ctx.provisioner.listWarmPods();
    } catch {
      return;
    }
    if (pods.length === 0 && cfg.warmPoolSize === 0) return;

    const now = this.ctx.now();
    const identity = this.identity();
    let live = 0;
    for (const pod of pods) {
      if (!pod.warmId) continue;
      if (this.claimed.has(pod.warmId)) {
        live++;
        continue;
      }
      const staleIdentity =
        pod.identity !== identity || pod.imageDigest !== cfg.guestImageDigest;
      const dead = pod.phase === "Failed" || pod.phase === "Succeeded";
      const tooOld = pod.createdAt > 0 && now - pod.createdAt > cfg.warmPoolTtlMs;
      const scaleDown = cfg.warmPoolSize === 0;
      if (staleIdentity || dead || tooOld || scaleDown) {
        await this.ctx.provisioner.deletePod(pod.name, 0).catch(() => undefined);
        await this.ctx.relay.purge(pod.poolId).catch(() => undefined);
        log.info("warm_pod_recycled", {
          podName: pod.name,
          reason: staleIdentity ? "identity" : scaleDown ? "scale_down" : dead ? "dead" : "ttl",
        });
        continue;
      }
      // A pool pod created before a controller/relay restart has no known
      // token hash; it can never authenticate again, so recycle it.
      const state = await this.ctx.relay.state(pod.poolId).catch(() => null);
      if (state && !state.registered && pod.createdAt > 0 && now - pod.createdAt > 30_000) {
        await this.ctx.provisioner.deletePod(pod.name, 0).catch(() => undefined);
        log.info("warm_pod_recycled", { podName: pod.name, reason: "unregistered" });
        continue;
      }
      live++;
    }

    metrics.gauge("sandbox_warm_pool_pods", "Warm pool pods (live)").set({}, live);
    if (cfg.warmPoolSize === 0) return;

    const missing = Math.max(0, cfg.warmPoolSize - live);
    if (missing === 0) return;

    const relayAddr = await this.ctx.serviceAddress(cfg.relayServiceName);
    const proxyAddr = await this.ctx.serviceAddress(cfg.proxyServiceName);
    if (!relayAddr || !proxyAddr) return;
    // Bounded per pass so a large pool does not burst the kubelet. Capacity is
    // checked against actual warm pods; replenishment is intentionally slow so
    // the next housekeeping pass observes the pod we just created.
    for (let i = 0; i < Math.min(missing, 2); i++) {
      const decision = await this.ctx.capacity.preflight({ limits: this.limits() });
      if (!decision.admitted) {
        log.info("warm_pool_capacity_rejected", { reason: decision.reason });
        break;
      }
      await this.create(relayAddr, proxyAddr);
    }
  }

  private async create(
    relayAddr: { host: string; port: number },
    proxyAddr: { host: string; port: number },
  ): Promise<void> {
    const cfg = this.ctx.cfg;
    const warmId = randomBytes(6).toString("hex");
    const poolId = `warm_${warmId}`;
    const guestToken = guestTokenFor(newOpaqueToken(32), shardClaim(cfg, "relay", poolId));
    const tokenHash = sha256Hex(guestToken);
    const ttlMs = cfg.warmPoolTtlMs + 120_000;
    // The pooled id owns its own shard, independent of whichever session later
    // claims this pod. The claim message rewrites both endpoints for the real
    // session, so the guest follows the session's shard when it reconnects.
    // Above one replica the pooled guest needs its shard's ready pod IP: it
    // runs with no DNS and cannot resolve the headless Service name. A shard
    // with no ready endpoint leaves the slot for the next pass rather than
    // booting a guest that dials another shard's pod.
    const relayShard = pinnedShard(cfg, "relay", poolId);
    const proxyShard = pinnedShard(cfg, "proxy", poolId);
    const relay = relayShard === null
      ? relayAddr
      : await this.ctx.serviceAddress(cfg.relayHeadlessService, relayShard, cfg.relayServiceName);
    const proxy = proxyShard === null
      ? proxyAddr
      : await this.ctx.serviceAddress(cfg.proxyHeadlessService, proxyShard, cfg.proxyServiceName);
    if (!relay || !proxy) {
      log.warn("warm_pool_endpoint_unavailable", { poolId });
      return;
    }
    try {
      // One bounded attempt per housekeeping pass. If the relay is mid-restart
      // the next pass creates the pod against the replacement instead of
      // booting a guest whose pooled registration was already lost.
      await this.ctx.relay.registerCurrent(poolId, tokenHash, ttlMs, { deadlineMs: 1_000 });
    } catch (err) {
      log.warn("warm_relay_register_failed", { poolId, error: (err as Error).message });
      return;
    }
    try {
      await this.ctx.provisioner.createWarmPod({
        warmId,
        poolId,
        ttlMs,
        limits: this.limits(),
        guestToken,
        relayUrl: `ws://${relay.host}:${relay.port}/guest?session=${encodeURIComponent(poolId)}`,
        proxyUrl: `http://${proxy.host}:${proxy.port}`,
        proxyToken: proxyTokenFor(cfg, poolId),
        image: cfg.guestImageRef,
        imageDigest: cfg.guestImageDigest,
        identity: this.identity(),
        runtimeClass: cfg.runtimeClass,
        executionMode: cfg.executionMode,
        workspaceDir: cfg.workspaceDir,
        tools: GUEST_TOOLS.join(","),
      });
      metrics.counter("sandbox_warm_pool_created_total", "Warm pods created").inc();
    } catch (err) {
      await this.ctx.relay.purge(poolId).catch(() => undefined);
      log.warn("warm_pod_create_failed", { warmId, error: (err as Error).message });
    }
  }
}
