/**
 * Single-writer persistence for entitlements, sessions and operations.
 *
 * SQLite (WAL) is deliberate for the prototype: payment redemption and session
 * creation must be atomic, and the reconciler must survive restarts. In
 * production this becomes Postgres/DynamoDB with the same invariants
 * (UNIQUE payment key, conditional transitions, UNIQUE (session, request)).
 *
 * Schema changes are additive and transactional; a database from a newer build
 * is refused rather than downgraded.
 */
import { statSync } from "node:fs";
import { backup as sqliteBackup, DatabaseSync, type StatementSync } from "node:sqlite";
import {
  mapLedger,
  mapSession,
  type ClaimOperationResult,
  type ExecRequestRecord,
  type IntentClaimResult,
  type LedgerStatus,
  type PaymentIntentRecord,
  type PaymentLedgerRecord,
  type PaymentRecord,
  type RawSession,
  type SessionRecord,
  type SessionState,
} from "./store/models.js";
import { migrate } from "./store/schema.js";
import { checkStoreHealth, type StoreHealth } from "./store/health.js";
import { prepareStatements } from "./store/statements.js";
import { PaymentRepository } from "./store/payments.js";
import { cadenceFor } from "./reconcile-cadence.js";
import { finalStateForReason, metrics, SOURCE_STATES } from "@x402s/shared";

import { ReservationRepository } from "./capacity/reservations.js";
import type { ReservationStore } from "./capacity/reservation-store.js";

export type { StoreHealth } from "./store/health.js";
export type {
  ClaimOperationResult,
  ExecRequestRecord,
  IntentClaimResult,
  IntentStatus,
  LedgerStatus,
  PaymentIntentRecord,
  PaymentLedgerRecord,
  PaymentRecord,
  SessionRecord,
  SessionState,
} from "./store/models.js";
export { PaymentAlreadyRedeemedError, PaymentClaimLostError } from "./store/models.js";

const SCHEMA_LOCK = /database is locked|database table is locked|SQLITE_BUSY/i;

/**
 * Failure reasons produced by the provisioning/lifecycle paths. Anything else
 * is collapsed to `other` so a new free-text reason cannot grow cardinality
 * before it is added here deliberately.
 */
const PROVISION_FAILURE_REASONS = new Set([
  "provisioning_timeout",
  "provisioning_queue_timeout",
  "warm_claim_timeout",
  "pod_terminated",
  "checkpoint_missing",
  "guest_exited",
  "reaped",
  "guest_protocol_unsupported",
  "guest_measurement_not_allowed",
  "guest_attestation_rejected",
]);

function boundedFailureReason(reason: string): string {
  return PROVISION_FAILURE_REASONS.has(reason) ? reason : "other";
}

/**
 * Per-state re-due cadence lives in `reconcile-cadence.ts` (policy, not SQL).
 * Re-exported here because the schedule column is a storage concern and
 * existing callers import the fallback from the store.
 */
