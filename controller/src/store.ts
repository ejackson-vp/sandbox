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
import { randomBytes } from "node:crypto";
import { DatabaseSync, backup as sqliteBackup, type StatementSync } from "node:sqlite";
import {
  mapIntent,
  mapLedger,
  mapSession,
  PaymentAlreadyRedeemedError,
  PaymentClaimLostError,
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
import { prepareStatements } from "./store/statements.js";
import { finalStateForReason, SOURCE_STATES } from "@x402s/shared";

import { ReservationRepository } from "./capacity/reservations.js";
import type { ReservationStore } from "./capacity/reservation-store.js";

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

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class Store {
  private readonly db: DatabaseSync;
  private readonly stmts: Record<string, StatementSync>;
  readonly reservations: ReservationStore;

  constructor(path: string) {
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
        sleepSync(100 * (attempt + 1));
      }
    }
    this.reservations = new ReservationRepository(this.db);

    this.stmts = prepareStatements(this.db);
  }

  close(): void {
    this.db.close();
  }

  /** Consistent online copy for the backup service. */
  async backupTo(path: string): Promise<void> {
    await sqliteBackup(this.db, path);
  }

  /* ---------------- payment intents (outbox) ---------------- */

  /**
   * Lease an intent to this caller. The returned token is the ownership fence:
   * only the holder of the current token may complete. A claim older than its
   * recorded lease, or older than the caller's `staleMs`, is a crash path and
   * can be reclaimed; the previous owner then loses the token.
   */
  claimPaymentIntent(paymentKey: string, specHashValue: string, staleMs: number): IntentClaimResult {
    const now = Date.now();
    const token = randomBytes(16).toString("hex");
    const expiresAt = now + staleMs;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const raw = this.stmts.getIntent!.get(paymentKey) as Record<string, unknown> | undefined;
      if (raw) {
        const intent = mapIntent(raw);
        if (intent.specHash !== specHashValue) {
          this.db.exec("COMMIT");
          return { status: "mismatch" };
        }
        if (intent.status === "settled" && intent.sessionId) {
          this.db.exec("COMMIT");
          return { status: "settled", sessionId: intent.sessionId };
        }
        if (intent.status === "failed") {
          this.db.exec("COMMIT");
          return { status: "failed", reason: intent.reason };
        }
        // claimed: either in flight or stale after a crash. The recorded lease
        // is authoritative; the age check keeps the original `staleMs` recovery
        // path (and pre-v10 rows, which have no lease) working.
        const leaseExpired = intent.claimExpiresAt !== null && now >= intent.claimExpiresAt;
        const agedOut = now - intent.updatedAt >= staleMs;
        if (!leaseExpired && !agedOut) {
          this.db.exec("COMMIT");
          return { status: "in_progress" };
        }
        const reclaimed = this.stmts.reclaimIntent!.run(token, expiresAt, now, paymentKey);
        this.db.exec("COMMIT");
        if (reclaimed.changes === 0) return { status: "in_progress" };
        return { status: "claimed", recovered: true, token, expiresAt };
      }
      this.stmts.insertIntent!.run(paymentKey, specHashValue, token, expiresAt, now, now);
      this.db.exec("COMMIT");
      return { status: "claimed", recovered: false, token, expiresAt };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getPaymentIntent(paymentKey: string): PaymentIntentRecord | null {
    const raw = this.stmts.getIntent!.get(paymentKey) as Record<string, unknown> | undefined;
    return raw ? mapIntent(raw) : null;
  }

  failPaymentIntent(paymentKey: string, reason: string): void {
    this.stmts.failIntent!.run(reason.slice(0, 500), Date.now(), paymentKey);
  }

  /**
   * Atomically: record the payment, create the session, and mark the intent
   * settled. The caller must present the claim token it was given by
   * `claimPaymentIntent`; a stale owner is rejected.
   *
   * Idempotent: if another worker already settled the intent, this returns that
   * session with `created: false` instead of throwing. A crash before this
   * leaves the intent `claimed`, which the API resolves by asking the
   * facilitator whether settlement happened.
   */
  completeEntitlement(
    paymentKey: string,
    claimToken: string,
    payment: PaymentRecord,
    session: SessionRecord,
  ): { sessionId: string; created: boolean } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const raw = this.stmts.getIntent!.get(paymentKey) as Record<string, unknown> | undefined;
      if (!raw) throw new PaymentClaimLostError(paymentKey);
      const intent = mapIntent(raw);
      // Already settled: the winner's session is the answer, not an error.
      if (intent.status === "settled" && intent.sessionId) {
        this.db.exec("COMMIT");
        return { sessionId: intent.sessionId, created: false };
      }
      if (intent.status !== "claimed" || intent.claimToken !== claimToken) {
        throw new PaymentClaimLostError(paymentKey);
      }

      this.stmts.insertPayment!.run(
        payment.paymentKey,
        payment.network,
        payment.scheme,
        payment.asset,
        payment.amount,
        payment.payTo,
        payment.payer ?? null,
        payment.transaction ?? null,
        payment.mode,
        Date.now(),
      );
      this.stmts.insertLedger!.run(
        payment.paymentKey,
        session.id,
        payment.payer ?? null,
        payment.amount,
        payment.asset,
        payment.network,
        payment.mode,
        Date.now(),
        Date.now(),
      );
      this.stmts.insertSession!.run(
        session.id,
        session.capabilityHash,
        session.capabilityExpiresAt,
        session.clientPublicKey,
        session.clientNonce,
        session.clientSigner ?? null,
        session.tier,
        session.durationSeconds,
        session.limits.cpuMillis,
        session.limits.memoryMiB,
        session.limits.diskMiB,
        session.limits.maxOutputBytes,
        session.limits.maxFileBytes,
        session.limits.maxCommandSeconds,
        session.limits.maxProcesses,
        session.state,
        session.createdAt,
        session.paidAt,
        session.paymentKey,
        session.runtimeClass,
        session.executionMode,
        session.relayTokenHash,
        session.updatedAt,
      );
      this.stmts.initLifecycle!.run(
        session.idlePolicyJson ?? null,
        session.maxLifetimeSeconds ?? null,
        session.lastActivityAt ?? session.createdAt,
        session.workspacePvc ?? null,
        session.suspendedAt ?? null,
        session.resumeCount ?? 0,
        session.baselineCpuMillis ?? null,
        session.baselineMemoryMib ?? null,
        session.updatedAt,
        session.id,
      );
      // Conditional on the token: a concurrent reclaim inside this transaction
      // has already changed it, so the stale owner cannot settle.
      const settled = this.stmts.settleIntent!.run(session.id, Date.now(), paymentKey, claimToken);
      if (settled.changes === 0) throw new PaymentClaimLostError(paymentKey);
      this.db.exec("COMMIT");
      return { sessionId: session.id, created: true };
    } catch (err) {
      this.db.exec("ROLLBACK");
      const msg = (err as Error).message;
      if (msg.includes("UNIQUE") || msg.includes("PRIMARY KEY")) {
        throw new PaymentAlreadyRedeemedError(paymentKey);
      }
      throw err;
    }
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
    return this.stmts.setProvisioning!.run(podName, Date.now(), id).changes > 0;
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
    return (
      this.stmts.setReady!.run(
        readyAt,
        leaseExpiresAt,
        attestationJson,
        guestPublicKey,
        readyAt,
        Date.now(),
        id,
      ).changes > 0
    );
  }

  touchActivity(id: string): void {
    const now = Date.now();
    this.stmts.touchActivity!.run(now, now, id);
  }

  markSuspending(id: string): boolean {
    return this.stmts.markSuspending!.run(Date.now(), id).changes > 0;
  }

  markSuspended(id: string, suspendedAt: number): boolean {
    return this.stmts.markSuspended!.run(suspendedAt, suspendedAt, id).changes > 0;
  }

  markResuming(id: string, podName: string): boolean {
    return this.stmts.markResuming!.run(podName, Date.now(), id).changes > 0;
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
    const changed = this.stmts.requestTermination!.run(now, reason, now, id).changes > 0;
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
    this.stmts.finalize!.run(final, Date.now(), Date.now(), id);
    return final;
  }

  requestDestroy(id: string): void {
    this.stmts.requestDestroy!.run(Date.now(), id);
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
   * guest no longer has that request active (see OperationFence). A frame
   * forwarded by the previous generation carries the old epoch and is rejected
   * by the guest, so it cannot run after recovery.
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
    return this.stmts.clearFencedGate!.run(Date.now(), sessionId, requestId, epoch).changes > 0;
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
      this.db
        .prepare("UPDATE sessions SET active_request_id = ?, state = CASE WHEN state='READY' THEN 'ACTIVE' ELSE state END, updated_at = ? WHERE id = ?")
        .run(requestId, now, sessionId);
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
      this.stmts.finishRequest!.run(outcome, now, sessionId, requestId);
      this.stmts.clearActive!.run(now, sessionId, requestId);
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
