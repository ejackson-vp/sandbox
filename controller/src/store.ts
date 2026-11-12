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
 * Schema changes are additive and transactional; a database from a newer build
 * is refused rather than downgraded.
 */
import { statSync } from "node:fs";
import { backup as sqliteBackup, DatabaseSync, type StatementSync } from "node:sqlite";
import {
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
import { boundedFailureReason } from "./store/failure-reasons.js";
import { checkStoreHealth, type StoreHealth } from "./store/health.js";
import { prepareStatements } from "./store/statements.js";
import { PaymentRepository } from "./store/payments.js";
import { ChallengeNonceRepository, type ChallengeBurnResult } from "./store/challenges.js";
import { LedgerRepository, type UnclaimedLedgerEntry } from "./store/ledger.js";
import { OperationRepository } from "./store/operations.js";
import { BudgetRepository, type BudgetDecision, type BudgetLimits } from "./store/budgets.js";
import { cadenceFor } from "./reconcile-cadence.js";
import { finalStateForReason } from "@x402s/shared/protocol";
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
    this.budgets = new BudgetRepository(this.db, this.stmts);
    this.payments = new PaymentRepository(this.db, this.stmts, this.budgets, this.budgetWindowMs);
    this.challenges = new ChallengeNonceRepository(this.db, this.stmts);
    this.ledger = new LedgerRepository(this.stmts);
    this.operations = new OperationRepository(this.db, this.stmts, (id) => this.readSession(id));
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

  /**
   * The synchronous read the async port method and the adapter's own
   * transactions share.
   *
   * Nothing outside this class uses it. The two internal callers
   * (`claimOperation`, `finalizeTermination`) read and then write, and on
   * SQLite that pair must not be interrupted: `claimOperation` holds
   * `BEGIN IMMEDIATE` open, so an `await` in the middle would let another
   * request on this connection try to start a second transaction. A Postgres
   * adapter replaces both pairs with one guarded statement; until then the read
   * stays inside the adapter, never in a caller.
   */
  private readSession(id: string): SessionRecord | null {
    const row = this.stmts.getSession!.get(id) as RawSession | undefined;
    return row ? mapSession(row) : null;
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    return this.readSession(id);
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

  async listNonTerminal(): Promise<SessionRecord[]> {
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
  async rearmDue(id: string, atMs: number, nowMs: number): Promise<boolean> {
    return this.stmts.rearmDue!.run(atMs, id, nowMs).changes > 0;
  }

  /** Live sessions whose next pass is due right now. */
  async countDue(nowMs: number): Promise<number> {
    return ((this.stmts.countDue!.get(nowMs) as { n: number } | undefined)?.n ?? 0);
  }

  /** Live session counts by state, without materialising rows. */
  async countLiveByState(): Promise<Partial<Record<SessionState, number>>> {
    const counts: Partial<Record<SessionState, number>> = {};
    for (const row of this.stmts.countLiveByState!.all() as Array<{ state: string; n: number }>) {
      counts[row.state as SessionState] = row.n;
    }
    return counts;
  }

  /** Live sessions whose next pass is due, earliest first, bounded by `limit`. */
  async listDue(nowMs: number, limit: number): Promise<SessionRecord[]> {
    return (this.stmts.listDue!.all(nowMs, limit) as unknown as RawSession[]).map(mapSession);
  }

  async listTerminalWithPod(): Promise<SessionRecord[]> {
    return (this.stmts.listTerminalWithPod!.all() as unknown as RawSession[]).map(mapSession);
  }

  countSessions(): number {
    return ((this.stmts.countSessions!.get() as { n: number } | undefined)?.n ?? 0);
  }

  countPayments(): number {
    return ((this.stmts.countPayments!.get() as { n: number } | undefined)?.n ?? 0);
  }

  async setProvisioning(id: string, podName: string): Promise<boolean> {
    const now = Date.now();
    return this.stmts.setProvisioning!.run(podName, now + cadenceFor("PROVISIONING"), now, id).changes > 0;
  }

  /** Replace the pod of a session that is already PROVISIONING (relay restart). */
  async setProvisioningPod(id: string, podName: string): Promise<boolean> {
    return this.stmts.setProvisioningPod!.run(podName, Date.now(), id).changes > 0;
  }

  async setRelayToken(id: string, tokenHash: string): Promise<void> {
    this.stmts.setRelayToken!.run(tokenHash, Date.now(), id);
  }

  async setReady(
    id: string,
    readyAt: number,
    leaseExpiresAt: number,
    attestationJson: string,
    guestPublicKey: string,
  ): Promise<boolean> {
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

  async touchActivity(id: string): Promise<void> {
    const now = Date.now();
    this.stmts.touchActivity!.run(now, now, id);
  }

  async markSuspending(id: string): Promise<boolean> {
    const now = Date.now();
    return this.stmts.markSuspending!.run(now + cadenceFor("SUSPENDING"), now, id).changes > 0;
  }

  async markSuspended(id: string, suspendedAt: number): Promise<boolean> {
    return (
      this.stmts.markSuspended!.run(
        suspendedAt,
        suspendedAt + cadenceFor("SUSPENDED"),
        suspendedAt,
        id,
      ).changes > 0
    );
  }

  async markResuming(id: string, podName: string): Promise<boolean> {
    const now = Date.now();
    return this.stmts.markResuming!.run(podName, now + cadenceFor("RESUMING"), now, id).changes > 0;
  }

  async setWorkspacePvc(id: string, pvcName: string): Promise<void> {
    this.stmts.setWorkspacePvc!.run(pvcName, Date.now(), id);
  }

  async setNodeName(id: string, nodeName: string): Promise<void> {
    this.stmts.setNodeName!.run(nodeName, Date.now(), id);
  }

  async clearWorkspacePvc(id: string): Promise<void> {
    this.stmts.clearWorkspacePvc!.run(Date.now(), id);
  }

  async listTerminalWithPvc(): Promise<SessionRecord[]> {
    return (this.stmts.listTerminalWithPvc!.all() as unknown as RawSession[]).map(mapSession);
  }

  async requestTermination(
    id: string,
    reason: string,
    failure?: { code: string; message: string },
  ): Promise<boolean> {
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
  async finalizeTermination(id: string): Promise<SessionState | null> {
    const session = this.readSession(id);
    if (!session || session.state !== "TERMINATING") return null;
    const reason = session.terminationReason ?? "";
    const final = finalStateForReason(reason);
    const now = Date.now();
    this.stmts.finalize!.run(final, now, now + cadenceFor(final), now, id);
    return final;
  }

  async requestDestroy(id: string): Promise<void> {
    // Due now: a destroy is an event, not a state that can wait out its cadence.
    const now = Date.now();
    this.stmts.requestDestroy!.run(now, now, id);
  }

  async markRelayPurged(id: string): Promise<void> {
    this.stmts.markRelayPurged!.run(Date.now(), Date.now(), id);
  }

  async clearPod(id: string): Promise<void> {
    this.stmts.clearPod!.run(Date.now(), id);
  }

  /** Atomically merge lifecycle timings (JSON patch semantics). */
  async mergeTimings(id: string, patch: Record<string, number | undefined>): Promise<void> {
    const clean: Record<string, number> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
    }
    if (Object.keys(clean).length === 0) return;
    this.stmts.mergeTimings!.run(JSON.stringify(clean), Date.now(), id);
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
