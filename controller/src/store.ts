/**
 * Single-writer persistence for entitlements, sessions and operations.
 *
 * SQLite (WAL) is deliberate for the prototype: payment redemption and session
 * creation must be atomic, and the reconciler must survive restarts. In
 * production this becomes Postgres/DynamoDB with the same invariants
 * (UNIQUE payment key, conditional transitions, UNIQUE (session, request)).
 *
 * Schema changes are destructive in this prototype: bump SCHEMA_VERSION and the
 * database is recreated (session state is disposable by design).
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  SESSION_COLUMNS,
  mapIntent,
  mapLedger,
  mapSession,
  PaymentAlreadyRedeemedError,
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
import { finalStateForReason, SOURCE_STATES } from "@x402s/shared";

/** SQL `IN (...)` list derived from the domain transition table. */
const statesIn = (event: keyof typeof SOURCE_STATES): string =>
  SOURCE_STATES[event].map((state) => `'${state}'`).join(",");
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
export { PaymentAlreadyRedeemedError } from "./store/models.js";

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

    this.stmts = {
      insertPayment: this.db.prepare(
        `INSERT INTO payments (payment_key, network, scheme, asset, amount, pay_to, payer, tx, mode, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertSession: this.db.prepare(
        `INSERT INTO sessions (
           id, capability_hash, capability_expires_at, client_public_key, client_nonce,
           tier, duration_seconds, cpu_millis, memory_mib, disk_mib, max_output_bytes,
           max_file_bytes, max_command_seconds, max_processes,
           state, created_at, paid_at, payment_key, runtime_class, execution_mode,
           relay_token_hash, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      getSession: this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`),
      getPayment: this.db.prepare("SELECT * FROM payments WHERE payment_key = ?"),
      getIntent: this.db.prepare("SELECT * FROM payment_intents WHERE payment_key = ?"),
      insertLedger: this.db.prepare(
        `INSERT INTO payment_ledger
           (payment_key, session_id, payer, amount, asset, network, mode, status, reason, refund_tx, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'SETTLED', NULL, NULL, ?, ?)`,
      ),
      getLedgerByPayment: this.db.prepare("SELECT * FROM payment_ledger WHERE payment_key = ?"),
      getLedgerBySession: this.db.prepare("SELECT * FROM payment_ledger WHERE session_id = ?"),
      listLedgerByStatus: this.db.prepare(
        "SELECT * FROM payment_ledger WHERE status = ? ORDER BY updated_at ASC",
      ),
      listUnrefundedTerminalBeforeReady: this.db.prepare(
        `SELECT l.* FROM payment_ledger l JOIN sessions s ON s.id = l.session_id
         WHERE l.status = 'SETTLED' AND s.ready_at IS NULL
           AND s.state IN ('FAILED','EXPIRED','DESTROYED')
         ORDER BY l.updated_at ASC LIMIT 100`,
      ),
      markRefundPending: this.db.prepare(
        `UPDATE payment_ledger SET status='REFUND_PENDING', reason=?, updated_at=?
         WHERE payment_key=? AND status='SETTLED'`,
      ),
      markRefunded: this.db.prepare(
        `UPDATE payment_ledger SET status='REFUNDED', reason=?, refund_tx=?, updated_at=?
         WHERE payment_key=? AND status IN ('SETTLED','REFUND_PENDING')`,
      ),
      insertIntent: this.db.prepare(
        `INSERT INTO payment_intents (payment_key, status, session_id, spec_hash, reason, created_at, updated_at)
         VALUES (?, 'claimed', NULL, ?, NULL, ?, ?)`,
      ),
      reclaimIntent: this.db.prepare(
        "UPDATE payment_intents SET status='claimed', reason=NULL, updated_at=? WHERE payment_key=?",
      ),
      settleIntent: this.db.prepare(
        "UPDATE payment_intents SET status='settled', session_id=?, updated_at=? WHERE payment_key=?",
      ),
      failIntent: this.db.prepare(
        "UPDATE payment_intents SET status='failed', reason=?, updated_at=? WHERE payment_key=?",
      ),
      listNonTerminal: this.db.prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE state IN ('PAID','PROVISIONING','READY','ACTIVE','SUSPENDING','SUSPENDED','RESUMING','TERMINATING')`,
      ),
      listTerminalWithPod: this.db.prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE state IN ('EXPIRED','FAILED','DESTROYED') AND pod_name IS NOT NULL`,
      ),
      listTerminalWithPvc: this.db.prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE state IN ('EXPIRED','FAILED','DESTROYED') AND workspace_pvc IS NOT NULL`,
      ),
      initLifecycle: this.db.prepare(
        `UPDATE sessions SET idle_policy_json=?, max_lifetime_seconds=?, last_activity_at=?,
           workspace_pvc=?, suspended_at=?, resume_count=?, baseline_cpu_millis=?,
           baseline_memory_mib=?, updated_at=? WHERE id=?`,
      ),
      touchActivity: this.db.prepare(
        "UPDATE sessions SET last_activity_at=?, updated_at=? WHERE id=? AND state IN ('READY','ACTIVE')",
      ),
      markSuspending: this.db.prepare(
        `UPDATE sessions SET state='SUSPENDING', updated_at=? WHERE id=? AND state IN (${statesIn("suspend_requested")})`,
      ),
      markSuspended: this.db.prepare(
        `UPDATE sessions SET state='SUSPENDED', suspended_at=?, lease_expires_at=NULL,
           pod_name=NULL, updated_at=? WHERE id=? AND state IN (${statesIn("guest_stopped")})`,
      ),
      markResuming: this.db.prepare(
        `UPDATE sessions SET state='RESUMING', pod_name=?, suspended_at=NULL,
           resume_count=resume_count+1, lease_expires_at=NULL, updated_at=?
         WHERE id=? AND state IN (${statesIn("resume_requested")})`,
      ),
      setWorkspacePvc: this.db.prepare("UPDATE sessions SET workspace_pvc=?, updated_at=? WHERE id=?"),
      setNodeName: this.db.prepare("UPDATE sessions SET node_name=?, updated_at=? WHERE id=?"),
      clearWorkspacePvc: this.db.prepare("UPDATE sessions SET workspace_pvc=NULL, updated_at=? WHERE id=?"),
      setProvisioning: this.db.prepare(
        `UPDATE sessions SET pod_name = ?, state = 'PROVISIONING', updated_at = ? WHERE id = ? AND state IN (${statesIn("provision_requested")})`,
      ),
      setRelayToken: this.db.prepare("UPDATE sessions SET relay_token_hash = ?, updated_at = ? WHERE id = ?"),
      setReady: this.db.prepare(
        `UPDATE sessions SET state='READY', ready_at=?, lease_expires_at=?, attestation_json=?,
           guest_public_key=?, last_activity_at=?, updated_at=?
         WHERE id=? AND state IN (${statesIn("guest_ready")})
           AND pod_name IS NOT NULL AND relay_token_hash IS NOT NULL`,
      ),
      requestTermination: this.db.prepare(
        `UPDATE sessions SET state='TERMINATING', terminating_at=?, termination_reason=?, updated_at=?
         WHERE id=? AND state IN (${statesIn("terminate_requested")})`,
      ),
      setFailure: this.db.prepare(
        "UPDATE sessions SET failure_code = ?, failure_message = ?, updated_at = ? WHERE id = ?",
      ),
      finalize: this.db.prepare(
        `UPDATE sessions SET state=?, destroyed_at=?, active_request_id=NULL, updated_at=?
         WHERE id=? AND state IN (${statesIn("terminated")})`,
      ),
      requestDestroy: this.db.prepare(
        "UPDATE sessions SET destroy_requested = 1, updated_at = ? WHERE id = ? AND state NOT IN ('EXPIRED','FAILED','DESTROYED')",
      ),
      markRelayPurged: this.db.prepare("UPDATE sessions SET relay_purged_at = ?, updated_at = ? WHERE id = ?"),
      clearPod: this.db.prepare("UPDATE sessions SET pod_name = NULL, updated_at = ? WHERE id = ?"),
      mergeTimings: this.db.prepare(
        "UPDATE sessions SET timings_json = json_patch(COALESCE(timings_json, '{}'), ?), updated_at = ? WHERE id = ?",
      ),
      clearActive: this.db.prepare(
        "UPDATE sessions SET active_request_id = NULL, state = CASE WHEN state='ACTIVE' THEN 'READY' ELSE state END, updated_at = ? WHERE id = ? AND active_request_id = ?",
      ),
      abandonPendingRequests: this.db.prepare(
        "UPDATE exec_requests SET state = 'abandoned', updated_at = ? WHERE state = 'pending'",
      ),
      clearAllActiveRequests: this.db.prepare(
        `UPDATE sessions SET active_request_id = NULL, updated_at = ?
         WHERE active_request_id IS NOT NULL AND state NOT IN ('EXPIRED','FAILED','DESTROYED')`,
      ),
      countSessions: this.db.prepare("SELECT COUNT(*) AS n FROM sessions"),
      countPayments: this.db.prepare("SELECT COUNT(*) AS n FROM payments"),
      insertRequest: this.db.prepare(
        "INSERT INTO exec_requests (id, session_id, op, state, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)",
      ),
      getRequest: this.db.prepare("SELECT * FROM exec_requests WHERE session_id = ? AND id = ?"),
      finishRequest: this.db.prepare(
        "UPDATE exec_requests SET state = ?, updated_at = ? WHERE session_id = ? AND id = ?",
      ),
      listPendingRequests: this.db.prepare(
        "SELECT * FROM exec_requests WHERE session_id = ? AND state = 'pending'",
      ),
    };
  }

  close(): void {
    this.db.close();
  }

  /* ---------------- payment intents (outbox) ---------------- */

  claimPaymentIntent(paymentKey: string, specHashValue: string, staleMs: number): IntentClaimResult {
    const now = Date.now();
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
        // claimed: either in flight or stale after a crash
        if (now - intent.updatedAt < staleMs) {
          this.db.exec("COMMIT");
          return { status: "in_progress" };
        }
        this.stmts.reclaimIntent!.run(now, paymentKey);
        this.db.exec("COMMIT");
        return { status: "claimed", recovered: true };
      }
      this.stmts.insertIntent!.run(paymentKey, specHashValue, now, now);
      this.db.exec("COMMIT");
      return { status: "claimed", recovered: false };
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
   * settled. A crash before this leaves the intent `claimed`, which the API
   * resolves by asking the facilitator whether settlement happened.
   */
  completeEntitlement(paymentKey: string, payment: PaymentRecord, session: SessionRecord): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
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
      this.stmts.settleIntent!.run(session.id, Date.now(), paymentKey);
      this.db.exec("COMMIT");
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
   * operation in flight. Its outcome is unknown, so mark the request
   * abandoned and clear the single-operation gate. A later lookup still
   * returns the cached relay envelope if one exists, otherwise result_expired.
   */
  recoverInterruptedOperations(): { requests: number; sessions: number } {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const requests = this.stmts.abandonPendingRequests!.run(now).changes;
      const sessions = this.stmts.clearAllActiveRequests!.run(now).changes;
      this.db.exec("COMMIT");
      return { requests: Number(requests), sessions: Number(sessions) };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Atomically claim the single operation slot for a session.
   * Request id doubles as the idempotency key.
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
      this.stmts.insertRequest!.run(requestId, sessionId, op, now, now);
      this.db
        .prepare("UPDATE sessions SET active_request_id = ?, state = CASE WHEN state='READY' THEN 'ACTIVE' ELSE state END, updated_at = ? WHERE id = ?")
        .run(requestId, now, sessionId);
      this.db.exec("COMMIT");
      return { ok: true, requestId };
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
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  listPendingRequests(sessionId: string): ExecRequestRecord[] {
    return (this.stmts.listPendingRequests!.all(sessionId) as unknown as Array<Record<string, unknown>>).map((row) => ({
      id: row.id as string,
      sessionId: row.session_id as string,
      op: row.op as string,
      state: row.state as ExecRequestRecord["state"],
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }));
  }
}
