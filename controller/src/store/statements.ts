import type { DatabaseSync, StatementSync } from "node:sqlite";
import { SOURCE_STATES } from "@x402s/shared";
import { SESSION_COLUMNS } from "./models.js";

const statesIn = (event: keyof typeof SOURCE_STATES): string =>
  SOURCE_STATES[event].map((state) => `'${state}'`).join(",");

/** All prepared statements used by Store. */
export function prepareStatements(db: DatabaseSync): Record<string, StatementSync> {
    return {
      insertPayment: db.prepare(
        `INSERT INTO payments (payment_key, network, scheme, asset, amount, pay_to, payer, tx, mode, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertSession: db.prepare(
        `INSERT INTO sessions (
           id, capability_hash, capability_expires_at, client_public_key, client_nonce, client_signer,
           tier, duration_seconds, cpu_millis, memory_mib, disk_mib, max_output_bytes,
           max_file_bytes, max_command_seconds, max_processes,
           state, created_at, paid_at, payment_key, runtime_class, execution_mode,
           relay_token_hash, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      getSession: db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`),
      getPayment: db.prepare("SELECT * FROM payments WHERE payment_key = ?"),
      getIntent: db.prepare("SELECT * FROM payment_intents WHERE payment_key = ?"),
      insertLedger: db.prepare(
        `INSERT INTO payment_ledger
           (payment_key, session_id, payer, amount, asset, network, mode, status, reason, refund_tx, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'SETTLED', NULL, NULL, ?, ?)`,
      ),
      getLedgerByPayment: db.prepare("SELECT * FROM payment_ledger WHERE payment_key = ?"),
      getLedgerBySession: db.prepare("SELECT * FROM payment_ledger WHERE session_id = ?"),
      listLedgerByStatus: db.prepare(
        "SELECT * FROM payment_ledger WHERE status = ? ORDER BY updated_at ASC",
      ),
      listUnrefundedTerminalBeforeReady: db.prepare(
        `SELECT l.* FROM payment_ledger l JOIN sessions s ON s.id = l.session_id
         WHERE l.status = 'SETTLED' AND s.ready_at IS NULL
           AND s.state IN ('FAILED','EXPIRED','DESTROYED')
         ORDER BY l.updated_at ASC LIMIT 100`,
      ),
      markRefundPending: db.prepare(
        `UPDATE payment_ledger SET status='REFUND_PENDING', reason=?, updated_at=?
         WHERE payment_key=? AND status='SETTLED'`,
      ),
      markRefunded: db.prepare(
        `UPDATE payment_ledger SET status='REFUNDED', reason=?, refund_tx=?, updated_at=?
         WHERE payment_key=? AND status IN ('SETTLED','REFUND_PENDING')`,
      ),
      insertIntent: db.prepare(
        `INSERT INTO payment_intents (payment_key, status, session_id, spec_hash, reason, created_at, updated_at)
         VALUES (?, 'claimed', NULL, ?, NULL, ?, ?)`,
      ),
      reclaimIntent: db.prepare(
        "UPDATE payment_intents SET status='claimed', reason=NULL, updated_at=? WHERE payment_key=?",
      ),
      settleIntent: db.prepare(
        "UPDATE payment_intents SET status='settled', session_id=?, updated_at=? WHERE payment_key=?",
      ),
      failIntent: db.prepare(
        "UPDATE payment_intents SET status='failed', reason=?, updated_at=? WHERE payment_key=?",
      ),
      listNonTerminal: db.prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE state IN ('PAID','PROVISIONING','READY','ACTIVE','SUSPENDING','SUSPENDED','RESUMING','TERMINATING')`,
      ),
      listTerminalWithPod: db.prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE state IN ('EXPIRED','FAILED','DESTROYED') AND pod_name IS NOT NULL`,
      ),
      listTerminalWithPvc: db.prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE state IN ('EXPIRED','FAILED','DESTROYED') AND workspace_pvc IS NOT NULL`,
      ),
      initLifecycle: db.prepare(
        `UPDATE sessions SET idle_policy_json=?, max_lifetime_seconds=?, last_activity_at=?,
           workspace_pvc=?, suspended_at=?, resume_count=?, baseline_cpu_millis=?,
           baseline_memory_mib=?, updated_at=? WHERE id=?`,
      ),
      touchActivity: db.prepare(
        "UPDATE sessions SET last_activity_at=?, updated_at=? WHERE id=? AND state IN ('READY','ACTIVE')",
      ),
      markSuspending: db.prepare(
        `UPDATE sessions SET state='SUSPENDING', updated_at=? WHERE id=? AND state IN (${statesIn("suspend_requested")})`,
      ),
      markSuspended: db.prepare(
        `UPDATE sessions SET state='SUSPENDED', suspended_at=?, lease_expires_at=NULL,
           pod_name=NULL, updated_at=? WHERE id=? AND state IN (${statesIn("guest_stopped")})`,
      ),
      markResuming: db.prepare(
        `UPDATE sessions SET state='RESUMING', pod_name=?, suspended_at=NULL,
           resume_count=resume_count+1, lease_expires_at=NULL, updated_at=?
         WHERE id=? AND state IN (${statesIn("resume_requested")})`,
      ),
      setWorkspacePvc: db.prepare("UPDATE sessions SET workspace_pvc=?, updated_at=? WHERE id=?"),
      setNodeName: db.prepare("UPDATE sessions SET node_name=?, updated_at=? WHERE id=?"),
      clearWorkspacePvc: db.prepare("UPDATE sessions SET workspace_pvc=NULL, updated_at=? WHERE id=?"),
      setProvisioning: db.prepare(
        `UPDATE sessions SET pod_name = ?, state = 'PROVISIONING', updated_at = ? WHERE id = ? AND state IN (${statesIn("provision_requested")})`,
      ),
      setRelayToken: db.prepare("UPDATE sessions SET relay_token_hash = ?, updated_at = ? WHERE id = ?"),
      setReady: db.prepare(
        `UPDATE sessions SET state='READY', ready_at=?, lease_expires_at=?, attestation_json=?,
           guest_public_key=?, last_activity_at=?, updated_at=?
         WHERE id=? AND state IN (${statesIn("guest_ready")})
           AND pod_name IS NOT NULL AND relay_token_hash IS NOT NULL`,
      ),
      requestTermination: db.prepare(
        `UPDATE sessions SET state='TERMINATING', terminating_at=?, termination_reason=?, updated_at=?
         WHERE id=? AND state IN (${statesIn("terminate_requested")})`,
      ),
      setFailure: db.prepare(
        "UPDATE sessions SET failure_code = ?, failure_message = ?, updated_at = ? WHERE id = ?",
      ),
      finalize: db.prepare(
        `UPDATE sessions SET state=?, destroyed_at=?, active_request_id=NULL, updated_at=?
         WHERE id=? AND state IN (${statesIn("terminated")})`,
      ),
      requestDestroy: db.prepare(
        "UPDATE sessions SET destroy_requested = 1, updated_at = ? WHERE id = ? AND state NOT IN ('EXPIRED','FAILED','DESTROYED')",
      ),
      markRelayPurged: db.prepare("UPDATE sessions SET relay_purged_at = ?, updated_at = ? WHERE id = ?"),
      clearPod: db.prepare("UPDATE sessions SET pod_name = NULL, updated_at = ? WHERE id = ?"),
      mergeTimings: db.prepare(
        "UPDATE sessions SET timings_json = json_patch(COALESCE(timings_json, '{}'), ?), updated_at = ? WHERE id = ?",
      ),
      clearActive: db.prepare(
        "UPDATE sessions SET active_request_id = NULL, state = CASE WHEN state='ACTIVE' THEN 'READY' ELSE state END, updated_at = ? WHERE id = ? AND active_request_id = ?",
      ),
      /** Recovery: an in-flight request may still be running; never report success/failure. */
      markPendingOutcomeUnknown: db.prepare(
        "UPDATE exec_requests SET state = 'outcome_unknown', updated_at = ? WHERE state = 'pending'",
      ),
      /** Recovery: fence the generation that owned the interrupted request. */
      fenceActiveSessions: db.prepare(
        "UPDATE sessions SET exec_epoch = exec_epoch + 1, updated_at = ? WHERE active_request_id IS NOT NULL",
      ),
      /** Sessions whose gate is held by a request the current controller did not claim. */
      listFencedSessions: db.prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions s
         WHERE s.active_request_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM exec_requests r
             WHERE r.session_id = s.id AND r.id = s.active_request_id AND r.state = 'outcome_unknown'
           )`,
      ),
      clearFencedGate: db.prepare(
        `UPDATE sessions
         SET active_request_id = NULL,
             state = CASE WHEN state='ACTIVE' THEN 'READY' ELSE state END,
             updated_at = ?
         WHERE id = ? AND active_request_id = ? AND exec_epoch = ?`,
      ),
      countSessions: db.prepare("SELECT COUNT(*) AS n FROM sessions"),
      countPayments: db.prepare("SELECT COUNT(*) AS n FROM payments"),
      insertRequest: db.prepare(
        "INSERT INTO exec_requests (id, session_id, op, state, epoch, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)",
      ),
      getRequest: db.prepare("SELECT * FROM exec_requests WHERE session_id = ? AND id = ?"),
      finishRequest: db.prepare(
        "UPDATE exec_requests SET state = ?, updated_at = ? WHERE session_id = ? AND id = ?",
      ),
    };
}
