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
import type { SessionLimits, SessionState, SessionTier } from "@x402s/shared";

export type { SessionState };

const SCHEMA_VERSION = 5;

export interface PaymentRecord {
  paymentKey: string;
  network: string;
  scheme: string;
  asset: string;
  amount: string;
  payTo: string;
  payer?: string;
  transaction?: string;
  mode: "mock" | "testnet";
}

export interface SessionRecord {
  id: string;
  capabilityHash: string;
  capabilityExpiresAt: number;
  clientPublicKey: string;
  clientNonce: string;
  tier: SessionTier;
  durationSeconds: number;
  limits: SessionLimits;
  state: SessionState;
  createdAt: number;
  paidAt: number | null;
  readyAt: number | null;
  leaseExpiresAt: number | null;
  terminatingAt: number | null;
  destroyedAt: number | null;
  terminationReason: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  attestationJson: string | null;
  guestPublicKey: string | null;
  paymentKey: string;
  podName: string | null;
  runtimeClass: string | null;
  executionMode: string | null;
  relayTokenHash: string | null;
  activeRequestId: string | null;
  relayPurgedAt: number | null;
  destroyRequested: number;
  timingsJson: string | null;
  idlePolicyJson: string | null;
  maxLifetimeSeconds: number | null;
  suspendedAt: number | null;
  resumeCount: number;
  lastActivityAt: number | null;
  workspacePvc: string | null;
  baselineCpuMillis: number | null;
  baselineMemoryMib: number | null;
  updatedAt: number;
}

export interface ExecRequestRecord {
  id: string;
  sessionId: string;
  op: string;
  state: "pending" | "done" | "error" | "abandoned";
  createdAt: number;
  updatedAt: number;
}

export type IntentStatus = "claimed" | "settled" | "failed";

export interface PaymentIntentRecord {
  paymentKey: string;
  status: IntentStatus;
  sessionId: string | null;
  specHash: string;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
}

export class PaymentAlreadyRedeemedError extends Error {
  constructor(paymentKey: string) {
    super(`payment ${paymentKey.slice(0, 12)}… has already been redeemed`);
    this.name = "PaymentAlreadyRedeemedError";
  }
}

export type ClaimOperationResult =
  | { ok: true; requestId: string }
  | { ok: false; code: "busy" | "not_usable" | "lease_expired" | "duplicate"; state: SessionState; requestId?: string };

export type IntentClaimResult =
  | { status: "claimed"; recovered: boolean }
  | { status: "settled"; sessionId: string }
  | { status: "in_progress" }
  | { status: "failed"; reason: string | null }
  | { status: "mismatch" };

const SESSION_COLUMNS = `
  id, capability_hash, capability_expires_at, client_public_key, client_nonce,
  tier, duration_seconds, cpu_millis, memory_mib, disk_mib, max_output_bytes,
  max_file_bytes, max_command_seconds, max_processes,
  state, created_at, paid_at, ready_at, lease_expires_at, terminating_at,
  destroyed_at, termination_reason, failure_code, failure_message,
  attestation_json, guest_public_key, payment_key, pod_name, runtime_class,
  execution_mode, relay_token_hash, active_request_id, relay_purged_at,
  destroy_requested, timings_json, idle_policy_json, max_lifetime_seconds,
  suspended_at, resume_count, last_activity_at, workspace_pvc,
  baseline_cpu_millis, baseline_memory_mib, updated_at
`;

interface RawSession {
  id: string;
  capability_hash: string;
  capability_expires_at: number;
  client_public_key: string;
  client_nonce: string;
  tier: string;
  duration_seconds: number;
  cpu_millis: number;
  memory_mib: number;
  disk_mib: number;
  max_output_bytes: number;
  max_file_bytes: number;
  max_command_seconds: number;
  max_processes: number;
  state: string;
  created_at: number;
  paid_at: number | null;
  ready_at: number | null;
  lease_expires_at: number | null;
  terminating_at: number | null;
  destroyed_at: number | null;
  termination_reason: string | null;
  failure_code: string | null;
  failure_message: string | null;
  attestation_json: string | null;
  guest_public_key: string | null;
  payment_key: string;
  pod_name: string | null;
  runtime_class: string | null;
  execution_mode: string | null;
  relay_token_hash: string | null;
  active_request_id: string | null;
  relay_purged_at: number | null;
  destroy_requested: number;
  timings_json: string | null;
  idle_policy_json: string | null;
  max_lifetime_seconds: number | null;
  suspended_at: number | null;
  resume_count: number;
  last_activity_at: number | null;
  workspace_pvc: string | null;
  baseline_cpu_millis: number | null;
  baseline_memory_mib: number | null;
  updated_at: number;
}

