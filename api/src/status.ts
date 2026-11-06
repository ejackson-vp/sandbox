/**
 * Wire mapping: controller session view -> public SessionStatus/CreateResponse.
 */
import {
  formatUsd,
  type CreateSessionResponse,
  type SessionLimits,
  type SessionStatus,
} from "@x402s/shared";
import type { SessionView } from "./controller-client.js";

export function toStatus(s: SessionView): SessionStatus {
  return {
    sessionId: s.sessionId,
    state: s.state,
    tier: s.tier,
    durationSeconds: s.durationSeconds,
    limits: s.limits,
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
  return {
    sessionId: session.sessionId,
    capability,
    state: session.state,
    tier: session.tier,
    durationSeconds: session.durationSeconds,
    limits,
    ...(session.baseline ? { baseline: session.baseline } : {}),
    capabilityExpiresAt: new Date(session.capabilityExpiresAt).toISOString(),
    clientNonce: session.clientNonce,
    payment: toStatus(session).payment,
  };
}

