/**
 * Reservation store port.
 *
 * The controller depends on this interface, not on SQLite. A multi-controller
 * deployment can supply a conditional-write adapter (Postgres, DynamoDB) with
 * the same admission contract; the SQLite adapter is the single-writer local
 * implementation.
 */
import type {
  AdmissionDecision,
  CapacityReservation,
  CapacitySnapshot,
  SandboxResourceRequest,
} from "./types.js";

export interface ReservationRecord extends CapacityReservation {
  paymentKey: string | null;
  specHash: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ReservationAdmission =
  | { admitted: true; reservation: ReservationRecord; reused: boolean }
  | Extract<AdmissionDecision, { admitted: false }>;

export interface AdmitOptions {
  paymentKey?: string;
  sessionId?: string;
  warmId?: string;
  specHash?: string;
  ttlMs?: number;
  state?: "HELD" | "ALLOCATED";
}

export interface ReservationStore {
  admit(
    snapshot: CapacitySnapshot,
    request: SandboxResourceRequest,
    opts?: AdmitOptions,
  ): ReservationAdmission;
  attachToSession(
    snapshot: CapacitySnapshot,
    request: SandboxResourceRequest,
    paymentKey: string,
    sessionId: string,
    specHash: string,
  ): ReservationAdmission;
  resume(
    snapshot: CapacitySnapshot,
    request: SandboxResourceRequest,
    sessionId: string,
  ): ReservationAdmission;

  releasePayment(paymentKey: string): boolean;
  suspendSession(sessionId: string): boolean;
  beginRelease(sessionId: string, podName: string | null): boolean;
  confirmRelease(sessionId: string): boolean;
  releaseSession(sessionId: string): boolean;
  updatePod(sessionId: string, podName: string | null): void;
  pinNode(sessionId: string, nodeId: string): boolean;

  listActive(): ReservationRecord[];
  listReleasing(): ReservationRecord[];
  getBySession(sessionId: string): ReservationRecord | null;
  getByPayment(paymentKey: string): ReservationRecord | null;
  reapExpiredHolds(now: number): number;
}
