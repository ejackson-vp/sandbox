/**
 * Bounded dispatch for one reconcile phase.
 *
 * Extracted from the scheduler so the boundary the architecture doc draws is
 * visible in the file layout: this module owns concurrency and the per-session
 * serialization guarantee, and it holds no policy. What a session is reconciled
 * to, and in which order the phases run, stay in `reconciler.ts`.
 *
 * Sessions already in flight are skipped (they are picked up by the next pass),
 * which is the per-session serialization guarantee. Queue depth and queue wait
 * are exported with a bounded `phase` label so a burst shows up before it
 * becomes tail latency; session ids never enter metrics.
 */
import { LATENCY_BUCKETS, metrics } from "@x402s/shared/runtime";
import { runBounded } from "../bounded-queue.js";
import type { SessionRecord } from "../store/models.js";

/** The scheduler knobs dispatch needs, and nothing else. */
export interface DispatchRuntime {
  /** Workers per phase. */
  readonly concurrency: number;
  now(): number;
}

export class PhaseDispatcher {
  /**
   * Sessions a pass is currently reconciling. No later pass may run one of
   * these again: lease expiry and termination are stateful, so two concurrent
   * attempts on one id would race.
   */
  private readonly inFlight = new Set<string>();

  constructor(private readonly ctx: DispatchRuntime) {}

  async run(
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
          concurrency: this.ctx.concurrency,
          now: () => this.ctx.now(),
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
}
