/**
 * Durable reservations, for Postgres.
 *
 * The invariant is unchanged from SQLite: the accounting snapshot and the insert
 * must agree, so admission cannot be "read the reservations, decide, insert"
 * across two transactions. SQLite gets that from `BEGIN IMMEDIATE`; here a
 * transaction-scoped advisory lock (`CAPACITY_LOCK_KEY`) serialises admission
 * across controllers, which is the only way to make a *count of rows* stable
 * under `READ COMMITTED`. The per-identity uniqueness (`payment_key`,
 * `session_id`, `warm_id`) also exists as a UNIQUE constraint, so a bug in the
 * lock still cannot produce two reservations for one payment.
 */
import { randomBytes } from "node:crypto";
import { admitCapacity } from "../../capacity/admission.js";
import type {
  CapacitySnapshot,
  ResourceVector,
  ReservationState,
  SandboxResourceRequest,
} from "../../capacity/types.js";
import type {
  AdmitOptions,
  ReservationAdmission,
  ReservationRecord,
  ReservationStore,
} from "../../capacity/reservation-store.js";
import { CAPACITY_LOCK_KEY, type PgConnection, type Tx } from "./pg.js";

interface ReservationRow {
  id: string;
  payment_key: string | null;
  session_id: string | null;
  warm_id: string | null;
  spec_hash: string | null;
  node_id: string;
  pod_name: string | null;
  state: ReservationState;
  baseline_cpu_millis: number;
  baseline_memory_bytes: number;
  baseline_storage_bytes: number;
  peak_cpu_millis: number;
  peak_memory_bytes: number;
  peak_storage_bytes: number;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

function vectorOf(row: ReservationRow): ResourceVector {
  return {
    cpuMillicores: row.baseline_cpu_millis,
    memoryBytes: row.baseline_memory_bytes,
    storageBytes: row.baseline_storage_bytes,
  };
}

function peakOf(row: ReservationRow): ResourceVector {
  return {
    cpuMillicores: row.peak_cpu_millis,
    memoryBytes: row.peak_memory_bytes,
    storageBytes: row.peak_storage_bytes,
  };
}

function mapRow(row: ReservationRow): ReservationRecord {
  return {
    id: row.id,
    paymentKey: row.payment_key,
    sessionId: row.session_id,
    specHash: row.spec_hash,
    nodeId: row.node_id,
    podName: row.pod_name,
    state: row.state,
    baseline: vectorOf(row),
    peak: peakOf(row),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = `id, payment_key, session_id, warm_id, spec_hash, node_id, pod_name, state,
  baseline_cpu_millis, baseline_memory_bytes, baseline_storage_bytes,
  peak_cpu_millis, peak_memory_bytes, peak_storage_bytes,
  expires_at, created_at, updated_at`;

export class PgReservationRepository implements ReservationStore {
  constructor(private readonly conn: PgConnection) {}

  private async rows(q: Tx | PgConnection, text: string, values: unknown[] = []): Promise<ReservationRow[]> {
    const res = await q.query<ReservationRow>(text, values);
    return res.rows;
  }

  private async active(tx: Tx): Promise<ReservationRecord[]> {
    return (await this.rows(tx, "SELECT * FROM reservations WHERE state <> 'RELEASED'")).map(mapRow);
  }

  private async findExisting(tx: Tx, opts: AdmitOptions): Promise<ReservationRecord | null> {
    const [column, value] = opts.paymentKey
      ? ["payment_key", opts.paymentKey]
      : opts.sessionId
        ? ["session_id", opts.sessionId]
        : opts.warmId
          ? ["warm_id", opts.warmId]
          : [null, null];
    if (column === null) return null;
    const found = await this.rows(tx, `SELECT * FROM reservations WHERE ${column} = $1`, [value]);
    return found[0] ? mapRow(found[0]) : null;
  }

  private async updateHeld(
    tx: Tx,
    id: string,
    request: SandboxResourceRequest,
    nodeId: string,
    now: number,
    expiresAt: number | null,
    specHash: string | null,
  ): Promise<void> {
    await tx.query(
      `UPDATE reservations
          SET spec_hash = $1, node_id = $2, state = 'HELD', baseline_cpu_millis = $3,
              baseline_memory_bytes = $4, baseline_storage_bytes = $5, peak_cpu_millis = $6,
              peak_memory_bytes = $7, peak_storage_bytes = $8, expires_at = $9, updated_at = $10
        WHERE id = $11`,
      [
        specHash,
        nodeId,
        request.baseline.cpuMillicores,
        request.baseline.memoryBytes,
        request.baseline.storageBytes,
        request.peak.cpuMillicores,
        request.peak.memoryBytes,
        request.peak.storageBytes,
        expiresAt,
        now,
        id,
      ],
    );
  }

  private async attach(
    tx: Tx,
    id: string,
    opts: AdmitOptions,
    request: SandboxResourceRequest,
    nodeId: string,
    now: number,
  ): Promise<void> {
    await tx.query(
      `UPDATE reservations
          SET payment_key = $1, session_id = $2, spec_hash = $3, node_id = $4, state = 'ALLOCATED',
              baseline_cpu_millis = $5, baseline_memory_bytes = $6, baseline_storage_bytes = $7,
              peak_cpu_millis = $8, peak_memory_bytes = $9, peak_storage_bytes = $10,
              expires_at = NULL, updated_at = $11
        WHERE id = $12`,
      [
        opts.paymentKey ?? null,
        opts.sessionId ?? null,
        opts.specHash ?? null,
        nodeId,
        request.baseline.cpuMillicores,
        request.baseline.memoryBytes,
        request.baseline.storageBytes,
        request.peak.cpuMillicores,
        request.peak.memoryBytes,
        request.peak.storageBytes,
        now,
        id,
      ],
    );
  }

  /** Caller holds the transaction and therefore the capacity lock. */
  private async admitWithin(
    tx: Tx,
    snapshot: CapacitySnapshot,
    request: SandboxResourceRequest,
    opts: AdmitOptions,
    existing: ReservationRecord | null,
  ): Promise<ReservationAdmission> {
    const now = snapshot.now;
    const ttlMs = opts.ttlMs ?? 120_000;
    const state: "HELD" | "ALLOCATED" = opts.state ?? (opts.sessionId ? "ALLOCATED" : "HELD");

    const wantsAttach = state === "ALLOCATED" || Boolean(opts.sessionId);
    let replacingExisting = false;
    if (existing && existing.state !== "RELEASED") {
      const alreadyAttached = wantsAttach && existing.state !== "HELD";
      const expiredHold =
        existing.state === "HELD" && existing.expiresAt !== null && existing.expiresAt <= now;
      if (expiredHold) {
        replacingExisting = true;
      } else if (opts.specHash && existing.specHash && existing.specHash !== opts.specHash) {
        return {
          admitted: false,
          reason: "invalid_request",
          retryable: false,
          requested: request.baseline,
        };
      } else if (alreadyAttached) {
        const refreshed = await this.findExisting(tx, opts);
        if (refreshed) return { admitted: true, reservation: refreshed };
      } else if (wantsAttach) {
        replacingExisting = true;
      } else {
        await this.updateHeld(
          tx,
          existing.id,
          request,
          existing.nodeId,
          now,
          now + ttlMs,
          existing.specHash ?? opts.specHash ?? null,
        );
        const refreshed = await this.findExisting(tx, opts);
        if (refreshed) return { admitted: true, reservation: refreshed };
      }
    }

    const active = replacingExisting
      ? (await this.active(tx)).filter((reservation) => reservation.id !== existing?.id)
      : await this.active(tx);
    const decision = admitCapacity({ ...snapshot, now, reservations: active }, request);
    if (!decision.admitted) return decision;

    const id = existing?.id ?? `res_${randomBytes(12).toString("hex")}`;
    const expiresAt = state === "HELD" ? now + ttlMs : null;
    if (existing) {
      await this.updateHeld(tx, id, request, decision.nodeId, now, expiresAt, opts.specHash ?? null);
      if (wantsAttach) {
        await this.attach(tx, id, opts, request, decision.nodeId, now);
      }
    } else {
      await tx.query(
        `INSERT INTO reservations (${COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
        [
          id,
          opts.paymentKey ?? null,
          opts.sessionId ?? null,
          opts.warmId ?? null,
          opts.specHash ?? null,
          decision.nodeId,
          state,
          request.baseline.cpuMillicores,
          request.baseline.memoryBytes,
          request.baseline.storageBytes,
          request.peak.cpuMillicores,
          request.peak.memoryBytes,
          request.peak.storageBytes,
          expiresAt,
          now,
        ],
      );
    }
    const saved = await this.findExisting(tx, opts);
    if (!saved) throw new Error("reservation insert did not round-trip");
    return { admitted: true, reservation: saved };
  }

  async admit(
    snapshot: CapacitySnapshot,
    request: SandboxResourceRequest,
    opts: AdmitOptions = {},
  ): Promise<ReservationAdmission> {
    return this.conn.tx(async (tx) => {
      await tx.serialise(CAPACITY_LOCK_KEY);
      const existing = await this.findExisting(tx, opts);
      return this.admitWithin(tx, snapshot, request, opts, existing);
    });
  }

  async attachToSession(
    snapshot: CapacitySnapshot,
    request: SandboxResourceRequest,
    paymentKey: string,
    sessionId: string,
    specHash: string,
  ): Promise<ReservationAdmission> {
    return this.conn.tx(async (tx) => {
      await tx.serialise(CAPACITY_LOCK_KEY);
      const byPayment = await this.rows(tx, "SELECT * FROM reservations WHERE payment_key = $1", [
        paymentKey,
      ]);
      const bySession = await this.rows(tx, "SELECT * FROM reservations WHERE session_id = $1", [
        sessionId,
      ]);
      const existingRow = byPayment[0] ?? bySession[0];
      const record = existingRow ? mapRow(existingRow) : null;
      if (record && record.sessionId && record.sessionId !== sessionId) {
        const oldExists = await tx.query("SELECT 1 AS present FROM sessions WHERE id = $1", [
          record.sessionId,
        ]);
        if ((oldExists.rowCount ?? 0) > 0) {
          return {
            admitted: false,
            reason: "invalid_request",
            retryable: false,
            requested: request.baseline,
          };
        }
        // Crash between attach and entitlement insert: rebind the same row.
        await tx.query("UPDATE reservations SET session_id = $1, updated_at = $2 WHERE id = $3", [
          sessionId,
          snapshot.now,
          record.id,
        ]);
      }
      return this.admitWithin(
        tx,
        snapshot,
        request,
        { paymentKey, sessionId, specHash, state: "ALLOCATED" },
        record,
      );
    });
  }

  async resume(
    snapshot: CapacitySnapshot,
    request: SandboxResourceRequest,
    sessionId: string,
  ): Promise<ReservationAdmission> {
    return this.conn.tx(async (tx) => {
      await tx.serialise(CAPACITY_LOCK_KEY);
      const found = await this.rows(tx, "SELECT * FROM reservations WHERE session_id = $1", [sessionId]);
      const row = found[0];
      if (!row) {
        return {
          admitted: false,
          reason: "no_eligible_nodes",
          retryable: true,
          requested: request.baseline,
        };
      }
      const record = mapRow(row);
      if (record.state !== "SUSPENDED") {
        return { admitted: true, reservation: record };
      }
      const active = (await this.active(tx)).filter((r) => r.id !== record.id);
      const decision = admitCapacity({ ...snapshot, reservations: active }, request);
      if (!decision.admitted) return decision;
      const updated = await tx.query(
        `UPDATE reservations
            SET state = 'ALLOCATED', node_id = $1, pod_name = NULL, baseline_cpu_millis = $2,
                baseline_memory_bytes = $3, baseline_storage_bytes = $4, peak_cpu_millis = $5,
                peak_memory_bytes = $6, peak_storage_bytes = $7, expires_at = NULL, updated_at = $8
          WHERE id = $9 AND state = 'SUSPENDED'
          RETURNING id`,
        [
          decision.nodeId,
          request.baseline.cpuMillicores,
          request.baseline.memoryBytes,
          request.baseline.storageBytes,
          request.peak.cpuMillicores,
          request.peak.memoryBytes,
          request.peak.storageBytes,
          snapshot.now,
          record.id,
        ],
      );
      if ((updated.rowCount ?? 0) === 0) {
        const current = await this.byId(tx, record.id);
        if (current) return { admitted: true, reservation: current };
        return { admitted: false, reason: "no_eligible_nodes", retryable: true, requested: request.baseline };
      }
      const saved = await this.byId(tx, record.id);
      if (!saved) throw new Error("reservation resume did not round-trip");
      return { admitted: true, reservation: saved };
    });
  }

  private async byId(tx: Tx, id: string): Promise<ReservationRecord | null> {
    const found = await this.rows(tx, "SELECT * FROM reservations WHERE id = $1", [id]);
    return found[0] ? mapRow(found[0]) : null;
  }

  async listActive(): Promise<ReservationRecord[]> {
    return (await this.rows(this.conn, "SELECT * FROM reservations WHERE state <> 'RELEASED'")).map(mapRow);
  }

  async listReleasing(): Promise<ReservationRecord[]> {
    return (await this.rows(this.conn, "SELECT * FROM reservations WHERE state = 'RELEASING'")).map(mapRow);
  }

  async getBySession(sessionId: string): Promise<ReservationRecord | null> {
    const found = await this.rows(this.conn, "SELECT * FROM reservations WHERE session_id = $1", [
      sessionId,
    ]);
    return found[0] ? mapRow(found[0]) : null;
  }

  async getByPayment(paymentKey: string): Promise<ReservationRecord | null> {
    const found = await this.rows(this.conn, "SELECT * FROM reservations WHERE payment_key = $1", [
      paymentKey,
    ]);
    return found[0] ? mapRow(found[0]) : null;
  }

  async releasePayment(paymentKey: string): Promise<boolean> {
    const res = await this.conn.write(
      `UPDATE reservations SET state = 'RELEASED', updated_at = $1
        WHERE payment_key = $2 AND state = 'HELD'`,
      [Date.now(), paymentKey],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async suspendSession(sessionId: string): Promise<boolean> {
    const res = await this.conn.write(
      `UPDATE reservations SET state = 'SUSPENDED', pod_name = NULL, expires_at = NULL, updated_at = $1
        WHERE session_id = $2 AND state <> 'RELEASED'`,
      [Date.now(), sessionId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async reassertAllocated(sessionId: string): Promise<boolean> {
    const res = await this.conn.write(
      `UPDATE reservations SET state = 'ALLOCATED', updated_at = $1
        WHERE session_id = $2 AND state = 'SUSPENDED'`,
      [Date.now(), sessionId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async beginRelease(sessionId: string, podName: string | null): Promise<boolean> {
    const res = await this.conn.write(
      `UPDATE reservations
          SET state = 'RELEASING',
              pod_name = CASE WHEN state = 'SUSPENDED' THEN NULL ELSE $1 END,
              updated_at = $2
        WHERE session_id = $3 AND state <> 'RELEASED'`,
      [podName, Date.now(), sessionId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async confirmRelease(sessionId: string): Promise<boolean> {
    const res = await this.conn.write(
      `UPDATE reservations SET state = 'RELEASED', pod_name = NULL, updated_at = $1
        WHERE session_id = $2 AND state = 'RELEASING'`,
      [Date.now(), sessionId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async releaseSession(sessionId: string): Promise<boolean> {
    const res = await this.conn.write(
      `UPDATE reservations SET state = 'RELEASED', pod_name = NULL, updated_at = $1
        WHERE session_id = $2 AND state <> 'RELEASED'`,
      [Date.now(), sessionId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async updatePod(sessionId: string, podName: string | null): Promise<void> {
    await this.conn.write("UPDATE reservations SET pod_name = $1, updated_at = $2 WHERE session_id = $3", [
      podName,
      Date.now(),
      sessionId,
    ]);
  }

  async pinNode(sessionId: string, nodeId: string): Promise<boolean> {
    const res = await this.conn.write(
      `UPDATE reservations SET node_id = $1, updated_at = $2
        WHERE session_id = $3 AND state <> 'RELEASED'`,
      [nodeId, Date.now(), sessionId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async reapExpiredHolds(now: number): Promise<number> {
    const res = await this.conn.write(
      `UPDATE reservations SET state = 'RELEASED', updated_at = $1
        WHERE state = 'HELD' AND expires_at IS NOT NULL AND expires_at <= $1`,
      [now],
    );
    return Number(res.rowCount ?? 0);
  }
}
