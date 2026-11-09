/**
 * Internal control-plane contract (API server <-> controller).
 */
import type {
  IdlePolicy,
  SessionLimits,
  SessionSpec,
  SessionState,
  SessionTier,
} from "./lifecycle.js";
import type { AttestationEnvelope } from "./attestation.js";
import type { PaymentSummary, SessionTimings } from "./session.js";

/** Controller -> API session view. One definition; both sides import it. */
export interface ControllerSessionView {
  sessionId: string;
  state: SessionState;
  tier: SessionTier;
  durationSeconds: number;
  limits: SessionLimits;
  createdAt: number;
  paidAt?: number;
  readyAt?: number;
  leaseExpiresAt?: number;
  remainingSeconds: number;
  terminatingAt?: number;
  destroyedAt?: number;
  clientNonce: string;
  clientPublicKey: string;
  capabilityHash: string;
  capabilityExpiresAt: number;
  guestPublicKey?: string;
  attestation?: AttestationEnvelope;
  suspendedAt?: number;
  resumeCount?: number;
  maxLifetimeSeconds?: number;
  idlePolicy?: IdlePolicy;
  baseline?: { cpuMillis: number; memoryMiB: number };
  failureCode?: string;
  failureMessage?: string;
  runtimeClass?: string;
  executionMode?: "dev" | "kata";
  busy: boolean;
  timings?: SessionTimings;
  payment: Omit<PaymentSummary, "priceUsd"> & { paymentKey: string };
}

export interface EntitlementRequest {
  sessionId: string;
  capabilityHash: string;
  capabilityExpiresAt: number;
  spec: SessionSpec;
  clientPublicKey: string;
  clientNonce: string;
  payment: {
    paymentKey: string;
    network: string;
    scheme: string;
    asset: string;
    amount: string;
    payTo: string;
    payer?: string;
    transaction?: string;
    mode: "mock" | "testnet";
  };
}


export interface PaymentIntentStatus {
  status: "claimed" | "pending" | "settled" | "failed";
  sessionId?: string;
  reason?: string;
}
