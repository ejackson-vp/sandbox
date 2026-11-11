/**
 * Wire mapping: controller session view -> public SessionStatus/CreateResponse.
 */
import { formatUsd } from "@x402s/shared/payment";
import type {
  CreateSessionResponse,
  SessionLimits,
  SessionStatus,
} from "@x402s/shared/protocol";
import type { SessionView } from "./controller-client.js";

export function toStatus(s: SessionView): SessionStatus {
  return {
    sessionId: s.sessionId,
    state: s.state,
    tier: s.tier,
    durationSeconds: s.durationSeconds,
    limits: s.limits,
    ...(s.runtime ? { runtime: s.runtime } : {}),
    createdAt: new Date(s.createdAt).toISOString(),
    ...(s.paidAt ? { paidAt: new Date(s.paidAt).toISOString() } : {}),
    ...(s.readyAt ? { readyAt: new Date(s.readyAt).toISOString() } : {}),
    ...(s.leaseExpiresAt ? { leaseExpiresAt: new Date(s.leaseExpiresAt).toISOString() } : {}),
    remainingSeconds: s.remainingSeconds,
    ...(s.suspendedAt ? { suspendedAt: new Date(s.suspendedAt).toISOString() } : {}),
    ...(s.resumeCount ? { resumeCount: s.resumeCount } : {}),
    ...(s.maxLifetimeSeconds ? { maxLifetimeSeconds: s.maxLifetimeSeconds } : {}),
    ...(s.idlePolicy ? { idlePolicy: s.idlePolicy } : {}),
    ...(s.baseline ? { baseline: s.baseline } : {}),
    ...(s.terminatingAt ? { terminatingAt: new Date(s.terminatingAt).toISOString() } : {}),
    ...(s.destroyedAt ? { destroyedAt: new Date(s.destroyedAt).toISOString() } : {}),
    clientNonce: s.clientNonce,
    ...(s.guestPublicKey ? { guestPublicKey: s.guestPublicKey } : {}),
    ...(s.attestation ? { attestation: s.attestation } : {}),
    ...(s.failureCode ? { failure: { code: s.failureCode, message: s.failureMessage ?? s.failureCode } } : {}),
    ...(s.runtimeClass ? { runtimeClass: s.runtimeClass } : {}),
    ...(s.executionMode ? { executionMode: s.executionMode } : {}),
    busy: s.busy,
    ...(s.timings ? { timings: s.timings } : {}),
    payment: {
      mode: s.payment.mode,
      network: s.payment.network,
      scheme: s.payment.scheme,
      asset: s.payment.asset,
      amount: s.payment.amount,
      priceUsd: formatUsd(s.payment.amount),
      payTo: s.payment.payTo,
      ...(s.payment.payer ? { payer: s.payment.payer } : {}),
      ...(s.payment.transaction ? { transaction: s.payment.transaction } : {}),
    },
  };
}

export function createResponseFrom(
  session: SessionView,
  capability: string,
  limits: SessionLimits,
): CreateSessionResponse {
  // The same public view as GET /v1/sessions/{id}, so the client can build its
  // handle without a second request. Internal fields (capabilityHash,
  // paymentKey) are dropped by toStatus.
  const status = toStatus(session);
  return {
    sessionId: session.sessionId,
    capability,
    state: session.state,
    tier: session.tier,
    durationSeconds: session.durationSeconds,
    limits,
    ...(session.runtime ? { runtime: session.runtime } : {}),
    ...(session.baseline ? { baseline: session.baseline } : {}),
    capabilityExpiresAt: new Date(session.capabilityExpiresAt).toISOString(),
    clientNonce: session.clientNonce,
    payment: status.payment,
    session: status,
  };
}