export { DEFAULT_REDUE_INTERVAL_MS } from "./reconcile-cadence.js";

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class Store {
  private readonly db: DatabaseSync;
  private readonly stmts: Record<string, StatementSync>;
  readonly reservations: ReservationStore;
  readonly payments: PaymentRepository;
  /** Path of the main database file (`:memory:` in tests). */
  readonly path: string;
  /**
   * True while this process is a standby for the single-writer role. Backed by
   * SQLite's own `query_only` switch rather than a flag checked per method, so
   * every path below, the payment repository and the reservation repository are
   * covered by one guard and a new statement cannot forget to check it.
   */
  private writesBlocked = false;

  constructor(path: string) {
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    for (let attempt = 0; ; attempt += 1) {
      try {
        migrate(this.db);
        break;
      } catch (err) {
        if (attempt >= 10 || !SCHEMA_LOCK.test((err as Error).message)) throw err;
        // Concurrent starts (workers, future replicas) can race idempotent DDL.
        // The statements are safe to replay, so back off and retry.
        metrics
          .counter("sandbox_sqlite_busy_retries_total", "SQLite operations retried after SQLITE_BUSY")
          .inc();
        sleepSync(100 * (attempt + 1));
      }
    }
    this.reservations = new ReservationRepository(this.db);

    this.stmts = prepareStatements(this.db);
    this.payments = new PaymentRepository(this.db, this.stmts);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Refuse writes on this connection unless this process holds the writer role.
   *
   * A follower shares one SQLite file with the leader (see the RWO volume note
   * in docs/adr/0009), so a write that slipped past the scheduler would be a
   * second writer, not a harmless no-op. Turning it into an error keeps the
   * failure loud and local: the reconciler logs it, the control API returns
   * 500, and no row diverges.
   *
   * `query_only` only affects writes, so a standby can still serve reads,
   * backups and the readiness probe while it waits for the lease.
   */
  setWritesBlocked(blocked: boolean): void {
    if (blocked === this.writesBlocked) return;
    this.db.exec(`PRAGMA query_only = ${blocked ? "ON" : "OFF"}`);
    this.writesBlocked = blocked;
  }

  /** True when this connection is deliberately read-only (a leadership standby). */
  get writesAreBlocked(): boolean {
    return this.writesBlocked;
  }

  /**
   * Readiness probe: schema is current and the database accepts a write.
   * Runs on the store connection so it sees exactly what the reconciler sees.
   */
  healthCheck(): StoreHealth {
    return checkStoreHealth(this.db, { writable: !this.writesBlocked });
  }

  /**
   * On-disk size of the database and its WAL sidecar. `:memory:` databases
   * report 0; the files may disappear between stat calls during a checkpoint,
   * so a missing file is 0 rather than an error.
   */
  stats(): { sizeBytes: number; walBytes: number } {
    const sizeOf = (path: string): number => {
      try {
        return statSync(path).size;
      } catch {
        return 0;
      }
    };
    if (this.path === ":memory:") return { sizeBytes: 0, walBytes: 0 };
    return { sizeBytes: sizeOf(this.path), walBytes: sizeOf(`${this.path}-wal`) };
  }

  /** Consistent online copy for the backup service. */
  async backupTo(path: string): Promise<void> {
    await sqliteBackup(this.db, path);
  }

  /* ---------------- payment intents (outbox) ---------------- */

  /** Lease an intent; see PaymentRepository for the ownership contract. */
  claimPaymentIntent(paymentKey: string, specHashValue: string, staleMs: number): IntentClaimResult {
    return this.payments.claimPaymentIntent(paymentKey, specHashValue, staleMs);
  }

  getPaymentIntent(paymentKey: string): PaymentIntentRecord | null {
    return this.payments.getPaymentIntent(paymentKey);
  }

  failPaymentIntent(paymentKey: string, reason: string): void {
    this.payments.failPaymentIntent(paymentKey, reason);
  }

  /** Settle the intent and create the paid session (see PaymentRepository). */
  completeEntitlement(
    paymentKey: string,
    claimToken: string,
    payment: PaymentRecord,
    session: SessionRecord,
  ): { sessionId: string; created: boolean } {
    return this.payments.completeEntitlement(paymentKey, claimToken, payment, session);
  }

  /* ---------------- sessions ---------------- */

  getSession(id: string): SessionRecord | null {
    const row = this.stmts.getSession!.get(id) as RawSession | undefined;
    return row ? mapSession(row) : null;
  }

  getPayment(key: string): PaymentRecord | null {
    const row = this.stmts.getPayment!.get(key) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      paymentKey: row.payment_key as string,
      network: row.network as string,
      scheme: row.scheme as string,
      asset: row.asset as string,
      amount: row.amount as string,
      payTo: row.pay_to as string,
      payer: row.payer as string | undefined,
      transaction: row.tx as string | undefined,
      mode: row.mode as "mock" | "testnet",
    };
  }

  getLedgerByPayment(paymentKey: string): PaymentLedgerRecord | null {
    const row = this.stmts.getLedgerByPayment!.get(paymentKey) as Record<string, unknown> | undefined;
    return row ? mapLedger(row) : null;
  }

  getLedgerBySession(sessionId: string): PaymentLedgerRecord | null {
    const row = this.stmts.getLedgerBySession!.get(sessionId) as Record<string, unknown> | undefined;
    return row ? mapLedger(row) : null;
  }

  listLedgerByStatus(status: LedgerStatus): PaymentLedgerRecord[] {
    return (this.stmts.listLedgerByStatus!.all(status) as unknown as Array<Record<string, unknown>>).map(mapLedger);
  }

  listUnrefundedTerminalBeforeReady(): PaymentLedgerRecord[] {
    return (this.stmts.listUnrefundedTerminalBeforeReady!.all() as unknown as Array<Record<string, unknown>>)
      .map(mapLedger);
  }

  markRefundPending(paymentKey: string, reason: string): boolean {
    return this.stmts.markRefundPending!.run(reason.slice(0, 500), Date.now(), paymentKey).changes > 0;
  }

  markRefunded(paymentKey: string, transaction: string, reason: string): boolean {
    return this.stmts.markRefunded!.run(reason.slice(0, 500), transaction, Date.now(), paymentKey).changes > 0;
  }

  listNonTerminal(): SessionRecord[] {
    return (this.stmts.listNonTerminal!.all() as unknown as RawSession[]).map(mapSession);
  }

  /** Move a session's next reconcile pass. Cadence policy belongs to the caller. */
  bumpDue(id: string, atMs: number): boolean {
    return this.stmts.bumpDue!.run(atMs, id).changes > 0;
  }

  /**
   * Advance a session's due time only if it is still due right now.
   *
   * Used by the reconcile pass after it processed a session: an unchanged
   * session must move forward so `listDue` cannot return it again, while a
   * session whose state change already armed a future deadline must not be
   * overwritten. Returns true when this call moved it.
   */
  rearmDue(id: string, atMs: number, nowMs: number): boolean {
    return this.stmts.rearmDue!.run(atMs, id, nowMs).changes > 0;
  }

  /** Live sessions whose next pass is due right now. */
  countDue(nowMs: number): number {
    return ((this.stmts.countDue!.get(nowMs) as { n: number } | undefined)?.n ?? 0);
  }

  /** Live session counts by state, without materialising rows. */
  countLiveByState(): Partial<Record<SessionState, number>> {
    const counts: Partial<Record<SessionState, number>> = {};
    for (const row of this.stmts.countLiveByState!.all() as Array<{ state: string; n: number }>) {
      counts[row.state as SessionState] = row.n;
    }
    return counts;
  }

  /** Live sessions whose next pass is due, earliest first, bounded by `limit`. */
  listDue(nowMs: number, limit: number): SessionRecord[] {
    return (this.stmts.listDue!.all(nowMs, limit) as unknown as RawSession[]).map(mapSession);
  }

  listTerminalWithPod(): SessionRecord[] {
    return (this.stmts.listTerminalWithPod!.all() as unknown as RawSession[]).map(mapSession);
  }

  countSessions(): number {
    return ((this.stmts.countSessions!.get() as { n: number } | undefined)?.n ?? 0);
  }

  countPayments(): number {
    return ((this.stmts.countPayments!.get() as { n: number } | undefined)?.n ?? 0);
  }

  setProvisioning(id: string, podName: string): boolean {
    const now = Date.now();
    return this.stmts.setProvisioning!.run(podName, now + cadenceFor("PROVISIONING"), now, id).changes > 0;
  }

  /** Replace the pod of a session that is already PROVISIONING (relay restart). */
  setProvisioningPod(id: string, podName: string): boolean {
    return this.stmts.setProvisioningPod!.run(podName, Date.now(), id).changes > 0;
  }

  setRelayToken(id: string, tokenHash: string): void {
    this.stmts.setRelayToken!.run(tokenHash, Date.now(), id);
  }

  setReady(
    id: string,
    readyAt: number,
    leaseExpiresAt: number,
    attestationJson: string,
    guestPublicKey: string,
  ): boolean {
    const now = Date.now();
    return (
      this.stmts.setReady!.run(
        readyAt,
        leaseExpiresAt,
        attestationJson,
        guestPublicKey,
        readyAt,
        now + cadenceFor("READY"),
        now,
        id,
      ).changes > 0
    );
  }

  touchActivity(id: string): void {
    const now = Date.now();
    this.stmts.touchActivity!.run(now, now, id);
  }

  markSuspending(id: string): boolean {
    const now = Date.now();
    return this.stmts.markSuspending!.run(now + cadenceFor("SUSPENDING"), now, id).changes > 0;
  }

  markSuspended(id: string, suspendedAt: number): boolean {
    return (
      this.stmts.markSuspended!.run(
        suspendedAt,
        suspendedAt + cadenceFor("SUSPENDED"),
        suspendedAt,
        id,
      ).changes > 0
    );
  }

  markResuming(id: string, podName: string): boolean {
    const now = Date.now();
    return this.stmts.markResuming!.run(podName, now + cadenceFor("RESUMING"), now, id).changes > 0;
  }

  setWorkspacePvc(id: string, pvcName: string): void {
    this.stmts.setWorkspacePvc!.run(pvcName, Date.now(), id);
  }

  setNodeName(id: string, nodeName: string): void {
    this.stmts.setNodeName!.run(nodeName, Date.now(), id);
  }

  clearWorkspacePvc(id: string): void {
    this.stmts.clearWorkspacePvc!.run(Date.now(), id);
  }

  listTerminalWithPvc(): SessionRecord[] {
    return (this.stmts.listTerminalWithPvc!.all() as unknown as RawSession[]).map(mapSession);
  }

  requestTermination(id: string, reason: string, failure?: { code: string; message: string }): boolean {
    const now = Date.now();
    const changed = this.stmts.requestTermination!.run(
      now,
      reason,
      now + cadenceFor("TERMINATING"),
      now,
      id,
    ).changes > 0;
    if (changed && reason.startsWith("failure:")) {
      metrics
        .counter("sandbox_provision_failures_total", "Sessions failed during provisioning by reason")
        .inc({ reason: boundedFailureReason(reason.slice("failure:".length)) });
    }
    if (changed && failure) {
      this.stmts.setFailure!.run(failure.code, failure.message, now, id);
    }
    return changed;
  }

  /** Terminal state is derived from the termination reason. */
  finalizeTermination(id: string): SessionState | null {
    const session = this.getSession(id);
    if (!session || session.state !== "TERMINATING") return null;
    const reason = session.terminationReason ?? "";
    const final = finalStateForReason(reason);
    const now = Date.now();
    this.stmts.finalize!.run(final, now, now + cadenceFor(final), now, id);
    return final;
  }

  requestDestroy(id: string): void {
    // Due now: a destroy is an event, not a state that can wait out its cadence.
    const now = Date.now();
    this.stmts.requestDestroy!.run(now, now, id);
  }

  markRelayPurged(id: string): void {
    this.stmts.markRelayPurged!.run(Date.now(), Date.now(), id);
  }

  clearPod(id: string): void {
    this.stmts.clearPod!.run(Date.now(), id);
  }

  /** Atomically merge lifecycle timings (JSON patch semantics). */
  mergeTimings(id: string, patch: Record<string, number | undefined>): void {
    const clean: Record<string, number> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
    }
    if (Object.keys(clean).length === 0) return;
    this.stmts.mergeTimings!.run(JSON.stringify(clean), Date.now(), id);
  }

  /* ---------------- operations ---------------- */

  /**
   * Startup recovery: the previous controller process may have died with an
   * operation in flight. Its outcome is unknown, so the request becomes
   * `outcome_unknown` and its session keeps the single-operation gate closed.
   *
   * The session's execution epoch is bumped in the same transaction. The gate
   * is released only by `clearFencedGate` after the relay reports that the
   * guest no longer has that request active (see OperationFence). Recovery
   * publishes the new epoch to the relay before the fence can clear: the relay
   * then refuses frames from an older generation and withdraws one that was
   * forwarded but never observed, so it cannot start at the guest afterwards.
   */
  recoverInterruptedOperations(): { requests: number; sessions: number } {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const requests = this.stmts.markPendingOutcomeUnknown!.run(now).changes;
      const sessions = this.stmts.fenceActiveSessions!.run(now).changes;
      this.db.exec("COMMIT");
      return { requests: Number(requests), sessions: Number(sessions) };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Sessions whose operation gate is held by an unreconciled recovery fence. */
  listFencedSessions(): SessionRecord[] {
    return (this.stmts.listFencedSessions!.all() as unknown as RawSession[]).map(mapSession);
  }

  /**
   * Release a recovery fence only if it still describes this session and
   * generation. Idempotent: a second caller (or a newer operation) changes
   * nothing.
   */
  clearFencedGate(sessionId: string, requestId: string, epoch: number): boolean {
    const now = Date.now();
    return (
      this.stmts.clearFencedGate!.run(
        now + cadenceFor("READY"),
        now,
        sessionId,
        requestId,
        epoch,
      ).changes > 0
    );
  }

  /**
   * Atomically claim the single operation slot for a session.
   * Request id doubles as the idempotency key. The returned epoch must travel
   * with the relay frame so the guest can reject stale generations.
   */
  claimOperation(sessionId: string, requestId: string, op: string): ClaimOperationResult {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const session = this.getSession(sessionId);
      if (!session) {
        this.db.exec("COMMIT");
        return { ok: false, code: "not_usable", state: "FAILED" };
      }
      if (!SOURCE_STATES.operation_started.includes(session.state)) {
        this.db.exec("COMMIT");
        return { ok: false, code: "not_usable", state: session.state };
      }
      if (session.leaseExpiresAt !== null && now >= session.leaseExpiresAt) {
        this.db.exec("COMMIT");
        return { ok: false, code: "lease_expired", state: session.state };
      }
      const existing = this.stmts.getRequest!.get(sessionId, requestId) as
        | { state: string }
        | undefined;
      if (existing) {
        this.db.exec("COMMIT");
        return { ok: false, code: "duplicate", state: session.state, requestId };
      }
      if (session.activeRequestId) {
        this.db.exec("COMMIT");
        return { ok: false, code: "busy", state: session.state, requestId: session.activeRequestId };
      }
      this.stmts.insertRequest!.run(requestId, sessionId, op, session.execEpoch, now, now);
      this.stmts.claimActive!.run(requestId, now + cadenceFor("ACTIVE"), now, sessionId);
      this.db.exec("COMMIT");
      return { ok: true, requestId, epoch: session.execEpoch };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  finishOperation(sessionId: string, requestId: string, outcome: "done" | "error" | "abandoned"): void {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // A caller may have read this request as pending before a controller
      // restart fenced it. Recovery owns that request now; a stale finish must
      // not clear the gate or overwrite `outcome_unknown`.
      const finished = this.stmts.finishRequest!.run(outcome, now, sessionId, requestId).changes;
      if (finished > 0) this.stmts.clearActive!.run(now + cadenceFor("READY"), now, sessionId, requestId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getExecRequest(sessionId: string, requestId: string): ExecRequestRecord | null {
    const row = this.stmts.getRequest!.get(sessionId, requestId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      op: row.op as string,
      state: row.state as ExecRequestRecord["state"],
      epoch: row.epoch as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}
