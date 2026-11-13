/**
 * The single-operation gate, restart recovery and exec requests, for Postgres.
 *
 * `claimOperation` is the one place the previous single-connection adapter
 * relied on holding a transaction open across a read: it reloaded the session,
 * checked five conditions and wrote, all inside one serialised transaction. Here
 * the gate itself is the guard. A single conditional UPDATE claims the slot:
 *
 *   UPDATE sessions SET active_request_id = $1, state = CASE WHEN state = 'READY'
 *          THEN 'ACTIVE' ELSE state END, …
 *    WHERE id = $2 AND active_request_id IS NULL AND state = ANY($3) …
 *   RETURNING exec_epoch, state
 *
 * Zero rows means someone else holds the gate, the state moved on, or the lease
 * expired; the transaction rolls back the request row and the caller re-reads to
 * say which. The cheap classifications are made before the write so the refusal
 * codes keep the same precedence as before.
 */
import { SOURCE_STATES } from "@x402s/shared/protocol";
import { cadenceFor } from "../../reconcile-cadence.js";
import {
  mapSession,
  payloadDiffers,
  persistableResultEnvelope,
  SESSION_COLUMNS,
  type ClaimOperationResult,
  type ExecRequestRecord,
  type RawSession,
  type SessionRecord,
} from "../models.js";
import { RolledBack, type PgConnection, type Tx } from "./pg.js";

export class PgOperationRepository {
  constructor(private readonly conn: PgConnection) {}

  /**
   * Startup recovery. Runs only while this process holds the writer lock, so two
   * recoveries cannot interleave; the epoch bump is in any case the fence, and a
   * second bump only invalidates frames from a generation that is already gone.
   */
  async recoverInterruptedOperations(): Promise<{ requests: number; sessions: number }> {
    return this.conn.tx(async (tx) => {
      const now = Date.now();
      const requests = await tx.query(
        "UPDATE exec_requests SET state = 'outcome_unknown', updated_at = $1 WHERE state = 'pending'",
        [now],
      );
      const sessions = await tx.query(
        "UPDATE sessions SET exec_epoch = exec_epoch + 1, updated_at = $1 WHERE active_request_id IS NOT NULL",
        [now],
      );
      return {
        requests: Number(requests.rowCount ?? 0),
        sessions: Number(sessions.rowCount ?? 0),
      };
    });
  }

  async listFencedSessions(): Promise<SessionRecord[]> {
    const res = await this.conn.query<RawSession>(
      `SELECT ${SESSION_COLUMNS} FROM sessions s
        WHERE s.active_request_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM exec_requests r
            WHERE r.session_id = s.id AND r.id = s.active_request_id AND r.state = 'outcome_unknown'
          )`,
    );
    return res.rows.map(mapSession);
  }

  /**
   * Sessions whose guest link the relay owns. A READY/ACTIVE session with a
   * credential and a Pod is the set the relay-recovery scan must cover: those
   * are the ones a relay restart would otherwise strand. `after` is the scan's
   * cursor, so a page larger than the per-pass limit is still covered over
   * successive passes instead of starving the tail.
   */
  async listRelaySessions(limit: number, after: string | null = null): Promise<SessionRecord[]> {
    const res = await this.conn.query<RawSession>(
      `SELECT ${SESSION_COLUMNS} FROM sessions
        WHERE state IN ('READY', 'ACTIVE')
          AND relay_token_hash IS NOT NULL
          AND pod_name IS NOT NULL
          AND ($2::text IS NULL OR id > $2)
        ORDER BY id
        LIMIT $1`,
      [Math.max(1, Math.trunc(limit)), after],
    );
    return res.rows.map(mapSession);
  }

