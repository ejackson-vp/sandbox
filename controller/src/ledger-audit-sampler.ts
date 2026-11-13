/**
 * Periodic publisher for the ledger audit.
 *
 * The audit used to run inside `/metrics`: one read of `payment_intents` and
 * `sessions` per scrape, per replica, whether or not anybody looked at it. That
 * is about 25 ms at 100k payment intents and 1.3 s at 10M, every 15 s, forever.
 * The read is now on its own timer (`LEDGER_AUDIT_INTERVAL_MS`, five minutes by
 * default) and the scrape only renders the last sampled values and their age.
 *
 * Four properties matter when the database is slow rather than down:
 *
 *  - one sample at a time. A tick that lands while a sample is still waiting
 *    returns immediately, so store latency cannot queue work behind itself and
 *    a hung statement costs one connection, not a growing backlog;
 *  - the read runs on the audit's own connection with its own timeout
 *    (`PgConnection.queryReadOnly`), so it cannot starve the writer pool;
 *  - a failed sample increments `sandbox_ledger_audit_failures_total` and
 *    changes nothing else. The gauge families are registered by the first
 *    successful sample and then left alone, because resetting them to zero
 *    would look like the books had just balanced;
 *  - freshness is visible on its own. `sandbox_ledger_audit_age_seconds` is
 *    recomputed from the clock on every scrape, so a sampler whose reads fail
 *    shows a rising age rather than a stale zero. Before the first success the
 *    family is absent and the failures counter is the signal.
 */
import {
  auditLedger,
  AUDIT_SESSION_PHASES,
  DEFAULT_LEDGER_AUDIT_LIMITS,
  LEDGER_DIVERGENCE_REASONS,
  type LedgerAuditLimits,
  type LedgerAuditSnapshot,
} from "./ledger-audit.js";
import type { LedgerAuditStore } from "./store/ports.js";
import { metrics, type MetricsRegistry } from "@x402s/shared/runtime";

/** The registry's gauge handle, without exporting the class. */
type Gauge = ReturnType<MetricsRegistry["gauge"]>;

export interface LedgerAuditSamplerOptions {
  store: LedgerAuditStore;
  /** How often a sample runs. `LEDGER_AUDIT_INTERVAL_MS` supplies it in `main`. */
  intervalMs: number;
  limits?: LedgerAuditLimits;
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Injectable registry for tests; defaults to the process registry. */
  registry?: MetricsRegistry;
}

export interface LedgerAuditSampler {
  /** One sampling pass. The timer calls this; tests call it directly. */
  sample(): Promise<void>;
  /**
   * Scrape-time hook: recompute the age gauge from memory. No store read, so
   * the scrape path stays O(1) whatever the ledger size.
   */
  collect(): void;
  /** Sample once now, then on every interval. Idempotent. */
  start(): void;
  stop(): void;
}

export function createLedgerAuditSampler(
  options: LedgerAuditSamplerOptions,
): LedgerAuditSampler {
  const limits = options.limits ?? DEFAULT_LEDGER_AUDIT_LIMITS;
  const now = options.now ?? (() => Date.now());
  const registry = options.registry ?? metrics;

  const failures = registry.counter(
    "sandbox_ledger_audit_failures_total",
    "Ledger audit samples that could not read the store",
  );
  let divergence: Gauge | undefined;
  let stale: Gauge | undefined;
  let age: Gauge | undefined;
  /** Completion time of the last successful sample; null until one succeeds. */
  let lastSuccessAt: number | null = null;
  let running = false;
  let timer: NodeJS.Timeout | undefined;

  /**
   * The gauge families are created by the first successful sample, not at
   * construction. That keeps a failed first read from exporting an unlabeled
   * zero, and keeps them off relay and proxy pods, which never run the audit:
   * `createLedgerAuditSampler` is only called in the controller role.
   */
  function registerFamilies(): { divergence: Gauge; stale: Gauge } {
    divergence ??= registry.gauge(
      "sandbox_ledger_divergence",
      "Payment intent and ledger pairs whose books disagree, by reason",
    );
    stale ??= registry.gauge(
      "sandbox_sessions_stale",
      "Non-terminal sessions past their deadline, by phase",
    );
    age ??= registry.gauge(
      "sandbox_ledger_audit_age_seconds",
      "Seconds since the ledger audit last read the store",
    );
    return { divergence, stale };
  }

  function publishAge(at: number): void {
    if (!age || lastSuccessAt === null) return;
    // A backwards clock step is not negative freshness.
    age.set({}, Math.max(0, (at - lastSuccessAt) / 1000));
  }

  async function sample(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const at = now();
      // Refresh freshness before the read: a sample that then hangs or fails
      // still advances the age, so scrape-time freshness is current even
      // between ticks.
      publishAge(at);
      let snapshot: LedgerAuditSnapshot;
      try {
        snapshot = await options.store.readLedgerAudit(at, limits);
      } catch {
        // No gauge is touched: the last good counts and the last success time
        // stay, so the age keeps rising and a read failure never reads as
        // balance.
        failures.inc();
        return;
      }
      const result = auditLedger(snapshot, limits, at);
      const families = registerFamilies();
      for (const reason of LEDGER_DIVERGENCE_REASONS) {
        families.divergence.set({ reason }, result.divergenceCounts[reason]);
      }
      for (const phase of AUDIT_SESSION_PHASES) {
        families.stale.set({ phase }, result.staleCounts[phase]);
      }
      lastSuccessAt = now();
      publishAge(lastSuccessAt);
    } finally {
      running = false;
    }
  }

  return {
    sample,
    collect(): void {
      publishAge(now());
    },
    start(): void {
      if (timer) return;
      // Sample on startup rather than after one interval: a fresh process has
      // no readings, and five minutes of absent families after a deploy is a
      // long blind spot.
      void sample();
      timer = setInterval(() => {
        void sample();
      }, options.intervalMs);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
