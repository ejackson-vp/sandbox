/**
 * Durable reservation repository.
 *
 * SQLite is the single writer. Every admission runs `BEGIN IMMEDIATE`, reloads
 * the active reservations inside the transaction, calls `planAdmission` and the
 * pure capacity model, and inserts the reservation before commit. That closes
 * the read-then-write race between concurrent creates. For multiple controllers
 * this becomes a Postgres/DynamoDB conditional write on the same invariants.
 *
 * The row shape, its mapping and the admission decision are in
 * `reservation-decision.ts`, shared with the Postgres adapter; this file owns
 * the statements, the transaction and the writes.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { admitCapacity } from "./admission.js";
import { planAdmission, reservationFromRow, type ReservationRow } from "./reservation-decision.js";
import type { CapacitySnapshot, SandboxResourceRequest } from "./types.js";
import type {
  AdmitOptions,
  ReservationAdmission,
  ReservationRecord,
  ReservationStore,
} from "./reservation-store.js";

export type {
  AdmitOptions,
  ReservationAdmission,
  ReservationRecord,
} from "./reservation-store.js";

export class ReservationRepository implements ReservationStore {
  private readonly stmts: Record<string, StatementSync>;

  constructor(private readonly db: DatabaseSync) {
    this.stmts = {
      listActive: this.db.prepare("SELECT * FROM reservations WHERE state != 'RELEASED'"),
      listReleasing: this.db.prepare("SELECT * FROM reservations WHERE state = 'RELEASING'"),
      getByPayment: this.db.prepare("SELECT * FROM reservations WHERE payment_key = ?"),
      getBySession: this.db.prepare("SELECT * FROM reservations WHERE session_id = ?"),
      getByWarm: this.db.prepare("SELECT * FROM reservations WHERE warm_id = ?"),
      insert: this.db.prepare(
        `INSERT INTO reservations (
           id, payment_key, session_id, warm_id, spec_hash, node_id, pod_name, state,
           baseline_cpu_millis, baseline_memory_bytes, baseline_storage_bytes,
           peak_cpu_millis, peak_memory_bytes, peak_storage_bytes,
           expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      updateHeld: this.db.prepare(
        `UPDATE reservations SET spec_hash=?, node_id=?, state='HELD', baseline_cpu_millis=?,
           baseline_memory_bytes=?, baseline_storage_bytes=?, peak_cpu_millis=?, peak_memory_bytes=?,
           peak_storage_bytes=?, expires_at=?, updated_at=? WHERE id=?`,
      ),
      attach: this.db.prepare(
        `UPDATE reservations SET payment_key=?, session_id=?, spec_hash=?, node_id=?, state='ALLOCATED',
           baseline_cpu_millis=?, baseline_memory_bytes=?, baseline_storage_bytes=?,
           peak_cpu_millis=?, peak_memory_bytes=?, peak_storage_bytes=?,
           expires_at=NULL, updated_at=? WHERE id=?`,
      ),
      releasePayment: this.db.prepare(
        "UPDATE reservations SET state='RELEASED', updated_at=? WHERE payment_key=? AND state='HELD'",
      ),
      suspend: this.db.prepare(
        "UPDATE reservations SET state='SUSPENDED', pod_name=NULL, expires_at=NULL, updated_at=? WHERE session_id=? AND state != 'RELEASED'",
      ),
      reassertAllocated: this.db.prepare(
        "UPDATE reservations SET state='ALLOCATED', updated_at=? WHERE session_id=? AND state='SUSPENDED'",
      ),
      resume: this.db.prepare(
        `UPDATE reservations SET state='ALLOCATED', node_id=?, pod_name=NULL,
           baseline_cpu_millis=?, baseline_memory_bytes=?, baseline_storage_bytes=?,
           peak_cpu_millis=?, peak_memory_bytes=?, peak_storage_bytes=?,
           expires_at=NULL, updated_at=? WHERE id=? AND state='SUSPENDED'`,
      ),
      beginRelease: this.db.prepare(
        // A SUSPENDED row has no Pod: suspend clears pod_name. A caller can
        // still hold a stale session row naming the pre-suspend Pod, so do not
        // adopt that name. "RELEASING with no pod_name" is the durable marker
        // that compute was already returned; the reaper then confirms the
        // release without waiting on a Pod (issue #72).
        `UPDATE reservations
            SET state='RELEASING',
                pod_name = CASE WHEN state='SUSPENDED' THEN NULL ELSE ? END,
                updated_at=?
          WHERE session_id=? AND state != 'RELEASED'`,
      ),
      confirmRelease: this.db.prepare(
        "UPDATE reservations SET state='RELEASED', pod_name=NULL, updated_at=? WHERE session_id=? AND state='RELEASING'",
      ),
      releaseSession: this.db.prepare(
        "UPDATE reservations SET state='RELEASED', pod_name=NULL, updated_at=? WHERE session_id=? AND state != 'RELEASED'",
      ),
      expireHolds: this.db.prepare(
        "UPDATE reservations SET state='RELEASED', updated_at=? WHERE state='HELD' AND expires_at IS NOT NULL AND expires_at <= ?",
      ),
      updatePod: this.db.prepare(
        "UPDATE reservations SET pod_name=?, updated_at=? WHERE session_id=?",
      ),
      rebindSession: this.db.prepare(
        "UPDATE reservations SET session_id=?, updated_at=? WHERE id=?",
      ),
      setNode: this.db.prepare(
        "UPDATE reservations SET node_id=?, updated_at=? WHERE session_id=? AND state != 'RELEASED'",
      ),
      sessionExists: this.db.prepare("SELECT 1 AS present FROM sessions WHERE id = ?"),
    };
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private activeRows(): ReservationRow[] {
    return this.stmts.listActive!.all() as unknown as ReservationRow[];
  }

  private active(): ReservationRecord[] {
    return this.activeRows().map(reservationFromRow);
  }

  async listActive(): Promise<ReservationRecord[]> {
    return this.active();
  }

  private findExisting(opts: AdmitOptions): ReservationRecord | null {
    const row = opts.paymentKey
      ? (this.stmts.getByPayment!.get(opts.paymentKey) as ReservationRow | undefined)
      : opts.sessionId
        ? (this.stmts.getBySession!.get(opts.sessionId) as ReservationRow | undefined)
        : opts.warmId
          ? (this.stmts.getByWarm!.get(opts.warmId) as ReservationRow | undefined)
          : undefined;
    return row ? reservationFromRow(row) : null;
  }

  /** Caller must hold the write transaction. */
  private admitWithin(
    snapshot: CapacitySnapshot,
    request: SandboxResourceRequest,
    opts: AdmitOptions,
    existing: ReservationRecord | null,
  ): ReservationAdmission {
    const now = snapshot.now;
    const plan = planAdmission(existing, opts, now);

    switch (plan.outcome.kind) {
      case "refuse":
        return {
          admitted: false,
          reason: "invalid_request",
          retryable: false,
          requested: request.baseline,
        };
      case "reuse": {
        const refreshed = this.findExisting(opts);
        if (refreshed) return { admitted: true, reservation: refreshed };
        break;
      }
      case "renew": {
        const held = plan.outcome.existing;
        this.renewHold(held, opts, plan.outcome.expiresAt, now);
        const refreshed = this.findExisting(opts);
        if (refreshed) return { admitted: true, reservation: refreshed };
        break;
      }
      case "admit":
        break;
    }

    const excludeId = plan.outcome.kind === "admit" ? plan.outcome.excludeId : null;
    const active = this.active();
    const accounted =
      excludeId === null ? active : active.filter((reservation) => reservation.id !== excludeId);
    const decision = admitCapacity(
      { ...snapshot, now, reservations: accounted },
      request,
    );
    if (!decision.admitted) return decision;

    const id = existing?.id ?? `res_${randomBytes(12).toString("hex")}`;
    if (existing) {
      this.stmts.updateHeld!.run(
        opts.specHash ?? null,
        decision.nodeId,
        request.baseline.cpuMillicores,
        request.baseline.memoryBytes,
        request.baseline.storageBytes,
        request.peak.cpuMillicores,
        request.peak.memoryBytes,
        request.peak.storageBytes,
        plan.expiresAt,
        now,
        id,
      );
      if (plan.wantsAttach) {
        this.stmts.attach!.run(
          opts.paymentKey ?? null,
          opts.sessionId ?? null,
          opts.specHash ?? null,
          decision.nodeId,
          request.baseline.cpuMillicores,
          request.baseline.memoryBytes,
          request.baseline.storageBytes,
          request.peak.cpuMillicores,
          request.peak.memoryBytes,
          request.peak.storageBytes,
          now,
          id,
        );
      }
    } else {
      this.stmts.insert!.run(
        id,
        opts.paymentKey ?? null,
        opts.sessionId ?? null,
        opts.warmId ?? null,
        opts.specHash ?? null,
        decision.nodeId,
        plan.state,
        request.baseline.cpuMillicores,
        request.baseline.memoryBytes,
        request.baseline.storageBytes,
        request.peak.cpuMillicores,
        request.peak.memoryBytes,
        request.peak.storageBytes,
        plan.expiresAt,
        now,
        now,
      );
    }
    const saved = this.findExisting(opts);
    if (!saved) throw new Error("reservation insert did not round-trip");
    return { admitted: true, reservation: saved };
  }

  /** Extend an unrelated live hold, keeping the resources it already holds. */
  private renewHold(
    held: ReservationRecord,
    opts: AdmitOptions,
    expiresAt: number,
    now: number,
  ): void {
    this.stmts.updateHeld!.run(
      held.specHash ?? opts.specHash ?? null,
      held.nodeId,
      held.baseline.cpuMillicores,
      held.baseline.memoryBytes,
      held.baseline.storageBytes,
      held.peak.cpuMillicores,
      held.peak.memoryBytes,
      held.peak.storageBytes,
      expiresAt,
      now,
      held.id,
    );
  }

  /** Atomically admit and persist. */
  async admit(
    snapshot: CapacitySnapshot,
    request: SandboxResourceRequest,
    opts: AdmitOptions = {},
  ): Promise<ReservationAdmission> {
    return this.tx(() => {
      const existing = this.findExisting(opts);
      return this.admitWithin(snapshot, request, opts, existing);
    });
  }

  /**
   * Convert a payment hold into the paid session's reservation. If the hold is
   * missing (crash/recovery), admit the session directly in the same
   * transaction rather than trusting an in-memory counter.
   */
  async attachToSession(
    snapshot: CapacitySnapshot,
    request: SandboxResourceRequest,
    paymentKey: string,
    sessionId: string,
    specHash: string,
  ): Promise<ReservationAdmission> {
    return this.tx(() => {
      const existing =
        (this.stmts.getByPayment!.get(paymentKey) as ReservationRow | undefined) ??
        (this.stmts.getBySession!.get(sessionId) as ReservationRow | undefined);
      const record = existing ? reservationFromRow(existing) : null;
      if (record && record.sessionId && record.sessionId !== sessionId) {
        const oldSessionExists = Boolean(
          this.stmts.sessionExists!.get(record.sessionId),
        );
        if (oldSessionExists) {
          return {
            admitted: false,
            reason: "invalid_request",
            retryable: false,
            requested: request.baseline,
          };
        }
        // Crash between reservation attach and entitlement insert: the old
        // session id was never durable, so rebind the same reservation.
        this.stmts.rebindSession!.run(sessionId, snapshot.now, record.id);
      }
      return this.admitWithin(
        snapshot,
        request,
        { paymentKey, sessionId, specHash, state: "ALLOCATED" },
        record,
      );
    });
  }

  /** Resume: re-acquire compute on the checkpoint's node, or fail closed. */
  async resume(
    snapshot: CapacitySnapshot,
    request: SandboxResourceRequest,
    sessionId: string,
  ): Promise<ReservationAdmission> {
    return this.tx(() => {
      const row = this.stmts.getBySession!.get(sessionId) as ReservationRow | undefined;
      if (!row) {
        return {
          admitted: false,
          reason: "no_eligible_nodes",
          retryable: true,
          requested: request.baseline,
        };
      }
      const record = reservationFromRow(row);
      if (record.state !== "SUSPENDED") {
        return { admitted: true, reservation: record };
      }
      // Remove the suspended row from accounting; the request re-adds its
      // storage while adding compute back.
      const active = this.active().filter((r) => r.id !== record.id);
      const decision = admitCapacity({ ...snapshot, reservations: active }, request);
      if (!decision.admitted) return decision;
      this.stmts.resume!.run(
        decision.nodeId,
        request.baseline.cpuMillicores,
        request.baseline.memoryBytes,
        request.baseline.storageBytes,
        request.peak.cpuMillicores,
        request.peak.memoryBytes,
        request.peak.storageBytes,
        snapshot.now,
        record.id,
      );
      const saved = this.findExisting({ sessionId });
      if (!saved) throw new Error("reservation resume did not round-trip");
      return { admitted: true, reservation: saved };
    });
  }

  async releasePayment(paymentKey: string): Promise<boolean> {
    return this.stmts.releasePayment!.run(Date.now(), paymentKey).changes > 0;
  }

  async suspendSession(sessionId: string): Promise<boolean> {
    return this.stmts.suspend!.run(Date.now(), sessionId).changes > 0;
  }

  /** Resume was already admitted; undo a concurrent re-suspend of the row. */
  async reassertAllocated(sessionId: string): Promise<boolean> {
    return this.stmts.reassertAllocated!.run(Date.now(), sessionId).changes > 0;
  }

  async beginRelease(sessionId: string, podName: string | null): Promise<boolean> {
    return this.stmts.beginRelease!.run(podName, Date.now(), sessionId).changes > 0;
  }

  async confirmRelease(sessionId: string): Promise<boolean> {
    return this.stmts.confirmRelease!.run(Date.now(), sessionId).changes > 0;
  }

  async releaseSession(sessionId: string): Promise<boolean> {
    return this.stmts.releaseSession!.run(Date.now(), sessionId).changes > 0;
  }

  async updatePod(sessionId: string, podName: string | null): Promise<void> {
    this.stmts.updatePod!.run(podName, Date.now(), sessionId);
  }

  /** Reconcile a planning decision with the node Kubernetes actually chose. */
  async pinNode(sessionId: string, nodeId: string): Promise<boolean> {
    return this.stmts.setNode!.run(nodeId, Date.now(), sessionId).changes > 0;
  }

  async listReleasing(): Promise<ReservationRecord[]> {
    return (this.stmts.listReleasing!.all() as unknown as ReservationRow[]).map(reservationFromRow);
  }

  async getBySession(sessionId: string): Promise<ReservationRecord | null> {
    const row = this.stmts.getBySession!.get(sessionId) as ReservationRow | undefined;
    return row ? reservationFromRow(row) : null;
  }

  async getByPayment(paymentKey: string): Promise<ReservationRecord | null> {
    const row = this.stmts.getByPayment!.get(paymentKey) as ReservationRow | undefined;
    return row ? reservationFromRow(row) : null;
  }

  /** Expire unused provisional holds; called by housekeeping. */
  async reapExpiredHolds(now: number): Promise<number> {
    return Number(this.stmts.expireHolds!.run(now, now).changes ?? 0);
  }


}
