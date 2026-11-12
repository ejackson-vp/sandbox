/**
 * Admission of one reservation, shared by the SQLite and Postgres adapters.
 *
 * Pure: no SQL, no clock, no I/O. The adapter reads the row stored for this
 * identity, hands it here with `now`, and persists what comes back. Which
 * request is refused, which hold is extended, and which reservation leaves the
 * accounting snapshot are therefore decided once instead of twice, so the two
 * adapters cannot drift on a decision that moves capacity.
 *
 * The row shape and its mapping live here too: they are the input to that
 * decision and are identical in both dialects.
 */
import type { ResourceVector, ReservationState } from "./types.js";
import type { AdmitOptions, ReservationRecord } from "./reservation-store.js";

/** A `reservations` row exactly as both adapters select it. */
export interface ReservationRow {
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

export function reservationFromRow(row: ReservationRow): ReservationRecord {
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

const DEFAULT_TTL_MS = 120_000;

/** What the caller does with the row it found for this identity. */
export type ExistingOutcome =
  /** A different spec on the same identity: invalid_request, nothing written. */
  | { kind: "refuse" }
  /** Already attached to this session: re-read the row and answer with it. */
  | { kind: "reuse" }
  /** An unrelated live hold: extend it to `expiresAt`, then re-read and answer. */
  | { kind: "renew"; existing: ReservationRecord; expiresAt: number }
  /** Admit against the snapshot, excluding `excludeId` from the accounting. */
  | { kind: "admit"; excludeId: string | null };

export interface AdmissionPlan {
  /** `HELD` while provisional, `ALLOCATED` once a session owns it. */
  state: "HELD" | "ALLOCATED";
  /** Whether the row must be attached to a session as well as updated. */
  wantsAttach: boolean;
  /** TTL to write on the row; null for an `ALLOCATED` row. */
  expiresAt: number | null;
  outcome: ExistingOutcome;
}

/**
 * Classify the row already stored for this identity, or plan a fresh one.
 *
 * `excludeId` is the row that must leave the accounting snapshot: an expired
 * hold, or a hold being promoted to a session reservation. Those are the only
 * two cases where the create does not add capacity on top of what is stored.
 */
export function planAdmission(
  existing: ReservationRecord | null,
  opts: AdmitOptions,
  now: number,
): AdmissionPlan {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const state: "HELD" | "ALLOCATED" = opts.state ?? (opts.sessionId ? "ALLOCATED" : "HELD");
  const wantsAttach = state === "ALLOCATED" || Boolean(opts.sessionId);
  const expiresAt = state === "HELD" ? now + ttlMs : null;
  const plan = { state, wantsAttach, expiresAt };

  if (existing && existing.state !== "RELEASED") {
    const expiredHold =
      existing.state === "HELD" && existing.expiresAt !== null && existing.expiresAt <= now;
    const alreadyAttached = wantsAttach && existing.state !== "HELD";
    if (expiredHold) {
      return { ...plan, outcome: { kind: "admit", excludeId: existing.id } };
    }
    if (opts.specHash && existing.specHash && existing.specHash !== opts.specHash) {
      return { ...plan, outcome: { kind: "refuse" } };
    }
    if (alreadyAttached) {
      return { ...plan, outcome: { kind: "reuse" } };
    }
    if (wantsAttach) {
      // Convert the HELD row into the session reservation below. Exclude it
      // from the accounting snapshot so the transfer is not double-counted.
      return { ...plan, outcome: { kind: "admit", excludeId: existing.id } };
    }
    // Reached only when this create is not an attach, so `state` is HELD and
    // the hold TTL equals `plan.expiresAt`.
    return { ...plan, outcome: { kind: "renew", existing, expiresAt: now + ttlMs } };
  }

  return { ...plan, outcome: { kind: "admit", excludeId: null } };
}