  /**
   * Fence one session's interrupted operation after a relay generation change.
   *
   * The transition `pending -> outcome_unknown` is the guard, so this is
   * exactly once: the caller that wins it bumps the session epoch, and a
   * second scan of the same session finds nothing pending and changes nothing.
   * Only the request actually holding the gate is fenced; a request row that is
   * pending while the gate is free is left to the normal finish path.
   */
  async recoverSessionOperation(
    sessionId: string,
  ): Promise<{ requestId: string | null; epoch: number | null }> {
    return this.conn.tx(async (tx) => {
      const now = Date.now();
      const fenced = await tx.query<{ id: string }>(
        `UPDATE exec_requests r
            SET state = 'outcome_unknown', updated_at = $1
           FROM sessions s
          WHERE s.id = $2
            AND s.active_request_id = r.id
            AND r.session_id = s.id
            AND r.state = 'pending'
          RETURNING r.id`,
        [now, sessionId],
      );
      const requestId = fenced.rows[0]?.id ?? null;
      if (!requestId) {
        // Nothing pending: either the gate is free or the request was fenced by
        // an earlier recovery. `null` epoch means "no transition happened", so
        // a caller cannot mistake this for a second bump.
        return { requestId: null, epoch: null };
      }
      const bumped = await tx.query<{ exec_epoch: number }>(
        `UPDATE sessions SET exec_epoch = exec_epoch + 1, updated_at = $1
          WHERE id = $2 AND active_request_id = $3
          RETURNING exec_epoch`,
        [now, sessionId, requestId],
      );
      return { requestId, epoch: bumped.rows[0]?.exec_epoch ?? null };
    });
  }

