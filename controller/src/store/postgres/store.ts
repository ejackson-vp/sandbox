/**
 * The Postgres adapter behind the store ports.
 *
 * Structure is one facade over repositories that own one concern each. What
 * matters is where the invariants come from. There is a pool, so every invariant
 * has to be carried by the statement or by an explicit lock:
 *
 *   - transitions are conditional `UPDATE … RETURNING` (see `sessions.ts`,
 *     `operations.ts`);
 *   - every transaction is `READ COMMITTED`, per ADR 0010;
 *   - `pg_advisory_lock` on a dedicated connection is the writer backstop behind
 *     the Kubernetes Lease, and a write without it throws;
 *   - the two read-then-count decisions (create budget, capacity admission) take
 *     a transaction-scoped advisory lock, because a count of rows is not
 *     something a row lock can make stable.
 *
 * `open()` is a factory rather than a constructor because opening runs DDL.
 */
import { metrics } from "@x402s/shared/runtime";
import {
  NON_TERMINAL_STATE_SQL,
  type ChallengeBurnResult,
  type LedgerStatus,
  type PaymentRecord,
  type SessionRecord,
  type SessionState,
  type StoreHealth,
  type UnclaimedLedgerEntry,
} from "../models.js";
import { boundedFailureReason } from "../failure-reasons.js";
import type { BudgetDecision, BudgetLimits } from "../budget-decision.js";
import type { ReservationStore } from "../../capacity/reservation-store.js";
import type { StoreBackend } from "../backend.js";
import { migratePostgres } from "./schema.js";
import { PgConnection, WriterLockUnavailableError } from "./pg.js";
import { PgSessionRepository } from "./sessions.js";
import { PgBudgetRepository } from "./budgets.js";
import { PgPaymentRepository } from "./payments.js";
import { PgLedgerRepository } from "./ledger.js";
import { PgChallengeNonceRepository } from "./challenges.js";
import { PgOperationRepository } from "./operations.js";
import { PgReservationRepository } from "./reservations.js";
import { checkPostgresHealth } from "./health.js";

export { WriterLockUnavailableError } from "./pg.js";

interface PostgresStoreOptions {
  /**
   * Start as the writer and migrate. `false` opens a read-only participant: it
   * migrates nothing and refuses to write until `setWritesBlocked(false)`
   * acquires the lock. Defaults to `true`.
   */
  writer?: boolean;
  /** Fixed window for the durable create budget; matches the controller default. */
  budgetWindowMs?: number;
  /** Pool size. One extra connection carries the writer lock. */
  max?: number;
}

export class PostgresStore implements StoreBackend {
  readonly reservations: ReservationStore;
  private readonly sessions: PgSessionRepository;
  private readonly payments: PgPaymentRepository;
  private readonly ledgerRepo: PgLedgerRepository;
  private readonly challengeRepo: PgChallengeNonceRepository;
  private readonly operations: PgOperationRepository;
  private readonly budgetRepo: PgBudgetRepository;

  private constructor(private readonly conn: PgConnection, budgetWindowMs: number) {
    this.sessions = new PgSessionRepository(conn);
    this.budgetRepo = new PgBudgetRepository(conn);
    this.payments = new PgPaymentRepository(conn, this.sessions, this.budgetRepo, budgetWindowMs);
    this.ledgerRepo = new PgLedgerRepository(conn);
    this.challengeRepo = new PgChallengeNonceRepository(conn);
    this.operations = new PgOperationRepository(conn);
    this.reservations = new PgReservationRepository(conn);
  }

  static async open(url: string, options: PostgresStoreOptions = {}): Promise<PostgresStore> {
    const conn = new PgConnection(url, options.max !== undefined ? { max: options.max } : {});
    const writer = options.writer !== false;
    if (writer) {
      const acquired = await conn.acquireWriterLock();
      if (!acquired) {
        await conn.close();
        throw new WriterLockUnavailableError(
          "another process already holds the store writer lock; refusing to start a second writer",
        );
      }
      try {
        await conn.tx((tx) => migratePostgres(tx, NON_TERMINAL_STATE_SQL));
      } catch (err) {
        await conn.close();
        throw err;
      }
    }
    // A standby opens with no schema check on purpose. The schema belongs to the
    // process holding the writer lock, so a replica that starts before the leader
    // has migrated reports `migrations_incomplete` on its readiness probe instead
    // of upgrading tables it does not own. Migration happens in
    // `setWritesBlocked(false)`, which is the leadership boundary.
    const store = new PostgresStore(conn, options.budgetWindowMs ?? 3_600_000);
    return store;
  }

  get writesAreBlocked(): boolean {
    return this.conn.writesAreBlocked;
  }

