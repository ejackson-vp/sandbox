/**
 * Reservation store port.
 *
 * The controller depends on this interface, not on an adapter. The Postgres
 * adapter is the implementation; another backend could satisfy the same
 * admission contract without touching capacity accounting.
 *
 * Every method returns a `Promise` for the same reason the session ports do
 * (ADR 0010): no network client can be called from a synchronous method, and the
 * reservation invariant ("the accounting snapshot and the insert agree") has to
 * hold for an adapter that does its check and write in another process.
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
  | { admitted: true; reservation: ReservationRecord }
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
  ): Promise<ReservationAdmission>;
  attachToSession(
    snapshot: CapacitySnapshot,
    request: SandboxResourceRequest,
    paymentKey: string,
    sessionId: string,
    specHash: string,
  ): Promise<ReservationAdmission>;
  resume(
    snapshot: CapacitySnapshot,
    request: SandboxResourceRequest,
    sessionId: string,
  ): Promise<ReservationAdmission>;

  releasePayment(paymentKey: string): Promise<boolean>;
  suspendSession(sessionId: string): Promise<boolean>;
  reassertAllocated(sessionId: string): Promise<boolean>;
  beginRelease(sessionId: string, podName: string | null): Promise<boolean>;
  confirmRelease(sessionId: string): Promise<boolean>;
  releaseSession(sessionId: string): Promise<boolean>;
  updatePod(sessionId: string, podName: string | null): Promise<void>;
  pinNode(sessionId: string, nodeId: string): Promise<boolean>;

  listActive(): Promise<ReservationRecord[]>;
  listReleasing(): Promise<ReservationRecord[]>;
  getBySession(sessionId: string): Promise<ReservationRecord | null>;
  getByPayment(paymentKey: string): Promise<ReservationRecord | null>;
  reapExpiredHolds(now: number): Promise<number>;
}
