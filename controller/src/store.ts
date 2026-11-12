/**
 * Single-writer persistence for entitlements, sessions and operations.
 *
 * SQLite (WAL) is deliberate for the local prototype: payment redemption and
 * session creation must be atomic, and the reconciler must survive restarts.
 * The multi-reader adapter ADR 0010 targets lives in `store/postgres/` and keeps
 * the same invariants (UNIQUE payment key, conditional transitions, UNIQUE
 * (session, request)); both are exercised by `tests/unit/store-contract/`.
 *
 * Every method the ports declare is `async` and returns the value the
 * synchronous statement produced. There is no `await` inside any of them: the
 * `async` is the port contract (ADR 0010), not an admission that this adapter
 * does I/O concurrently. `node:sqlite` blocks, which is why the guarantees here
 * still lean on one connection serialising `BEGIN IMMEDIATE` and the
 * `WHERE state = ...` guards; a network adapter has to earn them again.
 *
 * This class is the facade: connection setup, the writer guard, backup, stats
 * and health, plus a one-line delegation per port method. The rows live in one
 * repository per concern, mirroring `store/postgres/`: sessions in
 * `store/sessions.ts`, payments in `store/payments.ts`, operations in
 * `store/operations.ts`, and so on.
 *
 * Schema changes are additive and transactional; a database from a newer build
 * is refused rather than downgraded.
 */
import { statSync } from "node:fs";
import { backup as sqliteBackup, DatabaseSync, type StatementSync } from "node:sqlite";
import {
  type ClaimOperationResult,
  type ExecRequestRecord,
  type IntentClaimResult,
  type LedgerStatus,
  type PaymentIntentRecord,
  type PaymentLedgerRecord,
  type PaymentRecord,
  type SessionRecord,
  type SessionState,
} from "./store/models.js";
import { migrate } from "./store/schema.js";
import { boundedFailureReason } from "./store/failure-reasons.js";
import { checkStoreHealth, type StoreHealth } from "./store/health.js";
import { prepareStatements } from "./store/statements.js";
import { SessionRepository } from "./store/sessions.js";
import { PaymentRepository } from "./store/payments.js";
import { ChallengeNonceRepository, type ChallengeBurnResult } from "./store/challenges.js";
import { LedgerRepository, type UnclaimedLedgerEntry } from "./store/ledger.js";
import { OperationRepository } from "./store/operations.js";
import { BudgetRepository, type BudgetDecision, type BudgetLimits } from "./store/budgets.js";
import { metrics } from "@x402s/shared/runtime";

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
export {
  DuplicateEntitlementError,
  PaymentAlreadyRedeemedError,
  PaymentClaimLostError,
} from "./store/models.js";

