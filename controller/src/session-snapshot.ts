/**
 * Map the persistence record to the pure lifecycle snapshot. This is the only
 * place that knows how durable columns correspond to domain facts.
 */
import type { IdlePolicy, SessionSnapshot } from "@x402s/shared";
import type { SessionRecord } from "./store/models.js";

function parseIdlePolicy(json: string | null): IdlePolicy | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as IdlePolicy;
  } catch {
    return null;
  }
}

export function snapshotOf(session: SessionRecord): SessionSnapshot {
  return {
    state: session.state,
    suspendable: session.idlePolicyJson !== null,
    hasPod: session.podName !== null,
    hasPvc: session.workspacePvc !== null,
    hasRelay: session.relayTokenHash !== null,
    leaseExpiresAt: session.leaseExpiresAt,
    suspendedAt: session.suspendedAt,
    createdAt: session.createdAt,
    maxLifetimeSeconds: session.maxLifetimeSeconds,
    idlePolicy: parseIdlePolicy(session.idlePolicyJson),
    lastActivityAt: session.lastActivityAt,
  };
}
