/**
 * Session rows and their guarded transitions, for SQLite.
 *
 * This is deliberately the same slice as `store/postgres/sessions.ts`: the reads
 * the reconciler needs to pick work, and one conditional write per transition,
 * so the two adapters can be read side by side. The prepared statements stay in
 * `statements.ts` and the row shape in `models.ts`.
 *
 * Where the Postgres adapter has to earn every guard from the server
 * (`UPDATE … WHERE state IN (…) RETURNING`), this adapter leans on one
 * connection: the `WHERE state = ...` clauses in the statements are enough
 * because `BEGIN IMMEDIATE` serialises them. The methods here are synchronous.
 * `Store` wraps each one in an `async` port method; the SQLite work is one
 * blocking call and the `async` is the port contract (ADR 0010), not an
 * interleaving point inside a transaction.
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { cadenceFor } from "../reconcile-cadence.js";
import { finalStateForReason } from "@x402s/shared/protocol";
import {
  mapSession,
  type RawSession,
  type SessionRecord,
  type SessionState,
} from "./models.js";

export class SessionRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly stmts: Record<string, StatementSync>,
  ) {}

  /**
   * The synchronous read the async port method and the adapter's own
   * transactions share.
   *
   * `Store.getSession` awaits it, `finalizeTermination` below reads and then
   * writes, and `OperationRepository` takes it as a callback: `claimOperation`
   * holds `BEGIN IMMEDIATE` open and reads the session inside it, so an `await`
   * in the middle would let another request on this connection try to start a
   * second transaction. A Postgres adapter replaces both read-then-write pairs
   * with one guarded statement; until then the read stays inside the adapter,
   * never in a caller.
   */
  read(id: string): SessionRecord | null {
    const row = this.stmts.getSession!.get(id) as RawSession | undefined;
    return row ? mapSession(row) : null;
  }

  listNonTerminal(): SessionRecord[] {
    return (this.stmts.listNonTerminal!.all() as unknown as RawSession[]).map(mapSession);
  }

  /** Live sessions whose next pass is due, earliest first, bounded by `limit`. */
  listDue(nowMs: number, limit: number): SessionRecord[] {
    return (this.stmts.listDue!.all(nowMs, limit) as unknown as RawSession[]).map(mapSession);
  }

  /** Live sessions whose next pass is due right now. */
  countDue(nowMs: number): number {
    return ((this.stmts.countDue!.get(nowMs) as { n: number } | undefined)?.n ?? 0);
  }

  /** Live session counts by state, without materialising rows. */
  countLiveByState(): Partial<Record<SessionState, number>> {
    const counts: Partial<Record<SessionState, number>> = {};
    for (const row of this.stmts.countLiveByState!.all() as Array<{ state: string; n: number }>) {
      counts[row.state as SessionState] = row.n;
    }
    return counts;
  }

  listTerminalWithPod(): SessionRecord[] {
    return (this.stmts.listTerminalWithPod!.all() as unknown as RawSession[]).map(mapSession);
  }

  listTerminalWithPvc(): SessionRecord[] {
    return (this.stmts.listTerminalWithPvc!.all() as unknown as RawSession[]).map(mapSession);
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
  rearmDue(id: string, atMs: number, nowMs: number): boolean {
    return this.stmts.rearmDue!.run(atMs, id, nowMs).changes > 0;
  }

  setProvisioning(id: string, podName: string): boolean {
    const now = Date.now();
    return this.stmts.setProvisioning!.run(podName, now + cadenceFor("PROVISIONING"), now, id).changes > 0;
  }

  /** Replace the pod of a session that is already PROVISIONING (relay restart). */
  setProvisioningPod(id: string, podName: string): boolean {
    return this.stmts.setProvisioningPod!.run(podName, Date.now(), id).changes > 0;
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

  touchActivity(id: string): void {
    const now = Date.now();
    this.stmts.touchActivity!.run(now, now, id);
  }

  markSuspending(id: string): boolean {
    const now = Date.now();
    return this.stmts.markSuspending!.run(now + cadenceFor("SUSPENDING"), now, id).changes > 0;
  }

  markSuspended(id: string, suspendedAt: number): boolean {
    return (
      this.stmts.markSuspended!.run(
        suspendedAt,
        suspendedAt + cadenceFor("SUSPENDED"),
        suspendedAt,
        id,
      ).changes > 0
    );
  }

  markResuming(id: string, podName: string): boolean {
    const now = Date.now();
    return this.stmts.markResuming!.run(podName, now + cadenceFor("RESUMING"), now, id).changes > 0;
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

  requestTermination(
    id: string,
    reason: string,
    failure?: { code: string; message: string },
  ): boolean {
    const now = Date.now();
    // The state write and the failure code are one decision: a crash between
    // two autocommit statements would leave TERMINATING with no failure code.
    // The Postgres adapter wraps the same pair in one transaction. The failure
    // metric is emitted by `Store` after this commits, as on the Postgres facade.
    this.db.exec("BEGIN IMMEDIATE");
    let changed: boolean;
    try {
      changed =
        this.stmts.requestTermination!.run(
          now,
          reason,
          now + cadenceFor("TERMINATING"),
          now,
          id,
        ).changes > 0;
      if (changed && failure) {
        this.stmts.setFailure!.run(failure.code, failure.message, now, id);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return changed;
  }

  /** Terminal state is derived from the termination reason. */
  finalizeTermination(id: string): SessionState | null {
    const session = this.read(id);
    if (!session || session.state !== "TERMINATING") return null;
    const reason = session.terminationReason ?? "";
    const final = finalStateForReason(reason);
    const now = Date.now();
    this.stmts.finalize!.run(final, now, now + cadenceFor(final), now, id);
    return final;
  }

  requestDestroy(id: string): void {
    // Due now: a destroy is an event, not a state that can wait out its cadence.
    const now = Date.now();
    this.stmts.requestDestroy!.run(now, now, id);
  }

  markRelayPurged(id: string): void {
    this.stmts.markRelayPurged!.run(Date.now(), Date.now(), id);
  }

  clearPod(id: string): void {
    this.stmts.clearPod!.run(Date.now(), id);
  }

  /**
   * Atomically merge lifecycle timings (JSON patch semantics).
   *
   * JSON object merge. The caller filters to finite numbers, so a merge is a
   * concat. That is what keeps SQLite's RFC 7396 `json_patch` and Postgres's
   * shallow `||` equivalent; a nested value would make them diverge.
   */
  mergeTimings(id: string, patch: Record<string, number | undefined>): void {
    const clean: Record<string, number> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
    }
    if (Object.keys(clean).length === 0) return;
    this.stmts.mergeTimings!.run(JSON.stringify(clean), Date.now(), id);
  }
}
