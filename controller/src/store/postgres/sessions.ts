/**
 * Session rows and their guarded transitions, for Postgres.
 *
 * Every method here is either a read or a single conditional write. The
 * transitions that the SQLite adapter gets away with by holding one serialised
 * `BEGIN IMMEDIATE` are `UPDATE … WHERE state IN (…) RETURNING state` here, so
 * the guard is evaluated by the server against the committed row. The only
 * read-then-write left is `finalizeTermination`, and it takes an explicit
 * `SELECT … FOR UPDATE` row lock to keep that pair atomic.
 */
import { SOURCE_STATES, finalStateForReason } from "@x402s/shared/protocol";
import { cadenceFor } from "../../reconcile-cadence.js";
import {
  mapSession,
  NON_TERMINAL_STATE_SQL,
  SESSION_COLUMNS,
  type RawSession,
  type SessionRecord,
  type SessionState,
} from "../models.js";
import type { PgConnection, Tx } from "./pg.js";

const TERMINAL = ["EXPIRED", "FAILED", "DESTROYED"];

export class PgSessionRepository {
  constructor(private readonly conn: PgConnection) {}

  private async rows(text: string, values?: unknown[]): Promise<SessionRecord[]> {
    const res = await this.conn.query<RawSession>(text, values);
    return res.rows.map(mapSession);
  }

