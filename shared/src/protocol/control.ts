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
import type { PaymentMode, PaymentSummary, SessionTimings } from "./session.js";

/** Controller -> API session view. One definition; both sides import it. */
export interface ControllerSessionView {
  sessionId: string;
  state: SessionState;
  tier: SessionTier;
  durationSeconds: number;
  limits: SessionLimits;
  /** Guest runtime profile (`base`, `python`, `node`). */
  runtime?: string;
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
  /** Wallet that signed the client commitment (the payment authoriser). */
  clientSigner?: string;
  payment: {
    paymentKey: string;
    network: string;
    scheme: string;
    asset: string;
    amount: string;
    payTo: string;
    payer?: string;
    transaction?: string;
    mode: PaymentMode;
    /** EIP-3009 authorisation nonce, so a refund can be keyed by it (#31). */
    settlementNonce?: string | null;
  };
}


export interface PaymentIntentStatus {
  status: "claimed" | "pending" | "settled" | "failed";
  sessionId?: string;
  reason?: string;
}

/** One component of a readiness report. */
export interface ComponentHealth {
  ok: boolean;
  /**
   * Stable, bounded reason code. Never an exception message: those can carry
   * connection strings, file paths or other operational detail.
   */
  reason?: string;
}

/** Body of `GET /internal/readyz`, which the API reads before routing work. */
export interface ReadinessReport {
  ok: boolean;
  checkedAt: number;
  /** True when the report came from the TTL cache instead of a fresh probe. */
  cached: boolean;
  components: Record<string, ComponentHealth>;
}
