/**
 * Scrape-time publisher for the ledger audit.
 *
 * There is no timer here on purpose. The metrics listener asks for this on each
 * scrape (`main.ts` pushes it onto the `collectors` array), so the cost is one
 * read per scrape and the age of a finding is the scrape interval, not a
 * separate schedule somebody has to keep in sync with the alert.
 *
 * A failed read is not a clean audit: the counter tells an operator the check
 * did not run, and the gauges are left at their last good values rather than
 * being reset to zero, which would look like the books had just balanced.
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

  const divergence = registry.gauge(
    "sandbox_ledger_divergence",
    "Payment intent and ledger pairs whose books disagree, by reason",
  );
  const stale = registry.gauge(
    "sandbox_sessions_stale",
    "Non-terminal sessions past their deadline, by phase",
  );
  const failures = registry.counter(
    "sandbox_ledger_audit_failures_total",
    "Ledger audit scrapes that could not read the store",
  );

  return {
    async collect(): Promise<void> {
      const at = now();
      let snapshot: LedgerAuditSnapshot;
      try {
        snapshot = await options.store.readLedgerAudit(at, limits);
      } catch {
        failures.inc();
        return;
      }
      const result = auditLedger(snapshot, limits, at);
      for (const reason of LEDGER_DIVERGENCE_REASONS) {
        divergence.set({ reason }, result.divergenceCounts[reason]);
      }
      for (const phase of AUDIT_SESSION_PHASES) {
        stale.set({ phase }, result.staleCounts[phase]);
      }
    },
  };
}
