/**
 * The single-operation gate, restart recovery, and the exec-request rows.
 *
 * Extracted from `Store` because it is the one part of the adapter that owns a
 * transaction *and* a read inside it: `claimOperation` reloads the session,
 * checks five conditions and then writes, and all of that has to happen without
 * another task on this connection slipping in between (that is why the read is a
 * callback into the store rather than the async port method).
 *
 * The methods here are deliberately synchronous. `Store` wraps each one in an
 * `async` port method; the SQLite work is one blocking call and the `async` is
 * there to satisfy the port, not to add an interleaving point inside a
 * transaction. A Postgres adapter replaces each of these with one guarded
 * statement and no read-then-write pair at all.
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { SOURCE_STATES } from "@x402s/shared/protocol";
import { cadenceFor } from "../reconcile-cadence.js";
import {
  mapSession,
  type ClaimOperationResult,
  type ExecRequestRecord,
  type RawSession,
  type SessionRecord,
} from "./models.js";

export class OperationRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly stmts: Record<string, StatementSync>,
    /** The store's own synchronous session read; see the class comment. */
    private readonly readSession: (id: string) => SessionRecord | null,
  ) {}

  /**
   * Startup recovery: the previous controller process may have died with an
   * operation in flight. Its outcome is unknown, so the request becomes
   * `outcome_unknown` and its session keeps the single-operation gate closed.
   *
   * The session's execution epoch is bumped in the same transaction. The gate
   * is released only by `clearFencedGate` after the relay reports that the
   * guest no longer has that request active (see OperationFence). Recovery
   * publishes the new epoch to the relay before the fence can clear: the relay
   * then refuses frames from an older generation and withdraws one that was
   * forwarded but never observed, so it cannot start at the guest afterwards.
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
    const now = Date.now();
    return (
      this.stmts.clearFencedGate!.run(
        now + cadenceFor("READY"),
        now,
        sessionId,
        requestId,
        epoch,
      ).changes > 0
    );
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
      const session = this.readSession(sessionId);
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
      this.stmts.claimActive!.run(requestId, now + cadenceFor("ACTIVE"), now, sessionId);
      this.db.exec("COMMIT");
      return { ok: true, requestId, epoch: session.execEpoch };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  finishOperation(
    sessionId: string,
    requestId: string,
    outcome: "done" | "error" | "abandoned",
  ): void {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // A caller may have read this request as pending before a controller
      // restart fenced it. Recovery owns that request now; a stale finish must
      // not clear the gate or overwrite `outcome_unknown`.
      const finished = this.stmts.finishRequest!.run(outcome, now, sessionId, requestId).changes;
      if (finished > 0) this.stmts.clearActive!.run(now + cadenceFor("READY"), now, sessionId, requestId);
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