const SCHEMA_LOCK = /database is locked|database table is locked|SQLITE_BUSY/i;

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
  /** Session reads and guarded transitions: the slice `store/postgres/sessions.ts` mirrors. */
  private readonly sessions: SessionRepository;
  readonly reservations: ReservationStore;
  readonly payments: PaymentRepository;
  readonly challenges: ChallengeNonceRepository;
  readonly ledger: LedgerRepository;
  /** Single-operation gate, restart recovery and exec requests. */
  private readonly operations: OperationRepository;
  readonly budgets: BudgetRepository;
  /** Path of the main database file (`:memory:` in tests). */
  readonly path: string;
  /**
   * True while this process is a standby for the single-writer role. Backed by
   * SQLite's own `query_only` switch rather than a flag checked per method, so
   * every path below, the payment repository and the reservation repository are
   * covered by one guard and a new statement cannot forget to check it.
   */
  private writesBlocked = false;
  private readonly budgetWindowMs: number;

  /**
   * `budgetWindowMs` is the fixed window for the durable create budget. It is a
   * storage concern because the spend commit happens inside the settlement
   * transaction; the default matches the controller's own default.
   */
  constructor(path: string, opts: { budgetWindowMs?: number } = {}) {
    this.path = path;
    this.budgetWindowMs = opts.budgetWindowMs ?? 3_600_000;
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
    this.sessions = new SessionRepository(this.db, this.stmts);
    this.budgets = new BudgetRepository(this.db, this.stmts);
    this.payments = new PaymentRepository(this.db, this.stmts, this.budgets, this.budgetWindowMs);
    this.challenges = new ChallengeNonceRepository(this.db, this.stmts);
    this.ledger = new LedgerRepository(this.stmts);
    this.operations = new OperationRepository(this.db, this.stmts, (id) => this.sessions.read(id));
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
  async healthCheck(): Promise<StoreHealth> {
    return checkStoreHealth(this.db, { writable: !this.writesBlocked });
  }

  /**
   * On-disk size of the database and its WAL sidecar. `:memory:` databases
   * report 0; the files may disappear between stat calls during a checkpoint,
   * so a missing file is 0 rather than an error.
   */
  async stats(): Promise<{ sizeBytes: number; walBytes: number }> {
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

  /**
   * Row counts across the whole database, not the session slice: the writer
   * guard asserts nothing was written on a standby, and the payment tests pin
   * "one payment, one session". They stay here with `stats` rather than in a
   * repository because each reads a different table.
   */
  countSessions(): number {
    return ((this.stmts.countSessions!.get() as { n: number } | undefined)?.n ?? 0);
  }

  countPayments(): number {
    return ((this.stmts.countPayments!.get() as { n: number } | undefined)?.n ?? 0);
  }

  /* ---------------- payment intents (outbox) ---------------- */

  /** Lease an intent; see PaymentRepository for the ownership contract. */
  async claimPaymentIntent(
    paymentKey: string,
    specHashValue: string,
    staleMs: number,
    requirementsJson: string | null = null,
  ): Promise<IntentClaimResult> {
    return this.payments.claimPaymentIntent(paymentKey, specHashValue, staleMs, requirementsJson);
  }

  async getPaymentIntent(paymentKey: string): Promise<PaymentIntentRecord | null> {
    return this.payments.getPaymentIntent(paymentKey);
  }

  async failPaymentIntent(paymentKey: string, reason: string): Promise<void> {
    this.payments.failPaymentIntent(paymentKey, reason);
  }

  /** Settle the intent and create the paid session (see PaymentRepository). */
  async completeEntitlement(
    paymentKey: string,
    claimToken: string,
    payment: PaymentRecord,
    session: SessionRecord,
  ): Promise<{ sessionId: string; created: boolean }> {
    return this.payments.completeEntitlement(paymentKey, claimToken, payment, session);
  }

  /* ---------------- challenge nonces (F-07) ---------------- */

  /** Mint a single-use nonce for one 402 challenge. */
  async issueChallengeNonce(
    nonce: string,
    ttlMs: number,
    maxActive: number,
  ): Promise<{ nonce: string; expiresAt: number }> {
    return this.challenges.issue(nonce, Date.now(), ttlMs, maxActive);
  }

  /** Burn a nonce for one payment; see ChallengeNonceRepository. */
  async burnChallengeNonce(nonce: string, paymentKey: string): Promise<ChallengeBurnResult> {
    return this.challenges.burn(nonce, paymentKey, Date.now());
  }

  /** Drop expired nonces. Called from housekeeping so the table stays bounded. */
  async pruneChallengeNonces(): Promise<number> {
    return this.challenges.prune(Date.now());
  }

  /* ---------------- durable budgets (#48) ---------------- */

  /**
   * Reserve one create against the global and (optionally) per-payer budget.
   * See BudgetRepository: all-or-nothing, one transaction, no spend until the
   * ledger row is written.
   */
  async reserveBudgets(
    payer: string | null,
    amountAtomic: string,
    limits: BudgetLimits,
  ): Promise<BudgetDecision> {
    return this.budgets.reserve(payer, amountAtomic, limits, Date.now());
  }

  /* ---------------- sessions ---------------- */

  async getSession(id: string): Promise<SessionRecord | null> {
    return this.sessions.read(id);
  }

  async getPayment(key: string): Promise<PaymentRecord | null> {
    return this.payments.getPaymentRecord(key);
  }

  /* ---------------- payment ledger (delegated) ---------------- */

  async getLedgerByPayment(paymentKey: string): Promise<PaymentLedgerRecord | null> {
    return this.ledger.getByPayment(paymentKey);
  }

  async getLedgerBySession(sessionId: string): Promise<PaymentLedgerRecord | null> {
    return this.ledger.getBySession(sessionId);
  }

  /** By EIP-3009 authorisation nonce, for a facilitator webhook or an operator. */
  async getLedgerByNonce(settlementNonce: string): Promise<PaymentLedgerRecord | null> {
    return this.ledger.getByNonce(settlementNonce);
  }

  async listLedgerByStatus(status: LedgerStatus): Promise<PaymentLedgerRecord[]> {
    return this.ledger.listByStatus(status);
  }

  async countLedgerByStatus(status: LedgerStatus): Promise<number> {
    return this.ledger.countByStatus(status);
  }

  async listUnrefundedTerminalBeforeReady(): Promise<PaymentLedgerRecord[]> {
    return this.ledger.listUnrefundedTerminalBeforeReady();
  }

  /** Settled rows with no session (unentitled or duplicate charges). */
  async listUnclaimedSettled(): Promise<PaymentLedgerRecord[]> {
    return this.ledger.listUnclaimedSettled();
  }

  /** REFUND_PENDING rows whose next attempt is due (#31). */
  async listRefundPendingDue(now: number, limit: number): Promise<PaymentLedgerRecord[]> {
    return this.ledger.listRefundPendingDue(now, limit);
  }

  async markRefundPending(paymentKey: string, reason: string): Promise<boolean> {
    return this.ledger.markRefundPending(paymentKey, reason);
  }

  async markRefunded(paymentKey: string, transaction: string, reason: string): Promise<boolean> {
    return this.ledger.markRefunded(paymentKey, transaction, reason);
  }

  /** Record one failed refund attempt and back off. */
  async recordRefundAttempt(paymentKey: string, error: string, nextAttemptAt: number): Promise<boolean> {
    return this.ledger.recordRefundAttempt(paymentKey, error, nextAttemptAt);
  }

  /** Write the ledger row for a settled payment that no session consumed (#31). */
  async insertUnclaimedLedger(entry: UnclaimedLedgerEntry): Promise<boolean> {
    return this.ledger.insertUnclaimed(entry);
  }

  /** Claimed intents past the recovery grace: the settle-then-crash window. */
  async listStaleClaimedIntents(olderThan: number, limit: number): Promise<PaymentIntentRecord[]> {
    return this.ledger.listStaleClaimedIntents(olderThan, limit);
  }

  /* ---------------- session reads and writes (delegated) ---------------- */

  async listNonTerminal(): Promise<SessionRecord[]> {
    return this.sessions.listNonTerminal();
  }

  /** Move a session's next reconcile pass. Cadence policy belongs to the caller. */
  bumpDue(id: string, atMs: number): boolean {
    return this.sessions.bumpDue(id, atMs);
  }

  async rearmDue(id: string, atMs: number, nowMs: number): Promise<boolean> {
    return this.sessions.rearmDue(id, atMs, nowMs);
  }

  async countDue(nowMs: number): Promise<number> {
    return this.sessions.countDue(nowMs);
  }

  async countLiveByState(): Promise<Partial<Record<SessionState, number>>> {
    return this.sessions.countLiveByState();
  }

  async listDue(nowMs: number, limit: number): Promise<SessionRecord[]> {
    return this.sessions.listDue(nowMs, limit);
  }

  async listTerminalWithPod(): Promise<SessionRecord[]> {
    return this.sessions.listTerminalWithPod();
  }

  async listTerminalWithPvc(): Promise<SessionRecord[]> {
    return this.sessions.listTerminalWithPvc();
  }

  async setProvisioning(id: string, podName: string): Promise<boolean> {
    return this.sessions.setProvisioning(id, podName);
  }

  /** Replace the pod of a session that is already PROVISIONING (relay restart). */
  async setProvisioningPod(id: string, podName: string): Promise<boolean> {
    return this.sessions.setProvisioningPod(id, podName);
  }

  async setRelayToken(id: string, tokenHash: string): Promise<void> {
    this.sessions.setRelayToken(id, tokenHash);
  }

  async setReady(
    id: string,
    readyAt: number,
    leaseExpiresAt: number,
    attestationJson: string,
    guestPublicKey: string,
  ): Promise<boolean> {
    return this.sessions.setReady(id, readyAt, leaseExpiresAt, attestationJson, guestPublicKey);
  }

  async touchActivity(id: string): Promise<void> {
    this.sessions.touchActivity(id);
  }

  async markSuspending(id: string): Promise<boolean> {
    return this.sessions.markSuspending(id);
  }

  async markSuspended(id: string, suspendedAt: number): Promise<boolean> {
    return this.sessions.markSuspended(id, suspendedAt);
  }

  async markResuming(id: string, podName: string): Promise<boolean> {
    return this.sessions.markResuming(id, podName);
  }

  async setWorkspacePvc(id: string, pvcName: string): Promise<void> {
    this.sessions.setWorkspacePvc(id, pvcName);
  }

  async setNodeName(id: string, nodeName: string): Promise<void> {
    this.sessions.setNodeName(id, nodeName);
  }

  async clearWorkspacePvc(id: string): Promise<void> {
    this.sessions.clearWorkspacePvc(id);
  }

  /**
   * PAID/PROVISIONING/READY/... -> TERMINATING, with the failure code written in
   * the same transaction as the state change (see SessionRepository).
   *
   * The failure metric stays on the facade, not in the repository: the Postgres
   * facade emits the same counter after its transaction, so the label and the
   * counter live in one place whichever backend is configured.
   */
  async requestTermination(
    id: string,
    reason: string,
    failure?: { code: string; message: string },
  ): Promise<boolean> {
    const changed = this.sessions.requestTermination(id, reason, failure);
    if (changed && reason.startsWith("failure:")) {
      metrics
        .counter("sandbox_provision_failures_total", "Sessions failed during provisioning by reason")
        .inc({ reason: boundedFailureReason(reason.slice("failure:".length)) });
    }
    return changed;
  }

  async finalizeTermination(id: string): Promise<SessionState | null> {
    return this.sessions.finalizeTermination(id);
  }

  async requestDestroy(id: string): Promise<void> {
    this.sessions.requestDestroy(id);
  }

  async markRelayPurged(id: string): Promise<void> {
    this.sessions.markRelayPurged(id);
  }

  async clearPod(id: string): Promise<void> {
    this.sessions.clearPod(id);
  }

  async mergeTimings(id: string, patch: Record<string, number | undefined>): Promise<void> {
    this.sessions.mergeTimings(id, patch);
  }

  /* ---------------- operations ---------------- */

  /** Startup recovery; see `OperationRepository.recoverInterruptedOperations`. */
  async recoverInterruptedOperations(): Promise<{ requests: number; sessions: number }> {
    return this.operations.recoverInterruptedOperations();
  }

  async listFencedSessions(): Promise<SessionRecord[]> {
    return this.operations.listFencedSessions();
  }

  async clearFencedGate(sessionId: string, requestId: string, epoch: number): Promise<boolean> {
    return this.operations.clearFencedGate(sessionId, requestId, epoch);
  }

  async claimOperation(
    sessionId: string,
    requestId: string,
    op: string,
    payloadHash: string | null = null,
  ): Promise<ClaimOperationResult> {
    return this.operations.claimOperation(sessionId, requestId, op, payloadHash);
  }

  async finishOperation(
    sessionId: string,
    requestId: string,
    outcome: "done" | "error" | "abandoned",
  ): Promise<void> {
    this.operations.finishOperation(sessionId, requestId, outcome);
  }

  async getExecRequest(sessionId: string, requestId: string): Promise<ExecRequestRecord | null> {
    return this.operations.getExecRequest(sessionId, requestId);
  }
}
