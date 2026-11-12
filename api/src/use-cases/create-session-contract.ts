/**
 * The create-session use case's contract: what it needs, what it is asked, and
 * what it answers.
 *
 * The answer is data rather than a written response. A `payment_required`
 * carries the requirement and error the 402 encoder needs, because issuing the
 * challenge nonce is the caller's job; everything else is a status, optional
 * headers and a JSON body. Keeping the vocabulary in one module lets the stages
 * and the orchestrator share it without importing each other.
 */
import type { PaymentRequirements } from "@x402/core/types";
import type { decodePaymentSignatureHeader } from "@x402/core/http";
import type { x402ResourceServer } from "@x402/core/server";
import type { CreateSessionRequest, SessionSpec } from "@x402s/shared/protocol";
import type { RateLimiter } from "../admission.js";
import type { ApiConfig } from "../config.js";
import type { CapacityDecision, ControllerClient } from "../controller-client.js";
import type { SettlementLookup } from "../settlement-lookup.js";

/** What the use case needs from the process. No `res`, no headers. */
export interface CreateSessionUseCaseDeps {
  config: ApiConfig;
  controller: ControllerClient;
  resourceServer: x402ResourceServer;
  settlementLookup: SettlementLookup;
  requirementFor(priceUsd: string, spec: SessionSpec): Promise<PaymentRequirements>;
  capabilityFor(key: string, commitment: string): string;
  /**
   * Re-derive the capability an existing session was issued, across a key
   * rotation. Null means no key in the ring reproduces the stored hash.
   */
  recoverCapability(key: string, commitment: string, storedHash: string): string | null;
  createLimiter: RateLimiter;
}

/** The parsed request. The caller has already validated `body` and admitted the IP. */
export interface CreateSessionInput {
  body: CreateSessionRequest;
  /** Raw PAYMENT-SIGNATURE (or legacy X-PAYMENT) header, if the client sent one. */
  paymentHeader: string | undefined;
  sourceIp: string;
  /** When the request arrived, so the controller timings keep the HTTP leg. */
  receivedAt: number;
}

/** A plain response the caller writes as-is. */
export interface CreateSessionJsonResult {
  kind: "json";
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/**
 * A 402 whose requirement still has to go through the payment-required encoder,
 * which is the caller's job because it issues a fresh challenge nonce.
 */
export interface CreateSessionPaymentRequiredResult {
  kind: "payment_required";
  requirement: PaymentRequirements;
  error: string;
}

export type CreateSessionResult = CreateSessionJsonResult | CreateSessionPaymentRequiredResult;

export type PaymentPayload = ReturnType<typeof decodePaymentSignatureHeader>;

/** A stage either produced a value or an answer that ends the request. */
export type Ok<T> = { ok: true; value: T };
export type Failed = { ok: false; result: CreateSessionResult };

/** Both transients, mutated by the verify/settle stage and read by completion. */
export interface PaymentTimings {
  verifyMs: number;
  settleMs: number;
}

/** The settlement the payment facilitator reported, if any. */
export interface SettledPayment {
  payer?: string;
  transaction?: string;
}

export function json(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): CreateSessionResult {
  return { kind: "json", status, body, ...(headers ? { headers } : {}) };
}

export function paymentRequired(
  requirement: PaymentRequirements,
  error: string,
): CreateSessionResult {
  return { kind: "payment_required", requirement, error };
}

export function rejectCapacity(
  decision: Extract<CapacityDecision, { admitted: false }>,
): CreateSessionResult {
  return json(
    decision.retryable ? 503 : 409,
    {
      error: "capacity_unavailable",
      retryable: decision.retryable,
      reason: decision.reason,
      requested: decision.requested,
    },
    { "Retry-After": decision.retryable ? "5" : "0" },
  );
}

/**
 * Fail-closed response for a replay whose session was signed with a key that
 * has been retired. Returning a token signed by the current key would look
 * valid and then fail every request, so say what happened instead.
 */
export function rejectRetiredCapabilityKey(sessionId: string): CreateSessionResult {
  return json(409, {
    error: "capability_key_retired",
    sessionId,
    message: "this payment's capability was signed with a retired key and cannot be reissued; create a new session",
  });
}
