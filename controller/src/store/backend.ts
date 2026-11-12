/**
 * What the controller composition root needs from a store backend.
 *
 * `Store` (SQLite) and `PostgresStore` both satisfy this structurally, so
 * `main.ts` can hold one type and the use cases keep depending on the narrow
 * ports (`ReconcilerStore`, `ControlApiStore`, …) they declared. Only the
 * process-level operations live here: lifecycle, the writer guard, readiness and
 * the scrape-time size gauges.
 *
 * It is an intersection rather than an `interface … extends` because the narrow
 * ports overlap on purpose: `getSession`, `markRefunded` and `mergeTimings` are
 * each declared by more than one consumer, and an interface cannot extend two
 * sources that both declare a member.
 */
import type { ControlApiStore, MetricsStore, ReconcilerStore } from "./ports.js";

interface StoreBackendProcess {
  /** True when this process is deliberately not the writer. */
  readonly writesAreBlocked: boolean;
  /**
   * Take or surrender the writer role.
   *
   * SQLite implements this with `PRAGMA query_only`; Postgres takes and releases
   * a `pg_advisory_lock`. It is asynchronous because the lock is, and callers
   * await it so a failed takeover surfaces at the leadership boundary rather than
   * on the next write. The guard itself closes synchronously on release.
   */
  setWritesBlocked(blocked: boolean): void | Promise<void>;
  recoverInterruptedOperations(): Promise<{ requests: number; sessions: number }>;
  close(): void | Promise<void>;
}

export type StoreBackend = ReconcilerStore &
  ControlApiStore &
  MetricsStore &
  StoreBackendProcess;