function mapSession(r: RawSession): SessionRecord {
  return {
    id: r.id,
    capabilityHash: r.capability_hash,
    capabilityExpiresAt: r.capability_expires_at,
    clientPublicKey: r.client_public_key,
    clientNonce: r.client_nonce,
    tier: r.tier as SessionTier,
    durationSeconds: r.duration_seconds,
    limits: {
      cpuMillis: r.cpu_millis,
      memoryMiB: r.memory_mib,
      diskMiB: r.disk_mib,
      maxOutputBytes: r.max_output_bytes,
      maxFileBytes: r.max_file_bytes,
      maxCommandSeconds: r.max_command_seconds,
      maxProcesses: r.max_processes,
    },
    state: r.state as SessionState,
    createdAt: r.created_at,
    paidAt: r.paid_at,
    readyAt: r.ready_at,
    leaseExpiresAt: r.lease_expires_at,
    terminatingAt: r.terminating_at,
    destroyedAt: r.destroyed_at,
    terminationReason: r.termination_reason,
    failureCode: r.failure_code,
    failureMessage: r.failure_message,
    attestationJson: r.attestation_json,
    guestPublicKey: r.guest_public_key,
    paymentKey: r.payment_key,
    podName: r.pod_name,
    runtimeClass: r.runtime_class,
    executionMode: r.execution_mode,
    relayTokenHash: r.relay_token_hash,
    activeRequestId: r.active_request_id,
    relayPurgedAt: r.relay_purged_at,
    destroyRequested: r.destroy_requested,
    timingsJson: r.timings_json,
    idlePolicyJson: r.idle_policy_json,
    maxLifetimeSeconds: r.max_lifetime_seconds,
    suspendedAt: r.suspended_at,
    resumeCount: r.resume_count,
    lastActivityAt: r.last_activity_at,
    workspacePvc: r.workspace_pvc,
    baselineCpuMillis: r.baseline_cpu_millis,
    baselineMemoryMib: r.baseline_memory_mib,
    updatedAt: r.updated_at,
  };
}

