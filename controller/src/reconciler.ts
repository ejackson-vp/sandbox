/**
 * Reconciliation loop: the only component that mutates session state.
 *
 *  PAID          -> register relay session + create pod
 *  PROVISIONING  -> READY when the guest hello (with evidence) arrives; the
 *                   immutable lease deadline is set here (ready + duration)
 *  READY/ACTIVE  -> SUSPENDING on idle/suspend; TERMINATING on expiry/destroy
 *  SUSPENDING    -> finish checkpointing, then SUSPENDED
 *  SUSPENDED     -> RESUMING on resume; TERMINATING on expiry/destroy
 *  RESUMING      -> READY when the restored guest hello arrives
 *  TERMINATING   -> ask the guest to stop, delete the pod, purge relay state,
 *                   then finalise as EXPIRED / DESTROYED / FAILED
 *
 * Deadline enforcement never depends on the untrusted guest cooperating: the
 * controller's clock decides, and pod deletion is the backstop.
 */
import { LATENCY_BUCKETS, metrics, type RelaySessionState } from "@x402s/shared";
import type { ControllerConfig } from "./config.js";
import type { Provisioner } from "./k8s.js";
import type { RelayClient } from "./relay-client.js";
import type { SessionRecord, Store } from "./store.js";
import { WarmPool } from "./warm-pool.js";
import { Provisioning } from "./provisioning.js";
import { Lifecycle } from "./lifecycle.js";
import { Termination } from "./termination.js";
import type { ReconcilerContext } from "./reconciler-context.js";
import { NoopSnapshotter, type Snapshotter } from "./snapshotter.js";
import { CapacityService } from "./capacity/service.js";
import { BackupService } from "./backup.js";
import { log } from "@x402s/shared";

export { LifecycleError } from "./lifecycle.js";

export interface ReconcilerDeps {
  cfg: ControllerConfig;
  store: Store;
  provisioner: Provisioner;
  relay: RelayClient;
  now?: () => number;
  /** Override for tests or a future Firecracker/Kata checkpoint adapter. */
  snapshotter?: Snapshotter;
  /** Injectable for tests; defaults to the real capacity service. */
  capacity?: CapacityService;
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
  private readonly ctx: ReconcilerContext;
  private readonly warm: WarmPool;
  private readonly provisioning: Provisioning;
  private readonly lifecycle: Lifecycle;
  private readonly termination: Termination;
  private readonly backup: BackupService;
  private readonly now: () => number;

  constructor(private readonly deps: ReconcilerDeps) {
    this.now = deps.now ?? (() => Date.now());
    const capacity = deps.capacity ?? new CapacityService({
      cfg: deps.cfg,
      store: deps.store,
      provisioner: deps.provisioner,
    });
    this.ctx = {
      cfg: deps.cfg,
      store: deps.store,
      provisioner: deps.provisioner,
      relay: deps.relay,
      capacity,
      snapshotter: deps.snapshotter ?? new NoopSnapshotter(),
      now: () => this.now(),
      serviceAddress: (name) => this.serviceAddress(name),
    };
    this.warm = new WarmPool(this.ctx);
    this.provisioning = new Provisioning(this.ctx, this.warm);
    this.lifecycle = new Lifecycle(this.ctx, this.provisioning);
    this.termination = new Termination(this.ctx);
    this.backup = new BackupService({
      store: deps.store,
      dir: deps.cfg.backupDir,
      key: deps.cfg.backupKey,
      intervalMs: deps.cfg.backupIntervalMs,
      retention: deps.cfg.backupRetention,
      now: () => this.now(),
    });
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
      const provisioning = nonTerminal.filter(
        (s) => s.state === "PROVISIONING" || s.state === "RESUMING",
      ).length;
      const queued = nonTerminal.filter((s) => s.state === "PAID").length;
      metrics.gauge("sandbox_sessions_active", "Sessions in READY or ACTIVE").set({}, active);
      metrics.gauge("sandbox_provisioning_active", "Sessions in PROVISIONING or RESUMING").set({}, provisioning);
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
      await this.termination.sweep();
      await this.warm.reconcile();
      await this.lifecycle.enforce();
      await this.lifecycle.cleanup();
      this.termination.reconcileRefunds();
      await this.ctx.capacity.reap();
      await this.backup.maybeRun();
    } catch (err) {
      log.warn("housekeeping_failed", { error: (err as Error).message });
    } finally {
      this.housekeepingRunning = false;
    }
  }

  /** Idle suspension, suspended expiry, and the wall-clock lifetime cap. */
  private async reconcileSession(session: SessionRecord): Promise<void> {
    // A client destroy must win from every non-terminal state, otherwise a
    // session destroyed while SUSPENDED is left with its workspace.
    if (session.destroyRequested && session.state !== "TERMINATING") {
      if (this.ctx.store.requestTermination(session.id, "client_destroy")) {
        const updated = this.ctx.store.getSession(session.id);
        if (updated) {
          await this.terminate(updated);
          return;
        }
      }
    }
    switch (session.state) {
      case "PAID":
        await this.provisioning.provision(session);
        break;
      case "PROVISIONING":
      case "RESUMING":
        await this.provisioning.awaitReady(session);
        break;
      case "READY":
      case "ACTIVE":
        await this.enforceLease(session);
        break;
      case "SUSPENDING":
        await this.lifecycle.finishSuspend(session);
        break;
      case "TERMINATING":
        await this.terminate(session);
        break;
      default:
        break;
    }
  }

  private async terminate(session: SessionRecord): Promise<void> {
    await this.termination.terminate(session);
    this.healthCheckedAt.delete(session.id);
    this.healthStrikes.delete(session.id);
  }

  /** Lifecycle actions are exposed for the internal control API. */
  suspendSession(id: string): Promise<void> {
    return this.lifecycle.suspend(id);
  }

  resumeSession(id: string): Promise<void> {
    return this.lifecycle.resume(id);
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

  private async enforceLease(session: SessionRecord): Promise<void> {
    // Detect a dead guest/pod between operations (crash, OOM, relay loss).
    // Probed at most every 2s per session to bound Kubernetes API traffic.
    //
    // Safety: a failed probe (timeout, 429, connection reset) must never
    // terminate a paid session. Only a successful read that reports the pod
    // missing or terminal counts, and it must happen twice in a row.
    const readyAt = session.readyAt ?? 0;
    if (session.podName && this.ctx.now() - readyAt > 2000 && this.ctx.now() - (this.healthCheckedAt.get(session.id) ?? 0) > 2000) {
      this.healthCheckedAt.set(session.id, this.ctx.now());
      try {
        const pod = await this.ctx.provisioner.getPod(session.podName);
        if (!pod || pod.phase === "Failed" || pod.phase === "Succeeded") {
          const strikes = (this.healthStrikes.get(session.id) ?? 0) + 1;
          this.healthStrikes.set(session.id, strikes);
          if (strikes >= 2) {
            this.ctx.store.requestTermination(session.id, "failure:guest_exited", {
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
    const now = this.ctx.now();
    if (now > deadline + this.ctx.cfg.leaseGraceMs) {
      this.ctx.store.requestTermination(session.id, "lease_expired");
      log.warn("sandbox_lease_expired", { sessionId: session.id, state: session.state, overrunMs: now - deadline });
    }
  }


}

export type { RelaySessionState };