  async setWritesBlocked(blocked: boolean): Promise<void> {
    if (blocked === this.conn.writesAreBlocked) return;
    if (blocked) {
      await this.conn.releaseWriterLock();
      return;
    }
    const acquired = await this.conn.acquireWriterLock();
    if (!acquired) {
      throw new WriterLockUnavailableError(
        "another process holds the store writer lock; refusing to become the writer",
      );
    }
    // The lock holder owns the schema, so a takeover also applies the ladder. It
    // is one `SELECT version` when the database is already current.
    await this.conn.tx((tx) => migratePostgres(tx, NON_TERMINAL_STATE_SQL));
  }

  close(): Promise<void> {
    return this.conn.close();
  }

  async healthCheck(): Promise<StoreHealth> {
    return checkPostgresHealth(this.conn, { writable: !this.conn.writesAreBlocked });
  }

  recoverInterruptedOperations(): Promise<{ requests: number; sessions: number }> {
    return this.operations.recoverInterruptedOperations();
  }

  /* ---------------- payment intents (outbox) ---------------- */

  claimPaymentIntent(
    paymentKey: string,
    specHashValue: string,
    staleMs: number,
    requirementsJson: string | null = null,
  ) {
    return this.payments.claimPaymentIntent(paymentKey, specHashValue, staleMs, requirementsJson);
  }

  getPaymentIntent(paymentKey: string) {
    return this.payments.getIntent(paymentKey);
  }

  failPaymentIntent(paymentKey: string, reason: string): Promise<void> {
    return this.payments.failIntent(paymentKey, reason);
  }

  completeEntitlement(
    paymentKey: string,
    claimToken: string,
    payment: PaymentRecord,
    session: SessionRecord,
  ): Promise<{ sessionId: string; created: boolean }> {
    return this.payments.completeEntitlement(paymentKey, claimToken, payment, session);
  }

  /* ---------------- challenge nonces (F-07) ---------------- */

  issueChallengeNonce(
    nonce: string,
    ttlMs: number,
    maxActive: number,
  ): Promise<{ nonce: string; expiresAt: number }> {
    return this.challengeRepo.issue(nonce, Date.now(), ttlMs, maxActive);
  }

  burnChallengeNonce(nonce: string, paymentKey: string): Promise<ChallengeBurnResult> {
    return this.challengeRepo.burn(nonce, paymentKey, Date.now());
  }

  pruneChallengeNonces(): Promise<number> {
    return this.challengeRepo.prune(Date.now());
  }

  /* ---------------- durable budgets (#48) ---------------- */

  reserveBudgets(payer: string | null, amountAtomic: string, limits: BudgetLimits): Promise<BudgetDecision> {
    return this.budgetRepo.reserve(payer, amountAtomic, limits, Date.now());
  }

  /* ---------------- sessions ---------------- */

  getSession(id: string): Promise<SessionRecord | null> {
    return this.sessions.get(id);
  }

  getPayment(key: string): Promise<PaymentRecord | null> {
    return this.payments.getPaymentRecord(key);
  }

  /* ---------------- payment ledger (delegated) ---------------- */

  getLedgerByPayment(paymentKey: string) {
    return this.ledgerRepo.getByPayment(paymentKey);
  }

  getLedgerBySession(sessionId: string) {
    return this.ledgerRepo.getBySession(sessionId);
  }

  getLedgerByNonce(settlementNonce: string) {
    return this.ledgerRepo.getByNonce(settlementNonce);
  }

  listLedgerByStatus(status: LedgerStatus) {
    return this.ledgerRepo.listByStatus(status);
  }

  countLedgerByStatus(status: LedgerStatus): Promise<number> {
    return this.ledgerRepo.countByStatus(status);
  }

  listUnrefundedTerminalBeforeReady() {
    return this.ledgerRepo.listUnrefundedTerminalBeforeReady();
  }

  listUnclaimedSettled() {
    return this.ledgerRepo.listUnclaimedSettled();
  }

  listRefundPendingDue(now: number, limit: number) {
    return this.ledgerRepo.listRefundPendingDue(now, limit);
  }

  markRefundPending(paymentKey: string, reason: string): Promise<boolean> {
    return this.ledgerRepo.markRefundPending(paymentKey, reason);
  }

  markRefunded(paymentKey: string, transaction: string, reason: string): Promise<boolean> {
    return this.ledgerRepo.markRefunded(paymentKey, transaction, reason);
  }

  recordRefundAttempt(paymentKey: string, error: string, nextAttemptAt: number): Promise<boolean> {
    return this.ledgerRepo.recordRefundAttempt(paymentKey, error, nextAttemptAt);
  }

  insertUnclaimedLedger(entry: UnclaimedLedgerEntry): Promise<boolean> {
    return this.ledgerRepo.insertUnclaimed(entry);
  }

