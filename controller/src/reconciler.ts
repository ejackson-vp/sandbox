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
import { HttpSettlementLookup, LATENCY_BUCKETS, log, metrics } from "@x402s/shared/runtime";
import type { ControllerConfig } from "./config.js";
import type { Provisioner } from "./k8s.js";
import type { RelayClient } from "./relay-client.js";
import type { SessionRecord } from "./store/models.js";
import type { ReconcilerStore } from "./store/ports.js";
import { WarmPoolManager } from "./warm-pool-manager.js";
import { Provisioning } from "./provisioning.js";
import { Lifecycle } from "./lifecycle.js";
import { Termination } from "./termination.js";
import type { ReconcilerContext } from "./reconciler-context.js";
import { NoopSnapshotter, type Snapshotter } from "./snapshotter.js";
import { CapacityService } from "./capacity/service.js";
import { RefundService } from "./refunds.js";
import { HttpRefundExecutor, RefundWorker } from "./refund-worker.js";
import { SettlementRecovery } from "./settlement-recovery.js";
import { OperationFence } from "./operation-fence.js";
import { RelayRecovery } from "./relay-recovery.js";
import { runBounded } from "./bounded-queue.js";
import { ServiceAddressResolver } from "./service-address.js";
import { cadenceFor } from "./reconcile-cadence.js";
import { ClockGuard, type ClockJump } from "./clock-guard.js";

export { LifecycleError } from "./lifecycle.js";

interface ReconcilerDeps {
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
  /** Injection point for tests; defaults to one bound to the fence and relay. */
  relayRecovery?: RelayRecovery;
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
  private readonly warm: WarmPoolManager;
  private readonly provisioning: Provisioning;
  private readonly lifecycle: Lifecycle;
  private readonly termination: Termination;
  private readonly fence: OperationFence;
  private readonly relayRecovery: RelayRecovery;
  private readonly clock: ClockGuard;
  private readonly refundWorker: RefundWorker;
  private readonly settlementRecovery: SettlementRecovery;
  private readonly now: () => number;

