/**
 * Internal control-plane contract (API server <-> controller).
 */
import type { SessionSpec, SessionState } from "./lifecycle.js";

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

export interface EntitlementResponse {
  sessionId: string;
  state: SessionState;
}

export interface PaymentIntentStatus {
  status: "claimed" | "pending" | "settled" | "failed";
  sessionId?: string;
  reason?: string;
}
