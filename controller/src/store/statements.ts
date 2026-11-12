import type { DatabaseSync, StatementSync } from "node:sqlite";
import { SOURCE_STATES } from "@x402s/shared/protocol";
import { NON_TERMINAL_STATE_SQL, SESSION_COLUMNS } from "./models.js";

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
           runtime, relay_token_hash, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      getSession: db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`),
      getPayment: db.prepare("SELECT * FROM payments WHERE payment_key = ?"),
      getIntent: db.prepare("SELECT * FROM payment_intents WHERE payment_key = ?"),
      insertLedger: db.prepare(
        `INSERT INTO payment_ledger
           (payment_key, session_id, payer, amount, asset, network, mode, status, reason, refund_tx,
            settlement_nonce, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'SETTLED', NULL, NULL, ?, ?, ?)`,
      ),
      /**
       * A payment the facilitator settled but no session consumed (#31). The
       * session id is synthetic and documented: `unsettled:<paymentKey>` or
       * `duplicate:<paymentKey>`. It keeps the NOT NULL/UNIQUE constraint
       * meaningful instead of relaxing it.
       */
      insertLedgerUnclaimed: db.prepare(
        `INSERT OR IGNORE INTO payment_ledger
           (payment_key, session_id, payer, amount, asset, network, mode, status, reason, refund_tx,
            settlement_nonce, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      getLedgerByPayment: db.prepare("SELECT * FROM payment_ledger WHERE payment_key = ?"),
      getLedgerBySession: db.prepare("SELECT * FROM payment_ledger WHERE session_id = ?"),
      getLedgerByNonce: db.prepare(
        "SELECT * FROM payment_ledger WHERE settlement_nonce = ? ORDER BY created_at DESC LIMIT 1",
      ),
      /** REFUND_PENDING rows whose next attempt is due, oldest first (#31). */
      listRefundPendingDue: db.prepare(
        `SELECT * FROM payment_ledger
         WHERE status = 'REFUND_PENDING'
           AND (refund_next_attempt_at IS NULL OR refund_next_attempt_at <= ?)
         ORDER BY updated_at ASC LIMIT ?`,
      ),
      markRefundAttempt: db.prepare(
        `UPDATE payment_ledger
         SET refund_attempts = refund_attempts + 1, refund_last_error = ?,
             refund_next_attempt_at = ?, updated_at = ?
         WHERE payment_key = ? AND status = 'REFUND_PENDING'`,
      ),
      /** A client key pair that already owns a session, for the double-charge guard. */
      findSessionByClientNonce: db.prepare(
        `SELECT id FROM sessions
         WHERE client_public_key = ? AND client_nonce = ?
         ORDER BY created_at ASC LIMIT 1`,
      ),
      /**
       * Claimed intents older than the recovery grace: the crash window between
       * facilitator settlement and a durable entitlement (#31).
       */
      listStaleClaimedIntents: db.prepare(
        `SELECT * FROM payment_intents
         WHERE status = 'claimed' AND updated_at <= ?
         ORDER BY updated_at ASC LIMIT ?`,
      ),
      listLedgerByStatus: db.prepare(
        "SELECT * FROM payment_ledger WHERE status = ? ORDER BY updated_at ASC",
      ),
      countLedgerByStatus: db.prepare("SELECT COUNT(*) AS n FROM payment_ledger WHERE status = ?"),

      /**
       * Settled ledger rows with no session behind them (settlement recovery,
       * duplicate charge). They have no `sessions` row, so the terminal-before-
       * READY join cannot find them; this is the repair path for a crash between
       * writing the row and applying the refund policy.
       */
      listUnclaimedSettled: db.prepare(
        `SELECT * FROM payment_ledger
         WHERE status = 'SETTLED'
           AND (session_id LIKE 'unsettled:%' OR session_id LIKE 'duplicate:%')
         ORDER BY updated_at ASC LIMIT 100`,
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
      /* ---------------- challenge nonces (F-07) ---------------- */
      insertChallengeNonce: db.prepare(
        "INSERT INTO challenge_nonces (nonce, payment_key, issued_at, expires_at, burned_at) VALUES (?, NULL, ?, ?, NULL)",
      ),
      getChallengeNonce: db.prepare("SELECT * FROM challenge_nonces WHERE nonce = ?"),
      /**
       * Conditional on "still unburned and unexpired": two concurrent creates
       * presenting one nonce cannot both burn it, and a stale challenge cannot
       * be redeemed after its TTL.
       */
      burnChallengeNonce: db.prepare(
        `UPDATE challenge_nonces SET payment_key=?, burned_at=?
         WHERE nonce=? AND burned_at IS NULL AND expires_at > ?`,
      ),
      pruneChallengeNonces: db.prepare("DELETE FROM challenge_nonces WHERE expires_at <= ?"),
      countActiveChallengeNonces: db.prepare(
        "SELECT COUNT(*) AS n FROM challenge_nonces WHERE expires_at > ?",
      ),
      /* ---------------- durable budgets (#48) ---------------- */
      insertBudgetRow: db.prepare(
        "INSERT OR IGNORE INTO payer_budgets (budget_key, window_start_ms, creates, spend, updated_at) VALUES (?, ?, 0, '0', ?)",
      ),
      getBudget: db.prepare("SELECT * FROM payer_budgets WHERE budget_key = ?"),
      /**
       * Fixed-window roll, conditional on the window actually being expired so
       * a concurrent reservation inside the window is never reset underneath it.
       */
      resetBudgetWindow: db.prepare(
        `UPDATE payer_budgets SET window_start_ms=?, creates=0, spend='0', updated_at=?
         WHERE budget_key=? AND window_start_ms <= ?`,
      ),
      bumpBudgetCreate: db.prepare(
        "UPDATE payer_budgets SET creates=creates+1, updated_at=? WHERE budget_key=?",
      ),
      /** Exact decimal text: the amount may exceed a 64-bit integer. */
      setBudgetSpend: db.prepare("UPDATE payer_budgets SET spend=?, updated_at=? WHERE budget_key=?"),
      countLiveSessions: db.prepare(
        `SELECT COUNT(*) AS n FROM sessions WHERE state IN (${NON_TERMINAL_STATE_SQL})`,
      ),
      countLiveSessionsForPayer: db.prepare(
        `SELECT COUNT(*) AS n FROM sessions s
         JOIN payment_ledger l ON l.session_id = s.id
         WHERE lower(l.payer) = ? AND s.state IN (${NON_TERMINAL_STATE_SQL})`,
      ),
      insertIntent: db.prepare(
        `INSERT INTO payment_intents
           (payment_key, status, session_id, spec_hash, reason, claim_token, claim_expires_at,
            requirements_json, created_at, updated_at)
         VALUES (?, 'claimed', NULL, ?, NULL, ?, ?, ?, ?, ?)`,
      ),
      reclaimIntent: db.prepare(
        `UPDATE payment_intents
         SET status='claimed', reason=NULL, claim_token=?, claim_expires_at=?, updated_at=?
         WHERE payment_key=? AND status='claimed'`,
      ),
      settleIntent: db.prepare(
        `UPDATE payment_intents
         SET status='settled', session_id=?, claim_token=NULL, claim_expires_at=NULL, updated_at=?
         WHERE payment_key=? AND status='claimed' AND claim_token=?`,
      ),
      failIntent: db.prepare(
        `UPDATE payment_intents
         SET status='failed', reason=?, claim_token=NULL, claim_expires_at=NULL, updated_at=?
         WHERE payment_key=? AND status != 'settled'`,
      ),
      listNonTerminal: db.prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE state IN (${NON_TERMINAL_STATE_SQL})`,
      ),
      /**
       * Due-time read for the reconcile loop: live sessions whose next pass is
       * due (NULL means "never scheduled yet"), earliest first. `LIMIT` bounds
       * the work per tick.
       *
       * `INDEXED BY` is deliberate: without table statistics SQLite prefers the
       * narrow `sessions_state` index and then sorts every live row, which is
       * the O(all sessions) behaviour this column exists to remove.
       */
      listDue: db.prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions INDEXED BY sessions_due
         WHERE state IN (${NON_TERMINAL_STATE_SQL})
           AND (next_due_ms IS NULL OR next_due_ms <= ?)
         ORDER BY next_due_ms LIMIT ?`,
      ),
      /** Move one session's next pass; cadence policy lives in the caller. */
      bumpDue: db.prepare("UPDATE sessions SET next_due_ms = ? WHERE id = ?"),
      /**
       * Re-arm a session after a pass, but only while it is still due.
       *
       * A state change in the same pass already armed the row for its new
       * state; that deadline is in the future, so this UPDATE matches nothing
       * and the transition's cadence wins. An unchanged session that is still
       * due is moved forward exactly once, which is what stops `listDue` from
       * returning it again on the very next pass. NULL is treated as due
       * (never left in place).
       */
      rearmDue: db.prepare(
        "UPDATE sessions SET next_due_ms = ? WHERE id = ? AND (next_due_ms IS NULL OR next_due_ms <= ?)",
      ),
      /** Due count for the per-pass backlog gauge (index-only, no row mapping). */
      countDue: db.prepare(
        `SELECT COUNT(*) AS n FROM sessions INDEXED BY sessions_due
         WHERE state IN (${NON_TERMINAL_STATE_SQL})
           AND (next_due_ms IS NULL OR next_due_ms <= ?)`,
      ),
      /** Live sessions grouped by state, for capacity gauges without listing rows. */
      countLiveByState: db.prepare(
        `SELECT state, COUNT(*) AS n FROM sessions WHERE state IN (${NON_TERMINAL_STATE_SQL}) GROUP BY state`,
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
        `UPDATE sessions SET state='SUSPENDING', next_due_ms=?, updated_at=? WHERE id=? AND state IN (${statesIn("suspend_requested")})`,
      ),
      markSuspended: db.prepare(
        `UPDATE sessions SET state='SUSPENDED', suspended_at=?, lease_expires_at=NULL,
           pod_name=NULL, next_due_ms=?, updated_at=? WHERE id=? AND state IN (${statesIn("guest_stopped")})`,
      ),
      markResuming: db.prepare(
        `UPDATE sessions SET state='RESUMING', pod_name=?, suspended_at=NULL,
           resume_count=resume_count+1, lease_expires_at=NULL, next_due_ms=?, updated_at=?
         WHERE id=? AND state IN (${statesIn("resume_requested")})`,
      ),
      setWorkspacePvc: db.prepare("UPDATE sessions SET workspace_pvc=?, updated_at=? WHERE id=?"),
      setNodeName: db.prepare("UPDATE sessions SET node_name=?, updated_at=? WHERE id=?"),
      clearWorkspacePvc: db.prepare("UPDATE sessions SET workspace_pvc=NULL, updated_at=? WHERE id=?"),
      setProvisioning: db.prepare(
        `UPDATE sessions SET pod_name = ?, state = 'PROVISIONING', next_due_ms = ?, updated_at = ? WHERE id = ? AND state IN (${statesIn("provision_requested")})`,
      ),
      setProvisioningPod: db.prepare(
        `UPDATE sessions SET pod_name = ?, updated_at = ? WHERE id = ? AND state = 'PROVISIONING'`,
      ),
      setRelayToken: db.prepare("UPDATE sessions SET relay_token_hash = ?, updated_at = ? WHERE id = ?"),
      setReady: db.prepare(
        `UPDATE sessions SET state='READY', ready_at=?, lease_expires_at=?, attestation_json=?,
           guest_public_key=?, last_activity_at=?, next_due_ms=?, updated_at=?
         WHERE id=? AND state IN (${statesIn("guest_ready")})
           AND pod_name IS NOT NULL AND relay_token_hash IS NOT NULL`,
      ),
      requestTermination: db.prepare(
        `UPDATE sessions SET state='TERMINATING', terminating_at=?, termination_reason=?,
           next_due_ms=?, updated_at=?
         WHERE id=? AND state IN (${statesIn("terminate_requested")})`,
      ),
      setFailure: db.prepare(
        "UPDATE sessions SET failure_code = ?, failure_message = ?, updated_at = ? WHERE id = ?",
      ),
      finalize: db.prepare(
        `UPDATE sessions SET state=?, destroyed_at=?, active_request_id=NULL, next_due_ms=?, updated_at=?
         WHERE id=? AND state IN (${statesIn("terminated")})`,
      ),
      requestDestroy: db.prepare(
        // A destroy is an event: make the row due now so an immediate wake
        // pass (or the next tick) terminates it instead of waiting out the
        // state's cadence. The pass re-arms it after processing.
        "UPDATE sessions SET destroy_requested = 1, next_due_ms = ?, updated_at = ? WHERE id = ? AND state NOT IN ('EXPIRED','FAILED','DESTROYED')",
      ),
      markRelayPurged: db.prepare("UPDATE sessions SET relay_purged_at = ?, updated_at = ? WHERE id = ?"),
      clearPod: db.prepare("UPDATE sessions SET pod_name = NULL, updated_at = ? WHERE id = ?"),
      mergeTimings: db.prepare(
        "UPDATE sessions SET timings_json = json_patch(COALESCE(timings_json, '{}'), ?), updated_at = ? WHERE id = ?",
      ),
      clearActive: db.prepare(
        "UPDATE sessions SET active_request_id = NULL, state = CASE WHEN state='ACTIVE' THEN 'READY' ELSE state END, next_due_ms = ?, updated_at = ? WHERE id = ? AND active_request_id = ?",
      ),
      /** Claim the single operation slot and move READY -> ACTIVE in one write. */
      claimActive: db.prepare(
        "UPDATE sessions SET active_request_id = ?, state = CASE WHEN state='READY' THEN 'ACTIVE' ELSE state END, next_due_ms = ?, updated_at = ? WHERE id = ?",
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
             next_due_ms = ?,
             updated_at = ?
         WHERE id = ? AND active_request_id = ? AND exec_epoch = ?`,
      ),
      countSessions: db.prepare("SELECT COUNT(*) AS n FROM sessions"),
      countPayments: db.prepare("SELECT COUNT(*) AS n FROM payments"),
      insertRequest: db.prepare(
        "INSERT INTO exec_requests (id, session_id, op, state, epoch, payload_hash, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)",
      ),
      getRequest: db.prepare("SELECT * FROM exec_requests WHERE session_id = ? AND id = ?"),
      /**
       * Finish one pending request and, when the caller has one, keep the sealed
       * result with it. `COALESCE` leaves an envelope already on the row alone:
       * the guard is `state = 'pending'`, so a second finish matches nothing
       * anyway, and a retry that only confirms the outcome must not erase the
       * result the first finish stored.
       */
      finishRequest: db.prepare(
        "UPDATE exec_requests SET state = ?, result_envelope = COALESCE(?, result_envelope), updated_at = ? WHERE session_id = ? AND id = ? AND state = 'pending'",
      ),
      /** Terminal cleanup: the rows stay for audit, their ciphertext does not. */
      clearSessionResultEnvelopes: db.prepare(
        "UPDATE exec_requests SET result_envelope = NULL WHERE session_id = ? AND result_envelope IS NOT NULL",
      ),
    };
}