function mapIntent(r: Record<string, unknown>): PaymentIntentRecord {
  return {
    paymentKey: r.payment_key as string,
    status: r.status as IntentStatus,
    sessionId: (r.session_id as string | null) ?? null,
    specHash: (r.spec_hash as string) ?? "",
    reason: (r.reason as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

export class Store {
  private readonly db: DatabaseSync;
  private readonly stmts: Record<string, StatementSync>;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = FULL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");

    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined)
      ?.user_version ?? 0;
    if (version !== SCHEMA_VERSION) {
      this.db.exec(`
        DROP TABLE IF EXISTS exec_requests;
        DROP TABLE IF EXISTS sessions;
        DROP TABLE IF EXISTS payment_intents;
        DROP TABLE IF EXISTS payments;
      `);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        payment_key TEXT PRIMARY KEY,
        network TEXT NOT NULL,
        scheme TEXT NOT NULL,
        asset TEXT NOT NULL,
        amount TEXT NOT NULL,
        pay_to TEXT NOT NULL,
        payer TEXT,
        tx TEXT,
        mode TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payment_intents (
        payment_key TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        session_id TEXT,
        spec_hash TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        capability_hash TEXT NOT NULL,
        capability_expires_at INTEGER NOT NULL,
        client_public_key TEXT NOT NULL,
        client_nonce TEXT NOT NULL,
        tier TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL,
        cpu_millis INTEGER NOT NULL,
        memory_mib INTEGER NOT NULL,
        disk_mib INTEGER NOT NULL,
        max_output_bytes INTEGER NOT NULL,
        max_file_bytes INTEGER NOT NULL,
        max_command_seconds INTEGER NOT NULL,
        max_processes INTEGER NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        paid_at INTEGER,
        ready_at INTEGER,
        lease_expires_at INTEGER,
        terminating_at INTEGER,
        destroyed_at INTEGER,
        termination_reason TEXT,
        failure_code TEXT,
        failure_message TEXT,
        attestation_json TEXT,
        guest_public_key TEXT,
        payment_key TEXT NOT NULL UNIQUE REFERENCES payments(payment_key),
        pod_name TEXT,
        runtime_class TEXT,
        execution_mode TEXT,
        relay_token_hash TEXT,
        active_request_id TEXT,
        relay_purged_at INTEGER,
        destroy_requested INTEGER NOT NULL DEFAULT 0,
        timings_json TEXT,
        idle_policy_json TEXT,
        max_lifetime_seconds INTEGER,
        suspended_at INTEGER,
        resume_count INTEGER NOT NULL DEFAULT 0,
        last_activity_at INTEGER,
        workspace_pvc TEXT,
        baseline_cpu_millis INTEGER,
        baseline_memory_mib INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS exec_requests (
        id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        op TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, id)
      );
      CREATE INDEX IF NOT EXISTS sessions_state ON sessions(state);
      CREATE INDEX IF NOT EXISTS exec_requests_session ON exec_requests(session_id);
    `);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

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
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE state IN ('PAID','PROVISIONING','READY','ACTIVE','SUSPENDED','TERMINATING')`,
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
      markSuspended: this.db.prepare(
        `UPDATE sessions SET state='SUSPENDED', suspended_at=?, lease_expires_at=NULL,
           pod_name=NULL, updated_at=? WHERE id=? AND state IN ('READY','ACTIVE')`,
      ),
      markResuming: this.db.prepare(
        `UPDATE sessions SET state='PROVISIONING', pod_name=?, suspended_at=NULL,
           resume_count=resume_count+1, lease_expires_at=NULL, updated_at=?
         WHERE id=? AND state='SUSPENDED'`,
      ),
      setWorkspacePvc: this.db.prepare("UPDATE sessions SET workspace_pvc=?, updated_at=? WHERE id=?"),
      clearWorkspacePvc: this.db.prepare("UPDATE sessions SET workspace_pvc=NULL, updated_at=? WHERE id=?"),
      setProvisioning: this.db.prepare(
        "UPDATE sessions SET pod_name = ?, state = 'PROVISIONING', updated_at = ? WHERE id = ? AND state = 'PAID'",
      ),
      setRelayToken: this.db.prepare("UPDATE sessions SET relay_token_hash = ?, updated_at = ? WHERE id = ?"),
      setReady: this.db.prepare(
        `UPDATE sessions SET state='READY', ready_at=?, lease_expires_at=?, attestation_json=?,
           guest_public_key=?, last_activity_at=?, updated_at=? WHERE id=? AND state='PROVISIONING'`,
      ),
      requestTermination: this.db.prepare(
        `UPDATE sessions SET state='TERMINATING', terminating_at=?, termination_reason=?, updated_at=?
         WHERE id=? AND state IN ('PAID','PROVISIONING','READY','ACTIVE','SUSPENDED')`,
      ),
      setFailure: this.db.prepare(
        "UPDATE sessions SET failure_code = ?, failure_message = ?, updated_at = ? WHERE id = ?",
      ),
      finalize: this.db.prepare(
        `UPDATE sessions SET state=?, destroyed_at=?, active_request_id=NULL, updated_at=?
         WHERE id=? AND state='TERMINATING'`,
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
        "UPDATE sessions SET active_request_id = NULL, updated_at = ? WHERE id = ? AND active_request_id = ?",
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

  markSuspended(id: string, suspendedAt: number): boolean {
    return this.stmts.markSuspended!.run(suspendedAt, suspendedAt, id).changes > 0;
  }

  markResuming(id: string, podName: string): boolean {
    return this.stmts.markResuming!.run(podName, Date.now(), id).changes > 0;
  }

  setWorkspacePvc(id: string, pvcName: string): void {
    this.stmts.setWorkspacePvc!.run(pvcName, Date.now(), id);
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
    let final: SessionState = "DESTROYED";
    if (reason.startsWith("lease_expired")) final = "EXPIRED";
    else if (reason.startsWith("failure") || reason.startsWith("pod_")) final = "FAILED";
    else if (reason.startsWith("client_destroy")) final = "DESTROYED";
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
      if (session.state !== "READY" && session.state !== "ACTIVE") {
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
