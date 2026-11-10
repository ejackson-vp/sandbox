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
import type { SessionRecord } from "./store/models.js";
import type { ReconcilerStore } from "./store/ports.js";
import { WarmPool } from "./warm-pool.js";
import { Provisioning } from "./provisioning.js";
import { Lifecycle } from "./lifecycle.js";
import { Termination } from "./termination.js";
import type { ReconcilerContext } from "./reconciler-context.js";
import { NoopSnapshotter, type Snapshotter } from "./snapshotter.js";
import { CapacityService } from "./capacity/service.js";
import { BackupService } from "./backup.js";
import { OperationFence } from "./operation-fence.js";
import { runBounded } from "./bounded-queue.js";
import { ServiceAddressResolver } from "./service-address.js";
import { cadenceFor } from "./reconcile-cadence.js";
import { log } from "@x402s/shared";

export { LifecycleError } from "./lifecycle.js";

export interface ReconcilerDeps {
  cfg: ControllerConfig;
  store: ReconcilerStore;
  provisioner: Provisioner;
  relay: RelayClient;
  now?: () => number;
  /** Override for tests or a future Firecracker/Kata checkpoint adapter. */
  snapshotter?: Snapshotter;
  /** Injectable for tests; defaults to the real capacity service. */
  capacity?: CapacityService;
  /** Override for tests: resolves service addresses without Kubernetes. */
  serviceAddress?: (
    name: string,
    shard?: number,
    podPrefix?: string,
  ) => Promise<{ host: string; port: number } | null>;
  /** Restart-recovery fence; defaults to one bound to the store and relay. */
  fence?: OperationFence;
}

export class Reconciler {
  private timer: NodeJS.Timeout | null = null;
  private housekeepingTimer: NodeJS.Timeout | null = null;
  private housekeepingRunning = false;
  private running = false;
  private wakeRequested = false;
  /**
   * Sessions a pass is currently reconciling. No later pass may run one of
   * these again: lease expiry and termination are stateful, so two concurrent
   * attempts on one id would race.
   */
  private readonly inFlight = new Set<string>();
  /** Last pod-health probe per session (guards K8s API traffic). */
  private readonly healthCheckedAt = new Map<string, number>();
  /** Consecutive *successful* probes reporting a missing/terminal pod. */
  private readonly healthStrikes = new Map<string, number>();
  /** Proxy addresses are stable; the relay endpoint is not (see serviceAddress). */
  private readonly serviceAddresses: ServiceAddressResolver;
  private readonly ctx: ReconcilerContext;
  private readonly warm: WarmPool;
  private readonly provisioning: Provisioning;
  private readonly lifecycle: Lifecycle;
  private readonly termination: Termination;
  private readonly backup: BackupService;
  private readonly fence: OperationFence;
  private readonly now: () => number;

  constructor(private readonly deps: ReconcilerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.serviceAddresses = new ServiceAddressResolver(() => this.now());
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
      serviceAddress: (name, shard) => this.serviceAddress(name, shard),
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
    this.fence = deps.fence ?? new OperationFence(deps.store, deps.relay);
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
   * cleanup do not pay a full poll interval. The pass is still due-time
   * bounded, so a nudge is immediate only for a row that is due: entitlement
   * creation inserts a NULL (due) schedule, and a destroy request arms
   * `next_due_ms = now`. Other transitions are picked up within their state's
   * cadence.
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
    const budget = this.deps.cfg.reconcileBudget;
    try {
      const now = this.now();
      // One bounded, index-ordered read replaces two full live-session sweeps
      // (readiness + gauges). `listDue` returns rows whose next pass is due,
      // earliest first, capped by the budget; a truncated remainder stays due
      // and is served by a later pass. Nothing here re-enters tick(), so a
      // backlog grows latency, never a busy loop.
      const due = this.deps.store.listDue(now, budget);
      const truncated = due.length >= budget;

      // Readiness first, terminal cleanup second: cleanup may delete a pod
      // that a terminating session is still shutting down gracefully, so the
      // two phases stay ordered even though each is internally concurrent.
      const dispatched = await this.reconcilePhase("readiness", due, async (session) => {
        try {
          await this.reconcileSession(session);
        } catch (err) {
          log.error("reconcile_session_failed", {
            sessionId: session.id,
            state: session.state,
            error: (err as Error).message,
          });
        } finally {
          this.rearm(session);
        }
      });

      const terminal = this.deps.store.listTerminalWithPod().filter((session) => session.podName);
      await this.reconcilePhase("cleanup", terminal, async (session) => {
        await this.deps.provisioner.deletePod(session.podName!, 0).catch(() => undefined);
        this.deps.store.clearPod(session.id);
      });

      // Same capacity numbers as the old full listing, from one grouped COUNT
      // instead of materialising every live row.
      const counts = this.deps.store.countLiveByState();
      metrics.gauge("sandbox_sessions_active", "Sessions in READY or ACTIVE").set(
        {},
        (counts.READY ?? 0) + (counts.ACTIVE ?? 0),
      );
      metrics.gauge("sandbox_provisioning_active", "Sessions in PROVISIONING or RESUMING").set(
        {},
        (counts.PROVISIONING ?? 0) + (counts.RESUMING ?? 0),
      );
      metrics.gauge("sandbox_provisioning_queued", "PAID sessions waiting for a provisioning slot").set(
        {},
        counts.PAID ?? 0,
      );

      // Sessions still due after the pass: the budget truncated the read, or
      // a due row was skipped because it is already in flight. When the pass
      // exhausted the due set there is nothing to count.
      const backlog =
        truncated || due.length > dispatched ? this.deps.store.countDue(now) : 0;
      metrics
        .gauge("sandbox_reconcile_due_backlog", "Sessions due but not dispatched this pass")
        .set({}, backlog);
    } catch (err) {
      log.error("reconcile_pass_failed", { error: (err as Error).message });
    } finally {
      const durationMs = Date.now() - started;
      metrics
        .histogram("sandbox_reconcile_duration_seconds", "Reconcile pass duration", LATENCY_BUCKETS)
        .observe(durationMs / 1000);
      // 1 means the pass did not fit in the timer interval. The timer keeps its
      // own cadence and tick() is guarded by `running`, so this is a signal to
      // raise capacity or lower the budget, not a trigger for another pass.
      metrics
        .gauge("sandbox_reconcile_saturated", "1 when a reconcile pass overran RECONCILE_INTERVAL_MS")
        .set({}, durationMs >= this.deps.cfg.reconcileIntervalMs ? 1 : 0);
      this.running = false;
      if (this.wakeRequested) {
        this.wakeRequested = false;
        void this.tick();
      }
    }
  }