  constructor(private readonly deps: ReconcilerDeps) {
    // Every deadline decision in this class goes through one guarded clock, so
    // a wall-clock step (NTP, operator, VM resume) is logged once with the old
    // and new readings instead of silently shortening or extending leases.
    this.clock = new ClockGuard({
      now: deps.now ?? (() => Date.now()),
      // Reporting reads the store, so it cannot finish inside the clock read
      // that noticed the jump. It is fire-and-forget by construction: its own
      // body catches, and a report must never be the reason a pass fails.
      onJump: (jump) => {
        void this.reportClockJump(jump);
      },
    });
    this.now = () => this.clock.now();
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
      // Bound, not wrapped: a wrapper with a shorter parameter list silently
      // drops arguments, which is how the shard pod prefix was lost.
      serviceAddress: this.serviceAddress.bind(this),
    };
    this.warm = new WarmPoolManager(this.ctx);
    this.provisioning = new Provisioning(this.ctx, this.warm);
    this.lifecycle = new Lifecycle(this.ctx, this.provisioning);
    this.termination = new Termination(this.ctx);
    this.fence = deps.fence ?? new OperationFence(deps.store, deps.relay);
    this.relayRecovery =
      deps.relayRecovery ??
      new RelayRecovery(deps.cfg, deps.store, deps.relay, this.fence, () => this.now());
    // Both are inert unless configured: recovery needs a facilitator that
    // exposes a settlement lookup, and the worker needs an operator-owned
    // refund endpoint. With neither, real-mode refunds stay REFUND_PENDING.
    this.refundWorker = new RefundWorker(
      deps.store,
      deps.cfg.refundWebhookUrl
        ? new HttpRefundExecutor(deps.cfg.refundWebhookUrl, deps.cfg.refundWebhookToken)
        : null,
      {
        maxAttempts: deps.cfg.refundMaxAttempts,
        retryBaseMs: deps.cfg.refundRetryBaseMs,
        limit: 50,
        now: () => this.now(),
      },
    );
    this.settlementRecovery = new SettlementRecovery(
      deps.store,
      new RefundService(deps.store),
      deps.cfg.settlementRecoveryEnabled && deps.cfg.facilitatorUrl
        ? new HttpSettlementLookup(deps.cfg.facilitatorUrl)
        : null,
      {
        graceMs: deps.cfg.settlementRecoveryGraceMs,
        limit: 25,
        mode: deps.cfg.paymentMode,
        now: () => this.now(),
      },
    );
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
    // Monotonic: a wall-clock step during a pass must not be reported as a pass
    // that overran its budget.
    const started = this.clock.monotonic();
    const budget = this.deps.cfg.reconcileBudget;
    try {
      const now = this.now();
      // One bounded, index-ordered read replaces two full live-session sweeps
      // (readiness + gauges). `listDue` returns rows whose next pass is due,
      // earliest first, capped by the budget; a truncated remainder stays due
      // and is served by a later pass. Nothing here re-enters tick(), so a
      // backlog grows latency, never a busy loop.
      const due = await this.deps.store.listDue(now, budget);
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
          await this.rearm(session);
        }
      });

      const terminal = (await this.deps.store.listTerminalWithPod()).filter(
        (session) => session.podName,
      );
      await this.reconcilePhase("cleanup", terminal, async (session) => {
        await this.deps.provisioner.deletePod(session.podName!, 0).catch(() => undefined);
        await this.deps.store.clearPod(session.id);
      });

      // Same capacity numbers as the old full listing, from one grouped COUNT
      // instead of materialising every live row.
      const counts = await this.deps.store.countLiveByState();
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
      const backlog = truncated || due.length > dispatched ? await this.deps.store.countDue(now) : 0;
      metrics
        .gauge("sandbox_reconcile_due_backlog", "Sessions due but not dispatched this pass")
        .set({}, backlog);
    } catch (err) {
      log.error("reconcile_pass_failed", { error: (err as Error).message });
    } finally {
      const durationMs = this.clock.monotonic() - started;
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
  private async rearm(processed: SessionRecord): Promise<void> {
    try {
      const current = await this.deps.store.getSession(processed.id);
      if (!current || current.state !== processed.state) return;
      const now = this.now();
      await this.deps.store.rearmDue(current.id, now + cadenceFor(current.state), now);
    } catch (err) {
      log.warn("reconcile_rearm_failed", {
        sessionId: processed.id,
        error: (err as Error).message,
      });
    }
  }

  /**
   * A wall-clock step. The guard has already decided it is a step, not drift;
   * this reports the readings and the sessions the step moved, because "the
   * clock jumped" alone does not tell an operator whether anything was
   * affected. A session whose immutable deadline falls inside the jumped window
   * is the one that ends early (forward) or late (backward).
   */
  private async reportClockJump(jump: ClockJump): Promise<void> {
    const low = Math.min(jump.from, jump.to);
    const high = Math.max(jump.from, jump.to);
    let affected: string[] = [];
    try {
      affected = (await this.deps.store.listNonTerminal())
        .filter(
          (session) =>
            session.leaseExpiresAt !== null &&
            session.leaseExpiresAt >= low &&
            session.leaseExpiresAt <= high,
        )
        .map((session) => session.id);
    } catch {
      // Reporting must never be the reason a reconcile pass fails.
    }
    log.warn("clock_skew_detected", {
      from: new Date(jump.from).toISOString(),
      to: new Date(jump.to).toISOString(),
      deltaMs: jump.deltaMs,
      direction: jump.direction,
      affectedSessions: affected.length,
      affectedSessionIds: affected.slice(0, 20),
      jumps: this.clock.jumpCount,
    });
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
      // Relay generation recovery first: it fences the operation a lost link was
      // carrying before the fence below may decide anything about that gate.
      await this.relayRecovery.reconcile();
      await this.termination.sweep();
      await this.fence.reconcile();
      await this.warm.reconcile();
      await this.lifecycle.enforce();
      await this.lifecycle.cleanup();
      await this.termination.sweepPvcs();
      await this.termination.reconcileRefunds();
      // Settled-but-unentitled payments first, then the refund worker in the same
      // pass so a recovery that needs a real transfer is attempted immediately.
      await this.settlementRecovery.run();
      await this.refundWorker.run();
      // Expired challenge nonces are dead weight; the TTL check on burn is what
      // enforces the bound, this just keeps the table small.
      await this.deps.store.pruneChallengeNonces();
      await this.ctx.capacity.reap();
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
      if (await this.ctx.store.requestTermination(session.id, "client_destroy")) {
        const updated = await this.ctx.store.getSession(session.id);
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
            await this.ctx.store.requestTermination(session.id, "failure:guest_exited", {
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
      await this.ctx.store.requestTermination(session.id, "lease_expired");
      log.warn("sandbox_lease_expired", { sessionId: session.id, state: session.state, overrunMs: now - deadline });
    }
  }


}