  async clearFencedGate(sessionId: string, requestId: string, epoch: number): Promise<boolean> {
    const now = Date.now();
    const res = await this.conn.write(
      `UPDATE sessions
          SET active_request_id = NULL,
              state = CASE WHEN state = 'ACTIVE' THEN 'READY' ELSE state END,
              next_due_ms = $1, updated_at = $2
        WHERE id = $3 AND active_request_id = $4 AND exec_epoch = $5
        RETURNING state`,
      [now + cadenceFor("READY"), now, sessionId, requestId, epoch],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async claimOperation(
    sessionId: string,
    requestId: string,
    op: string,
    payloadHash: string | null = null,
  ): Promise<ClaimOperationResult> {
    const now = Date.now();
    try {
      return await this.conn.tx<ClaimOperationResult>(async (tx) => {
        const session = await this.read(tx, sessionId);
        if (!session) return { ok: false, code: "not_usable", state: "FAILED" };
        if (!SOURCE_STATES.operation_started.includes(session.state)) {
          return { ok: false, code: "not_usable", state: session.state };
        }
        if (session.leaseExpiresAt !== null && now >= session.leaseExpiresAt) {
          return { ok: false, code: "lease_expired", state: session.state };
        }

        const inserted = await tx.query(
          `INSERT INTO exec_requests (id, session_id, op, state, epoch, payload_hash, created_at, updated_at)
           VALUES ($1, $2, $3, 'pending', $4, $5, $6, $6)
           ON CONFLICT (session_id, id) DO NOTHING
           RETURNING id`,
          [requestId, sessionId, op, session.execEpoch, payloadHash, now],
        );
        if ((inserted.rowCount ?? 0) === 0) {
          // The first claim owns the id. Read its state and payload back.
          const existing = await tx.query<{ payload_hash: string | null; state: string }>(
            "SELECT payload_hash, state FROM exec_requests WHERE session_id = $1 AND id = $2",
            [sessionId, requestId],
          );
          const row = existing.rows[0];
          // A fenced request is answered with its outcome, not with the
          // idempotency-key verdict: the id is spent either way, and the client
          // must learn that the operation's outcome is unknown. Reporting
          // `idempotency_key_reused` there hides the only answer it can act on.
          if (row?.state === "outcome_unknown") {
            return { ok: false, code: "duplicate", state: session.state, requestId };
          }
          const stored = row?.payload_hash ?? null;
          if (payloadDiffers(stored, payloadHash)) {
            return { ok: false, code: "idempotency_key_reused", state: session.state, requestId };
          }
          return { ok: false, code: "duplicate", state: session.state, requestId };
        }

        const claimed = await tx.query<{ exec_epoch: number }>(
          `UPDATE sessions
              SET active_request_id = $1,
                  state = CASE WHEN state = 'READY' THEN 'ACTIVE' ELSE state END,
                  next_due_ms = $2, updated_at = $3
            WHERE id = $4 AND active_request_id IS NULL AND state = ANY($5::text[])
            RETURNING exec_epoch`,
          [requestId, now + cadenceFor("ACTIVE"), now, sessionId, SOURCE_STATES.operation_started],
        );
        if ((claimed.rowCount ?? 0) === 0) {
          // Roll the request row back and report why the gate was refused.
          const after = await this.read(tx, sessionId);
          throw new RolledBack<ClaimOperationResult>(this.refusal(after ?? session));
        }
        return { ok: true, requestId, epoch: session.execEpoch };
      });
    } catch (err) {
      if (err instanceof RolledBack) return err.value as ClaimOperationResult;
      throw err;
    }
  }

  private refusal(session: SessionRecord): ClaimOperationResult {
    if (session.activeRequestId) {
      return { ok: false, code: "busy", state: session.state, requestId: session.activeRequestId };
    }
    return { ok: false, code: "not_usable", state: session.state };
  }

  async finishOperation(
    sessionId: string,
    requestId: string,
    outcome: "done" | "error" | "abandoned" | "outcome_unknown",
    resultEnvelope?: string | null,
  ): Promise<void> {
    // One bound and one rule: too large is stored as
    // NULL, never truncated.
    const envelope = persistableResultEnvelope(resultEnvelope);
    await this.conn.tx(async (tx) => {
      const now = Date.now();
      // A request fenced by restart recovery is `outcome_unknown`, not `pending`,
      // so a stale finish matches nothing and leaves the gate closed.
      // `COALESCE` keeps an envelope the row already has, so a finish without one
      // cannot erase a stored result.
      const finished = await tx.query(
        `UPDATE exec_requests
            SET state = $1, result_envelope = COALESCE($2, result_envelope), updated_at = $3
          WHERE session_id = $4 AND id = $5 AND state = 'pending' RETURNING id`,
        [outcome, envelope, now, sessionId, requestId],
      );
      if ((finished.rowCount ?? 0) === 0) return;
      // `outcome_unknown` fences the gate, it does not release it: the guest may
      // still be running the command or reconnecting, so only
      // `OperationFence`/relay recovery may clear `active_request_id` after the
      // guest reports idle. Every other outcome is the end of the operation.
      if (outcome === "outcome_unknown") return;
      await tx.query(
        `UPDATE sessions
            SET active_request_id = NULL,
                state = CASE WHEN state = 'ACTIVE' THEN 'READY' ELSE state END,
                next_due_ms = $1, updated_at = $2
          WHERE id = $3 AND active_request_id = $4`,
        [now + cadenceFor("READY"), now, sessionId, requestId],
      );
    });
  }

  async getExecRequest(sessionId: string, requestId: string): Promise<ExecRequestRecord | null> {
    const res = await this.conn.query<Record<string, unknown>>(
      "SELECT * FROM exec_requests WHERE session_id = $1 AND id = $2",
      [sessionId, requestId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      op: row.op as string,
      state: row.state as ExecRequestRecord["state"],
      payloadHash: (row.payload_hash as string | null) ?? null,
      resultEnvelope: (row.result_envelope as string | null) ?? null,
      epoch: row.epoch as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  private async read(tx: Tx, id: string): Promise<SessionRecord | null> {
    const res = await tx.query<RawSession>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = $1`, [id]);
    return res.rows[0] ? mapSession(res.rows[0]) : null;
  }
}