  private async one(tx: Tx, id: string): Promise<SessionRecord | null> {
    const res = await tx.query<RawSession>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = $1`, [id]);
    return res.rows[0] ? mapSession(res.rows[0]) : null;
  }

  async get(id: string): Promise<SessionRecord | null> {
    const res = await this.conn.query<RawSession>(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = $1`,
      [id],
    );
    return res.rows[0] ? mapSession(res.rows[0]) : null;
  }

  async listNonTerminal(): Promise<SessionRecord[]> {
    return this.rows(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE state IN (${NON_TERMINAL_STATE_SQL})`,
    );
  }

  /**
   * `NULLS FIRST` is not cosmetic: NULL means "never scheduled, due now", and
   * Postgres would otherwise sort those rows behind every future deadline, so a
   * paid session would sit untouched until every other session had been
   * reconciled.
   */
  async listDue(now: number, limit: number): Promise<SessionRecord[]> {
    return this.rows(
      `SELECT ${SESSION_COLUMNS} FROM sessions
        WHERE state IN (${NON_TERMINAL_STATE_SQL})
          AND (next_due_ms IS NULL OR next_due_ms <= $1)
        ORDER BY next_due_ms NULLS FIRST LIMIT $2`,
      [now, limit],
    );
  }

  async countDue(now: number): Promise<number> {
    const res = await this.conn.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sessions
        WHERE state IN (${NON_TERMINAL_STATE_SQL})
          AND (next_due_ms IS NULL OR next_due_ms <= $1)`,
      [now],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  async countLiveByState(): Promise<Partial<Record<SessionState, number>>> {
    const res = await this.conn.query<{ state: string; n: number }>(
      `SELECT state, COUNT(*) AS n FROM sessions
        WHERE state IN (${NON_TERMINAL_STATE_SQL}) GROUP BY state`,
    );
    const counts: Partial<Record<SessionState, number>> = {};
    for (const row of res.rows) counts[row.state as SessionState] = Number(row.n);
    return counts;
  }

  async listTerminalWithPod(): Promise<SessionRecord[]> {
    return this.rows(
      `SELECT ${SESSION_COLUMNS} FROM sessions
        WHERE state = ANY($1::text[]) AND pod_name IS NOT NULL`,
      [TERMINAL],
    );
  }

  async listTerminalWithPvc(): Promise<SessionRecord[]> {
    return this.rows(
      `SELECT ${SESSION_COLUMNS} FROM sessions
        WHERE state = ANY($1::text[]) AND workspace_pvc IS NOT NULL`,
      [TERMINAL],
    );
  }

  /** Move the due time only while the row is still due; a transition's own cadence wins. */
  async rearmDue(id: string, atMs: number, nowMs: number): Promise<boolean> {
    const res = await this.conn.write(
      `UPDATE sessions SET next_due_ms = $1
        WHERE id = $2 AND (next_due_ms IS NULL OR next_due_ms <= $3)`,
      [atMs, id, nowMs],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async setProvisioning(id: string, podName: string): Promise<boolean> {
    const now = Date.now();
    const res = await this.conn.write(
      `UPDATE sessions SET pod_name = $1, state = 'PROVISIONING', next_due_ms = $2, updated_at = $3
        WHERE id = $4 AND state = ANY($5::text[]) RETURNING state`,
      [podName, now + cadenceFor("PROVISIONING"), now, id, SOURCE_STATES.provision_requested],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async setProvisioningPod(id: string, podName: string): Promise<boolean> {
    const res = await this.conn.write(
      `UPDATE sessions SET pod_name = $1, updated_at = $2
        WHERE id = $3 AND state = 'PROVISIONING' RETURNING state`,
      [podName, Date.now(), id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async setRelayToken(id: string, tokenHash: string): Promise<void> {
    await this.conn.write("UPDATE sessions SET relay_token_hash = $1, updated_at = $2 WHERE id = $3", [
      tokenHash,
      Date.now(),
      id,
    ]);
  }

  async setReady(
    id: string,
    readyAt: number,
    leaseExpiresAt: number,
    attestationJson: string,
    guestPublicKey: string,
  ): Promise<boolean> {
    const now = Date.now();
    const res = await this.conn.write(
      `UPDATE sessions SET state = 'READY', ready_at = $1, lease_expires_at = $2,
          attestation_json = $3, guest_public_key = $4, last_activity_at = $5,
          next_due_ms = $6, updated_at = $7
        WHERE id = $8 AND state = ANY($9::text[])
          AND pod_name IS NOT NULL AND relay_token_hash IS NOT NULL
        RETURNING state`,
      [
        readyAt,
        leaseExpiresAt,
        attestationJson,
        guestPublicKey,
        readyAt,
        now + cadenceFor("READY"),
        now,
        id,
        SOURCE_STATES.guest_ready,
      ],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async touchActivity(id: string): Promise<void> {
    const now = Date.now();
    await this.conn.write(
      "UPDATE sessions SET last_activity_at = $1, updated_at = $2 WHERE id = $3 AND state IN ('READY','ACTIVE')",
      [now, now, id],
    );
  }

  async markSuspending(id: string): Promise<boolean> {
    const now = Date.now();
    const res = await this.conn.write(
      `UPDATE sessions SET state = 'SUSPENDING', next_due_ms = $1, updated_at = $2
        WHERE id = $3 AND state = ANY($4::text[]) RETURNING state`,
      [now + cadenceFor("SUSPENDING"), now, id, SOURCE_STATES.suspend_requested],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async markSuspended(id: string, suspendedAt: number): Promise<boolean> {
    const res = await this.conn.write(
      `UPDATE sessions SET state = 'SUSPENDED', suspended_at = $1, lease_expires_at = NULL,
          pod_name = NULL, next_due_ms = $2, updated_at = $3
        WHERE id = $4 AND state = ANY($5::text[]) RETURNING state`,
      [suspendedAt, suspendedAt + cadenceFor("SUSPENDED"), suspendedAt, id, SOURCE_STATES.guest_stopped],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async markResuming(id: string, podName: string): Promise<boolean> {
    const now = Date.now();
    const res = await this.conn.write(
      `UPDATE sessions SET state = 'RESUMING', pod_name = $1, suspended_at = NULL,
          resume_count = resume_count + 1, lease_expires_at = NULL,
          next_due_ms = $2, updated_at = $3
        WHERE id = $4 AND state = ANY($5::text[]) RETURNING state`,
      [podName, now + cadenceFor("RESUMING"), now, id, SOURCE_STATES.resume_requested],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async setWorkspacePvc(id: string, pvcName: string): Promise<void> {
    await this.conn.write("UPDATE sessions SET workspace_pvc = $1, updated_at = $2 WHERE id = $3", [
      pvcName,
      Date.now(),
      id,
    ]);
  }

  async clearWorkspacePvc(id: string): Promise<void> {
    await this.conn.write("UPDATE sessions SET workspace_pvc = NULL, updated_at = $1 WHERE id = $2", [
      Date.now(),
      id,
    ]);
  }

  async setNodeName(id: string, nodeName: string): Promise<void> {
    await this.conn.write("UPDATE sessions SET node_name = $1, updated_at = $2 WHERE id = $3", [
      nodeName,
      Date.now(),
      id,
    ]);
  }

  /**
   * PAID/PROVISIONING/READY/… -> TERMINATING. `RETURNING state` tells the caller
   * whether it won; the loser sees zero rows and schedules nothing.
   */
  async requestTermination(
    id: string,
    reason: string,
    failure?: { code: string; message: string },
  ): Promise<boolean> {
    return this.conn.tx(async (tx) => {
      const now = Date.now();
      const res = await tx.query(
        `UPDATE sessions SET state = 'TERMINATING', terminating_at = $1, termination_reason = $2,
            next_due_ms = $3, updated_at = $4
          WHERE id = $5 AND state = ANY($6::text[]) RETURNING state`,
        [now, reason, now + cadenceFor("TERMINATING"), now, id, SOURCE_STATES.terminate_requested],
      );
      if ((res.rowCount ?? 0) === 0) return false;
      if (failure) {
        await tx.query(
          "UPDATE sessions SET failure_code = $1, failure_message = $2, updated_at = $3 WHERE id = $4",
          [failure.code, failure.message, now, id],
        );
      }
      return true;
    });
  }

  /**
   * TERMINATING -> the terminal state the reason implies.
   *
   * The terminal state is derived in TypeScript from the same
   * `finalStateForReason` the SQLite adapter uses, so the policy stays in one
   * place. `SELECT … FOR UPDATE` is what makes the read-then-write correct under
   * `READ COMMITTED`: a second finalizer blocks on the row, re-reads the
   * committed state, and returns null instead of overwriting.
   */
  async finalizeTermination(id: string): Promise<SessionState | null> {
    return this.conn.tx(async (tx) => {
      const row = await tx.query<{ state: string; termination_reason: string | null }>(
        "SELECT state, termination_reason FROM sessions WHERE id = $1 FOR UPDATE",
        [id],
      );
      const current = row.rows[0];
      if (!current || current.state !== "TERMINATING") return null;
      const final = finalStateForReason(current.termination_reason ?? "");
      const now = Date.now();
      const res = await tx.query<{ state: SessionState }>(
        `UPDATE sessions SET state = $1, destroyed_at = $2, active_request_id = NULL,
            next_due_ms = $3, updated_at = $4
          WHERE id = $5 AND state = ANY($6::text[]) RETURNING state`,
        [final, now, now + cadenceFor(final), now, id, SOURCE_STATES.terminated],
      );
      return res.rows[0]?.state ?? null;
    });
  }

  async requestDestroy(id: string): Promise<void> {
    const now = Date.now();
    await this.conn.write(
      `UPDATE sessions SET destroy_requested = 1, next_due_ms = $1, updated_at = $2
        WHERE id = $3 AND state NOT IN ('EXPIRED','FAILED','DESTROYED')`,
      [now, now, id],
    );
  }

  async markRelayPurged(id: string): Promise<void> {
    const now = Date.now();
    await this.conn.write("UPDATE sessions SET relay_purged_at = $1, updated_at = $2 WHERE id = $3", [
      now,
      now,
      id,
    ]);
  }

  async clearPod(id: string): Promise<void> {
    await this.conn.write("UPDATE sessions SET pod_name = NULL, updated_at = $1 WHERE id = $2", [
      Date.now(),
      id,
    ]);
  }

  /** JSON object merge. The caller filters to finite numbers, so a merge is a concat. */
  async mergeTimings(id: string, patch: Record<string, number | undefined>): Promise<void> {
    const clean: Record<string, number> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
    }
    if (Object.keys(clean).length === 0) return;
    await this.conn.write(
      `UPDATE sessions SET timings_json = (COALESCE(timings_json, '{}')::jsonb || $1::jsonb)::text,
          updated_at = $2 WHERE id = $3`,
      [JSON.stringify(clean), Date.now(), id],
    );
  }

  /** Session id owned by a client key pair, for the double-charge guard. */
  async findByClientNonce(tx: Tx, clientPublicKey: string, clientNonce: string): Promise<string | null> {
    const res = await tx.query<{ id: string }>(
      `SELECT id FROM sessions WHERE client_public_key = $1 AND client_nonce = $2
        ORDER BY created_at ASC LIMIT 1`,
      [clientPublicKey, clientNonce],
    );
    return res.rows[0]?.id ?? null;
  }

  sessionExists(tx: Tx, id: string): Promise<boolean> {
    return tx
      .query("SELECT 1 AS present FROM sessions WHERE id = $1", [id])
      .then((res) => (res.rowCount ?? 0) > 0);
  }

  /** Inside `completeEntitlement`'s transaction only. */
  async insert(tx: Tx, session: SessionRecord): Promise<void> {
    await tx.query(
      `INSERT INTO sessions (
         id, capability_hash, capability_expires_at, client_public_key, client_nonce,
         client_signer, tier, duration_seconds, cpu_millis, memory_mib, disk_mib,
         max_output_bytes, max_file_bytes, max_command_seconds, max_processes,
         state, created_at, paid_at, payment_key, runtime_class, execution_mode,
         runtime, relay_token_hash, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [
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
        session.runtime ?? "base",
        session.relayTokenHash,
        session.updatedAt,
      ],
    );
    await tx.query(
      `UPDATE sessions SET idle_policy_json = $1, max_lifetime_seconds = $2, last_activity_at = $3,
          workspace_pvc = $4, suspended_at = $5, resume_count = $6,
          baseline_cpu_millis = $7, baseline_memory_mib = $8, updated_at = $9
        WHERE id = $10`,
      [
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
      ],
    );
  }

  /** The store's own session read, bound to an open transaction. */
  reader(tx: Tx): (id: string) => Promise<SessionRecord | null> {
    return (id) => this.one(tx, id);
  }
}