  /**
   * Move a processed session past this pass.
   *
   * `listDue` selects `next_due_ms <= now`, so a row left untouched is
   * selected again on the very next pass: the scheduler would spin at the tick
   * rate no matter what cadence the policy asks for. An unchanged session is
   * therefore re-armed to `now + cadenceFor(state)`. A session whose state
   * changed already had its due time armed by the state-changing statement with
   * the cadence of the state it entered, so re-writing it would be a pointless
   * second write and could shorten a longer cadence. `rearmDue` additionally
   * only applies while the row is still due, so a concurrent transition that
   * armed a future deadline always wins.
   */
  private rearm(processed: SessionRecord): void {
    try {
      const current = this.deps.store.getSession(processed.id);
      if (!current || current.state !== processed.state) return;
      const now = this.now();
      this.deps.store.rearmDue(current.id, now + cadenceFor(current.state), now);
    } catch (err) {
      log.warn("reconcile_rearm_failed", {
        sessionId: processed.id,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Run one reconcile phase with bounded concurrency.
   *
   * Sessions already in flight are skipped (they are picked up by the next
   * pass), which is the per-session serialization guarantee. Queue depth and
   * queue wait are exported with a bounded `phase` label so a burst shows up
   * before it becomes tail latency; session ids never enter metrics.
   */
  private async reconcilePhase(
    phase: "readiness" | "cleanup",
    sessions: readonly SessionRecord[],
    run: (session: SessionRecord) => Promise<void>,
  ): Promise<number> {
    const labels = { phase };
    const depth = metrics.gauge(
      "sandbox_reconcile_queue_depth",
      "Sessions waiting for a reconcile worker, by phase",
    );
    const wait = metrics.histogram(
      "sandbox_reconcile_queue_wait_seconds",
      "Time a session waited for a reconcile worker, by phase",
      LATENCY_BUCKETS,
    );
    const active = metrics.gauge(
      "sandbox_reconcile_in_flight",
      "Sessions currently being reconciled, by phase",
    );
    const eligible = sessions.filter((session) => !this.inFlight.has(session.id));
    depth.set(labels, eligible.length);
    let dispatched = 0;
    try {
      await runBounded(
        eligible,
        async (session) => {
          if (this.inFlight.has(session.id)) return;
          this.inFlight.add(session.id);
          dispatched += 1;
          active.inc(labels);
          try {
            await run(session);
          } finally {
            this.inFlight.delete(session.id);
            active.dec(labels);
          }
        },
        {
          concurrency: this.deps.cfg.reconcileConcurrency,
          now: () => this.now(),
          onStart: (waitMs, remaining) => {
            wait.observe(waitMs / 1000, labels);
            depth.set(labels, remaining);
          },
        },
      );
    } finally {
      depth.set(labels, 0);
    }
    return dispatched;
  }

  /** Slow path: pool replenishment and orphan reaping, off the readiness tick. */
  private async housekeeping(): Promise<void> {
    if (this.housekeepingRunning) return;
    this.housekeepingRunning = true;
    try {
      await this.termination.sweep();
      await this.fence.reconcile();
      await this.warm.reconcile();
      await this.lifecycle.enforce();
      await this.lifecycle.cleanup();
      await this.termination.sweepPvcs();
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
        await this.lifecycle.reconcileSuspend(session);
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

  private async serviceAddress(
    name: string,
    shard?: number,
    podPrefix?: string,
  ): Promise<{ host: string; port: number } | null> {
    // The relay resolves to a ready endpoint Pod IP. A replacement relay gets a
    // new IP, so caching it would boot new guests against the old process.
    // Resolve it on every use; only the stable proxy address is cached. The key
    // carries the shard: two proxy replicas have different endpoints and must
    // not share a cache entry.
    return this.serviceAddresses.resolve(
      shard === undefined ? name : `${name}#${shard}#${podPrefix ?? name}`,
      () => this.deps.serviceAddress
        ? this.deps.serviceAddress(name, shard, podPrefix)
        : this.deps.provisioner.getServiceAddress(name, shard, podPrefix),
      { cache: name !== this.deps.cfg.relayServiceName },
    );
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
