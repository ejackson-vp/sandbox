/**
 * Controller -> internal API session view. Kept separate from route wiring so
 * the wire shape can be reviewed and tested without Express.
 */
import { remainingSeconds as remainingLeaseSeconds } from "@x402s/shared";
import { snapshotOf } from "./session-snapshot.js";
import type { Store } from "./store.js";

export function describeSession(store: Store, id: string) {
  const session = store.getSession(id);
  if (!session) return null;
  const payment = store.getPayment(session.paymentKey);
  const now = Date.now();
  const remainingSeconds = remainingLeaseSeconds(snapshotOf(session), now);
  return {
    sessionId: session.id,
    state: session.state,
    tier: session.tier,
    durationSeconds: session.durationSeconds,
    limits: session.limits,
    createdAt: session.createdAt,
    paidAt: session.paidAt ?? undefined,
    readyAt: session.readyAt ?? undefined,
    leaseExpiresAt: session.leaseExpiresAt ?? undefined,
    remainingSeconds,
    terminatingAt: session.terminatingAt ?? undefined,
    destroyedAt: session.destroyedAt ?? undefined,
    clientNonce: session.clientNonce,
    clientPublicKey: session.clientPublicKey,
    capabilityHash: session.capabilityHash,
    capabilityExpiresAt: session.capabilityExpiresAt,
    guestPublicKey: session.guestPublicKey ?? undefined,
    attestation: session.attestationJson ? JSON.parse(session.attestationJson) : undefined,
    failureCode: session.failureCode ?? undefined,
    failureMessage: session.failureMessage ?? undefined,
    runtimeClass: session.runtimeClass ?? undefined,
    executionMode: session.executionMode ?? undefined,
    busy: session.activeRequestId !== null,
    suspendedAt: session.suspendedAt ?? undefined,
    resumeCount: session.resumeCount,
    maxLifetimeSeconds: session.maxLifetimeSeconds ?? undefined,
    idlePolicy: session.idlePolicyJson ? JSON.parse(session.idlePolicyJson) : undefined,
    baseline:
      session.baselineCpuMillis && session.baselineMemoryMib
        ? { cpuMillis: session.baselineCpuMillis, memoryMiB: session.baselineMemoryMib }
        : undefined,
    timings: session.timingsJson ? JSON.parse(session.timingsJson) : undefined,
    payment: {
      paymentKey: payment?.paymentKey ?? session.paymentKey,
      network: payment?.network ?? "unknown",
      scheme: payment?.scheme ?? "exact",
      asset: payment?.asset ?? "unknown",
      amount: payment?.amount ?? "0",
      payTo: payment?.payTo ?? "",
      payer: payment?.payer,
      transaction: payment?.transaction,
      mode: payment?.mode ?? "mock",
    },
  };
}
