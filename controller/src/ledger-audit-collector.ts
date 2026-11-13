/**
 * Scrape-time publisher for the ledger audit.
 *
 * There is no timer here on purpose. The metrics listener asks for this on each
 * scrape (`main.ts` pushes it onto the `collectors` array), so the cost is one
 * read per scrape and the age of a finding is the scrape interval, not a
 * separate schedule somebody has to keep in sync with the alert.
 *
 * Three properties matter when the database is slow rather than down:
 *
 *  - one collect at a time. A stacked scrape returns immediately and reads the
 *    value the in-flight one is about to publish, so scrape handlers cannot
 *    queue behind each other;
 *  - the read runs on the audit's own connection with its own timeout
 *    (`PgConnection.queryReadOnly`), so it cannot starve the writer pool;
 *  - the gauge families are only registered by a successful read. Before the
 *    first success, or while reads fail, they are absent rather than zero, and
 *    `sandbox_ledger_audit_failures_total` is the signal. After a success a
 *    later failure leaves the last good values alone, because resetting them to
 *    zero would look like the books had just balanced.
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

export interface LedgerAuditCollectorOptions {
  store: LedgerAuditStore;
  limits?: LedgerAuditLimits;
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Injectable registry for tests; defaults to the process registry. */
  registry?: MetricsRegistry;
}

export interface LedgerAuditCollector {
  /** Refresh the audit gauges. Awaited by the metrics listener per scrape. */
  collect(): Promise<void>;
}

export function createLedgerAuditCollector(
  options: LedgerAuditCollectorOptions,
): LedgerAuditCollector {
  const limits = options.limits ?? DEFAULT_LEDGER_AUDIT_LIMITS;
  const now = options.now ?? (() => Date.now());
  const registry = options.registry ?? metrics;

  const failures = registry.counter(
    "sandbox_ledger_audit_failures_total",
    "Ledger audit scrapes that could not read the store",
  );
  let running = false;

  return {
    async collect(): Promise<void> {
      if (running) return;
      running = true;
      try {
        const at = now();
        let snapshot: LedgerAuditSnapshot;
        try {
          snapshot = await options.store.readLedgerAudit(at, limits);
        } catch {
          failures.inc();
          return;
        }
        const result = auditLedger(snapshot, limits, at);
        // Registering here, not at construction, keeps a failed first read from
        // exporting an unlabeled zero that a `sum()` would read as balance. It
        // also keeps the families off relay and proxy pods, which never run the
        // audit: `createLedgerAuditCollector` is only called in the controller
        // role.
        const divergence = registry.gauge(
          "sandbox_ledger_divergence",
          "Payment intent and ledger pairs whose books disagree, by reason",
        );
        const stale = registry.gauge(
          "sandbox_sessions_stale",
          "Non-terminal sessions past their deadline, by phase",
        );
        for (const reason of LEDGER_DIVERGENCE_REASONS) {
          divergence.set({ reason }, result.divergenceCounts[reason]);
        }
        for (const phase of AUDIT_SESSION_PHASES) {
          stale.set({ phase }, result.staleCounts[phase]);
        }
      } finally {
        running = false;
      }
    },
  };
}
