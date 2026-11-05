/**
 * Single-writer persistence for entitlements and session lifecycle.
 *
 * SQLite (WAL) is used deliberately: this prototype must survive controller
 * restarts without orphaning pods, and payment redemption must be atomic. In
 * production this becomes Postgres/DynamoDB with the same invariants
 * (`payment_key` UNIQUE, conditional state transitions).
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { SandboxState } from "@x402s/shared";

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
  durationSeconds: number;
  state: SandboxState;
  createdAt: number;
  paidAt: number | null;
  readyAt: number | null;
  executionDeadlineAt: number | null;
  completedAt: number | null;
  destroyedAt: number | null;
  failureCode: string | null;
  failureMessage: string | null;
  attestationJson: string | null;
  guestPublicKey: string | null;
  paymentKey: string;
  podName: string | null;
  runtimeClass: string | null;
  executionMode: string | null;
  relayTokenHash: string | null;
  execStartedAt: number | null;
  execAccepted: number;
  resultFetchedAt: number | null;
  relayPurgedAt: number | null;
  destroyRequested: number;
  updatedAt: number;
}

export class PaymentAlreadyRedeemedError extends Error {
  constructor(paymentKey: string) {
    super(`payment ${paymentKey.slice(0, 12)}… has already been redeemed`);
    this.name = "PaymentAlreadyRedeemedError";
  }
}

const SESSION_COLUMNS = `
  id, capability_hash, capability_expires_at, client_public_key, client_nonce,
  duration_seconds, state, created_at, paid_at, ready_at, execution_deadline_at,
  completed_at, destroyed_at, failure_code, failure_message, attestation_json,
  guest_public_key, payment_key, pod_name, runtime_class, execution_mode,
  relay_token_hash, exec_started_at, exec_accepted, result_fetched_at,
  relay_purged_at, destroy_requested, updated_at
`;

interface RawSession {
  id: string;
  capability_hash: string;
  capability_expires_at: number;
  client_public_key: string;
  client_nonce: string;
  duration_seconds: number;
  state: string;
  created_at: number;
  paid_at: number | null;
  ready_at: number | null;
  execution_deadline_at: number | null;
  completed_at: number | null;
  destroyed_at: number | null;
  failure_code: string | null;
  failure_message: string | null;
  attestation_json: string | null;
  guest_public_key: string | null;
  payment_key: string;
  pod_name: string | null;
  runtime_class: string | null;
  execution_mode: string | null;
  relay_token_hash: string | null;
  exec_started_at: number | null;
  exec_accepted: number;
  result_fetched_at: number | null;
  relay_purged_at: number | null;
  destroy_requested: number;
  updated_at: number;
}

function mapSession(r: RawSession): SessionRecord {
  return {
    id: r.id,
    capabilityHash: r.capability_hash,
    capabilityExpiresAt: r.capability_expires_at,
    clientPublicKey: r.client_public_key,
    clientNonce: r.client_nonce,
    durationSeconds: r.duration_seconds,
    state: r.state as SandboxState,
    createdAt: r.created_at,
    paidAt: r.paid_at,
    readyAt: r.ready_at,
    executionDeadlineAt: r.execution_deadline_at,
    completedAt: r.completed_at,
    destroyedAt: r.destroyed_at,
    failureCode: r.failure_code,
    failureMessage: r.failure_message,
    attestationJson: r.attestation_json,
    guestPublicKey: r.guest_public_key,
    paymentKey: r.payment_key,
    podName: r.pod_name,
    runtimeClass: r.runtime_class,
    executionMode: r.execution_mode,
    relayTokenHash: r.relay_token_hash,
    execStartedAt: r.exec_started_at,
    execAccepted: r.exec_accepted,
    resultFetchedAt: r.result_fetched_at,
    relayPurgedAt: r.relay_purged_at,
    destroyRequested: r.destroy_requested,
    updatedAt: r.updated_at,
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
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        capability_hash TEXT NOT NULL,
        capability_expires_at INTEGER NOT NULL,
        client_public_key TEXT NOT NULL,
        client_nonce TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        paid_at INTEGER,
        ready_at INTEGER,
        execution_deadline_at INTEGER,
        completed_at INTEGER,
        destroyed_at INTEGER,
        failure_code TEXT,
        failure_message TEXT,
        attestation_json TEXT,
        guest_public_key TEXT,
        payment_key TEXT NOT NULL UNIQUE REFERENCES payments(payment_key),
        pod_name TEXT,
        runtime_class TEXT,
        execution_mode TEXT,
        relay_token_hash TEXT,
        exec_started_at INTEGER,
        exec_accepted INTEGER NOT NULL DEFAULT 0,
        result_fetched_at INTEGER,
        relay_purged_at INTEGER,
        destroy_requested INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_state ON sessions(state);
      DELETE FROM sessions WHERE state IN ('DESTROYED','EXPIRED','FAILED') AND created_at < (strftime('%s','now') * 1000 - 86400000);
    `);

    this.stmts = {
      insertPayment: this.db.prepare(
        `INSERT INTO payments (payment_key, network, scheme, asset, amount, pay_to, payer, tx, mode, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertSession: this.db.prepare(
        `INSERT INTO sessions (
           id, capability_hash, capability_expires_at, client_public_key, client_nonce,
           duration_seconds, state, created_at, paid_at, payment_key, runtime_class,
           execution_mode, relay_token_hash, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      getSession: this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`),
      getPayment: this.db.prepare("SELECT * FROM payments WHERE payment_key = ?"),
      listNonTerminal: this.db.prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE state IN ('PAID','PROVISIONING','READY','RUNNING','COMPLETED','EXPIRED','FAILED')`,
      ),
      setPod: this.db.prepare(
        "UPDATE sessions SET pod_name = ?, state = ?, updated_at = ? WHERE id = ? AND state = ?",
      ),
      setRelayToken: this.db.prepare("UPDATE sessions SET relay_token_hash = ?, updated_at = ? WHERE id = ?"),
      setReady: this.db.prepare(
        `UPDATE sessions SET state='READY', ready_at=?, execution_deadline_at=?, attestation_json=?,
           guest_public_key=?, updated_at=? WHERE id=? AND state='PROVISIONING'`,
      ),
      claimExecution: this.db.prepare(
        `UPDATE sessions SET state='RUNNING', exec_started_at=?, exec_accepted=1, updated_at=?
         WHERE id=? AND state='READY' AND exec_accepted=0`,
      ),
      releaseExecution: this.db.prepare(
        `UPDATE sessions SET state='READY', exec_started_at=NULL, exec_accepted=0, updated_at=?
         WHERE id=? AND state='RUNNING' AND completed_at IS NULL`,
      ),
      complete: this.db.prepare(
        `UPDATE sessions SET state='COMPLETED', completed_at=?, updated_at=?
         WHERE id=? AND state IN ('RUNNING','READY')`,
      ),
      destroy: this.db.prepare(
        `UPDATE sessions SET state='DESTROYED', destroyed_at=?, updated_at=?
         WHERE id=? AND state='COMPLETED'`,
      ),
      fail: this.db.prepare(
        `UPDATE sessions SET state='FAILED', failure_code=?, failure_message=?, destroyed_at=?, updated_at=?
         WHERE id=? AND state IN ('PAID','PROVISIONING','READY','RUNNING')`,
      ),
      expire: this.db.prepare(
        `UPDATE sessions SET state='EXPIRED', failure_code=?, failure_message=?, destroyed_at=?, updated_at=?
         WHERE id=? AND state IN ('PAID','PROVISIONING','READY','RUNNING')`,
      ),
      noteDestroyed: this.db.prepare(
        "UPDATE sessions SET destroyed_at = COALESCE(destroyed_at, ?), updated_at = ? WHERE id = ?",
      ),
      requestDestroy: this.db.prepare(
        "UPDATE sessions SET destroy_requested = 1, updated_at = ? WHERE id = ? AND state NOT IN ('FAILED','EXPIRED')",
      ),
      markResultFetched: this.db.prepare("UPDATE sessions SET result_fetched_at = ?, updated_at = ? WHERE id = ?"),
      markRelayPurged: this.db.prepare("UPDATE sessions SET relay_purged_at = ?, updated_at = ? WHERE id = ?"),
      clearPod: this.db.prepare("UPDATE sessions SET pod_name = NULL, updated_at = ? WHERE id = ?"),
    };
  }

  close(): void {
    this.db.close();
  }

  /**
   * Atomically redeem a payment and create its single session.
   * Throws PaymentAlreadyRedeemedError on any duplicate (including concurrent).
   */
  createEntitlement(payment: PaymentRecord, session: SessionRecord): void {
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
        session.durationSeconds,
        session.state,
        session.createdAt,
        session.paidAt,
        session.paymentKey,
        session.runtimeClass,
        session.executionMode,
        session.relayTokenHash,
        session.updatedAt,
      );
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      const msg = (err as Error).message;
      if (msg.includes("UNIQUE") || msg.includes("PRIMARY KEY")) {
        throw new PaymentAlreadyRedeemedError(payment.paymentKey);
      }
      throw err;
    }
  }

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

  /** Diagnostics/tests only: total session rows. */
  countSessions(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  countPayments(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM payments").get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  listNonTerminal(): SessionRecord[] {
    return (this.stmts.listNonTerminal!.all() as unknown as RawSession[]).map(mapSession);
  }

  setProvisioning(id: string, podName: string): boolean {
    const now = Date.now();
    return this.stmts.setPod!.run(podName, "PROVISIONING", now, id, "PAID").changes > 0;
  }

  setRelayToken(id: string, tokenHash: string): void {
    this.stmts.setRelayToken!.run(tokenHash, Date.now(), id);
  }

  setReady(id: string, readyAt: number, deadlineAt: number, attestationJson: string, guestPublicKey: string): boolean {
    return (
      this.stmts.setReady!.run(readyAt, deadlineAt, attestationJson, guestPublicKey, Date.now(), id).changes > 0
    );
  }

  claimExecution(id: string): boolean {
    const now = Date.now();
    return this.stmts.claimExecution!.run(now, now, id).changes > 0;
  }

  releaseExecution(id: string): void {
    this.stmts.releaseExecution!.run(Date.now(), id);
  }

  markCompleted(id: string): boolean {
    const now = Date.now();
    return this.stmts.complete!.run(now, now, id).changes > 0;
  }

  markDestroyed(id: string): boolean {
    const now = Date.now();
    return this.stmts.destroy!.run(now, now, id).changes > 0;
  }

  markFailed(id: string, code: string, message: string): boolean {
    const now = Date.now();
    return this.stmts.fail!.run(code, message, now, now, id).changes > 0;
  }

  markExpired(id: string, code: string, message: string): boolean {
    const now = Date.now();
    return this.stmts.expire!.run(code, message, now, now, id).changes > 0;
  }

  noteDestroyed(id: string): void {
    this.stmts.noteDestroyed!.run(Date.now(), Date.now(), id);
  }

  requestDestroy(id: string): void {
    this.stmts.requestDestroy!.run(Date.now(), id);
  }

  markResultFetched(id: string): void {
    this.stmts.markResultFetched!.run(Date.now(), Date.now(), id);
  }

  markRelayPurged(id: string): void {
    this.stmts.markRelayPurged!.run(Date.now(), Date.now(), id);
  }

  clearPod(id: string): void {
    this.stmts.clearPod!.run(Date.now(), id);
  }
}
