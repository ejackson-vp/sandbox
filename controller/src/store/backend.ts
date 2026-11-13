/**
 * What the controller composition root needs from a store backend.
 *
 * `PostgresStore` is the only implementation, and `main.ts` holds this type
 * while the use cases keep depending on the narrow ports (`ReconcilerStore`,
 * `ControlApiStore`, …) they declared. Only the process-level operations live
 * here: lifecycle, the writer guard and readiness.
 *
 * It is an intersection rather than an `interface … extends` because the narrow
 * ports overlap on purpose: `getSession`, `markRefunded` and `mergeTimings` are
 * each declared by more than one consumer, and an interface cannot extend two
 * sources that both declare a member.
 */
import type { ControlApiStore, LedgerAuditStore, ReconcilerStore } from "./ports.js";

interface StoreBackendProcess {
  /** True when this process is deliberately not the writer. */
  readonly writesAreBlocked: boolean;
  /**
   * Take or surrender the writer role.
   *
   * Postgres takes and releases a `pg_advisory_lock`. It is asynchronous because
   * the lock is, and callers await it so a failed takeover surfaces at the
   * leadership boundary rather than on the next write.
   */
  setWritesBlocked(blocked: boolean): Promise<void>;
  recoverInterruptedOperations(): Promise<{ requests: number; sessions: number }>;
  close(): Promise<void>;
}

export type StoreBackend =
  ReconcilerStore & ControlApiStore & LedgerAuditStore & StoreBackendProcess;