  listStaleClaimedIntents(olderThan: number, limit: number) {
    return this.ledgerRepo.listStaleClaimedIntents(olderThan, limit);
  }

  /* ---------------- session reads and writes ---------------- */

  listNonTerminal(): Promise<SessionRecord[]> {
    return this.sessions.listNonTerminal();
  }

  rearmDue(id: string, atMs: number, nowMs: number): Promise<boolean> {
    return this.sessions.rearmDue(id, atMs, nowMs);
  }

  countDue(nowMs: number): Promise<number> {
    return this.sessions.countDue(nowMs);
  }

  countLiveByState(): Promise<Partial<Record<SessionState, number>>> {
    return this.sessions.countLiveByState();
  }

  listDue(nowMs: number, limit: number): Promise<SessionRecord[]> {
    return this.sessions.listDue(nowMs, limit);
  }

  listTerminalWithPod(): Promise<SessionRecord[]> {
    return this.sessions.listTerminalWithPod();
  }

  listTerminalWithPvc(): Promise<SessionRecord[]> {
    return this.sessions.listTerminalWithPvc();
  }

  setProvisioning(id: string, podName: string): Promise<boolean> {
    return this.sessions.setProvisioning(id, podName);
  }

  setProvisioningPod(id: string, podName: string): Promise<boolean> {
    return this.sessions.setProvisioningPod(id, podName);
  }

  setRelayToken(id: string, tokenHash: string): Promise<void> {
    return this.sessions.setRelayToken(id, tokenHash);
  }

  setReady(
    id: string,
    readyAt: number,
    leaseExpiresAt: number,
    attestationJson: string,
    guestPublicKey: string,
  ): Promise<boolean> {
    return this.sessions.setReady(id, readyAt, leaseExpiresAt, attestationJson, guestPublicKey);
  }

  touchActivity(id: string): Promise<void> {
    return this.sessions.touchActivity(id);
  }

  markSuspending(id: string): Promise<boolean> {
    return this.sessions.markSuspending(id);
  }

  markSuspended(id: string, suspendedAt: number): Promise<boolean> {
    return this.sessions.markSuspended(id, suspendedAt);
  }

  markResuming(id: string, podName: string): Promise<boolean> {
    return this.sessions.markResuming(id, podName);
  }

  setWorkspacePvc(id: string, pvcName: string): Promise<void> {
    return this.sessions.setWorkspacePvc(id, pvcName);
  }

  clearWorkspacePvc(id: string): Promise<void> {
    return this.sessions.clearWorkspacePvc(id);
  }

  setNodeName(id: string, nodeName: string): Promise<void> {
    return this.sessions.setNodeName(id, nodeName);
  }

  async requestTermination(
    id: string,
    reason: string,
    failure?: { code: string; message: string },
  ): Promise<boolean> {
    const changed = await this.sessions.requestTermination(id, reason, failure);
    // Same bounded label as before, so the metric is identical whichever
    // process emits it.
    if (changed && reason.startsWith("failure:")) {
      metrics
        .counter("sandbox_provision_failures_total", "Sessions failed during provisioning by reason")
        .inc({ reason: boundedFailureReason(reason.slice("failure:".length)) });
    }
    return changed;
  }

  finalizeTermination(id: string): Promise<SessionState | null> {
    return this.sessions.finalizeTermination(id);
  }

  requestDestroy(id: string): Promise<void> {
    return this.sessions.requestDestroy(id);
  }

  markRelayPurged(id: string): Promise<void> {
    return this.sessions.markRelayPurged(id);
  }

  clearPod(id: string): Promise<void> {
    return this.sessions.clearPod(id);
  }

  mergeTimings(id: string, patch: Record<string, number | undefined>): Promise<void> {
    return this.sessions.mergeTimings(id, patch);
  }

  /* ---------------- operations ---------------- */

  listFencedSessions(): Promise<SessionRecord[]> {
    return this.operations.listFencedSessions();
  }

  clearFencedGate(sessionId: string, requestId: string, epoch: number): Promise<boolean> {
    return this.operations.clearFencedGate(sessionId, requestId, epoch);
  }

  claimOperation(sessionId: string, requestId: string, op: string, payloadHash: string | null = null) {
    return this.operations.claimOperation(sessionId, requestId, op, payloadHash);
  }

  finishOperation(
    sessionId: string,
    requestId: string,
    outcome: "done" | "error" | "abandoned",
    resultEnvelope?: string | null,
  ): Promise<void> {
    return this.operations.finishOperation(sessionId, requestId, outcome, resultEnvelope);
  }

  getExecRequest(sessionId: string, requestId: string) {
    return this.operations.getExecRequest(sessionId, requestId);
  }
}
