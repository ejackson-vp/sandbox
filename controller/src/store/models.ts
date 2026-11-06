/**
 * Persistence models and row mappers. Kept independent of SQLite so the
 * controller and tests can share the shapes.
 */
import type { SessionLimits, SessionState, SessionTier } from "@x402s/shared";

export type { SessionState };

export interface PaymentRecord {
  paymentKey: string;
  network: string;
  scheme: string;
  asset: string;
  amount: string;
  payTo: string;
  payer?: string;
  transaction?: string;
  mode: "mock" | "testnet";
}

export interface SessionRecord {
  id: string;
  capabilityHash: string;
  capabilityExpiresAt: number;
  clientPublicKey: string;
  clientNonce: string;
  tier: SessionTier;
  durationSeconds: number;
  limits: SessionLimits;
  state: SessionState;
  createdAt: number;
  paidAt: number | null;
  readyAt: number | null;
  leaseExpiresAt: number | null;
  terminatingAt: number | null;
  destroyedAt: number | null;
  terminationReason: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  attestationJson: string | null;
  guestPublicKey: string | null;
  paymentKey: string;
  podName: string | null;
  runtimeClass: string | null;
  executionMode: string | null;
  relayTokenHash: string | null;
  activeRequestId: string | null;
  relayPurgedAt: number | null;
  destroyRequested: number;
  timingsJson: string | null;
  idlePolicyJson: string | null;
  maxLifetimeSeconds: number | null;
  suspendedAt: number | null;
  resumeCount: number;
  lastActivityAt: number | null;
  workspacePvc: string | null;
  baselineCpuMillis: number | null;
  baselineMemoryMib: number | null;
  nodeName: string | null;
  updatedAt: number;
}

export interface ExecRequestRecord {
  id: string;
  sessionId: string;
  op: string;
  state: "pending" | "done" | "error" | "abandoned";
  createdAt: number;
  updatedAt: number;
}

export type IntentStatus = "claimed" | "settled" | "failed";

export interface PaymentIntentRecord {
  paymentKey: string;
  status: IntentStatus;
  sessionId: string | null;
  specHash: string;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
}

export class PaymentAlreadyRedeemedError extends Error {
  constructor(paymentKey: string) {
    super(`payment ${paymentKey.slice(0, 12)}… has already been redeemed`);
    this.name = "PaymentAlreadyRedeemedError";
  }
}

export type ClaimOperationResult =
  | { ok: true; requestId: string }
  | { ok: false; code: "busy" | "not_usable" | "lease_expired" | "duplicate"; state: SessionState; requestId?: string };

export type IntentClaimResult =
  | { status: "claimed"; recovered: boolean }
  | { status: "settled"; sessionId: string }
  | { status: "in_progress" }
  | { status: "failed"; reason: string | null }
  | { status: "mismatch" };

export const SESSION_COLUMNS = `
  id, capability_hash, capability_expires_at, client_public_key, client_nonce,
  tier, duration_seconds, cpu_millis, memory_mib, disk_mib, max_output_bytes,
  max_file_bytes, max_command_seconds, max_processes,
  state, created_at, paid_at, ready_at, lease_expires_at, terminating_at,
  destroyed_at, termination_reason, failure_code, failure_message,
  attestation_json, guest_public_key, payment_key, pod_name, runtime_class,
  execution_mode, relay_token_hash, active_request_id, relay_purged_at,
  destroy_requested, timings_json, idle_policy_json, max_lifetime_seconds,
  suspended_at, resume_count, last_activity_at, workspace_pvc,
  baseline_cpu_millis, baseline_memory_mib, node_name, updated_at
`;

export interface RawSession {
  id: string;
  capability_hash: string;
  capability_expires_at: number;
  client_public_key: string;
  client_nonce: string;
  tier: string;
  duration_seconds: number;
  cpu_millis: number;
  memory_mib: number;
  disk_mib: number;
  max_output_bytes: number;
  max_file_bytes: number;
  max_command_seconds: number;
  max_processes: number;
  state: string;
  created_at: number;
  paid_at: number | null;
  ready_at: number | null;
  lease_expires_at: number | null;
  terminating_at: number | null;
  destroyed_at: number | null;
  termination_reason: string | null;
  failure_code: string | null;
  failure_message: string | null;
  attestation_json: string | null;
  guest_public_key: string | null;
  payment_key: string;
  pod_name: string | null;
  runtime_class: string | null;
  execution_mode: string | null;
  relay_token_hash: string | null;
  active_request_id: string | null;
  relay_purged_at: number | null;
  destroy_requested: number;
  timings_json: string | null;
  idle_policy_json: string | null;
  max_lifetime_seconds: number | null;
  suspended_at: number | null;
  resume_count: number;
  last_activity_at: number | null;
  workspace_pvc: string | null;
  baseline_cpu_millis: number | null;
  baseline_memory_mib: number | null;
  node_name: string | null;
  updated_at: number;
}

export function mapSession(r: RawSession): SessionRecord {
  return {
    id: r.id,
    capabilityHash: r.capability_hash,
    capabilityExpiresAt: r.capability_expires_at,
    clientPublicKey: r.client_public_key,
    clientNonce: r.client_nonce,
    tier: r.tier as SessionTier,
    durationSeconds: r.duration_seconds,
    limits: {
      cpuMillis: r.cpu_millis,
      memoryMiB: r.memory_mib,
      diskMiB: r.disk_mib,
      maxOutputBytes: r.max_output_bytes,
      maxFileBytes: r.max_file_bytes,
      maxCommandSeconds: r.max_command_seconds,
      maxProcesses: r.max_processes,
    },
    state: r.state as SessionState,
    createdAt: r.created_at,
    paidAt: r.paid_at,
    readyAt: r.ready_at,
    leaseExpiresAt: r.lease_expires_at,
    terminatingAt: r.terminating_at,
    destroyedAt: r.destroyed_at,
    terminationReason: r.termination_reason,
    failureCode: r.failure_code,
    failureMessage: r.failure_message,
    attestationJson: r.attestation_json,
    guestPublicKey: r.guest_public_key,
    paymentKey: r.payment_key,
    podName: r.pod_name,
    runtimeClass: r.runtime_class,
    executionMode: r.execution_mode,
    relayTokenHash: r.relay_token_hash,
    activeRequestId: r.active_request_id,
    relayPurgedAt: r.relay_purged_at,
    destroyRequested: r.destroy_requested,
    timingsJson: r.timings_json,
    idlePolicyJson: r.idle_policy_json,
    maxLifetimeSeconds: r.max_lifetime_seconds,
    suspendedAt: r.suspended_at,
    resumeCount: r.resume_count,
    lastActivityAt: r.last_activity_at,
    workspacePvc: r.workspace_pvc,
    baselineCpuMillis: r.baseline_cpu_millis,
    baselineMemoryMib: r.baseline_memory_mib,
    nodeName: r.node_name,
    updatedAt: r.updated_at,
  };
}

export function mapIntent(r: Record<string, unknown>): PaymentIntentRecord {
  return {
    paymentKey: r.payment_key as string,
    status: r.status as IntentStatus,
    sessionId: (r.session_id as string | null) ?? null,
    specHash: (r.spec_hash as string) ?? "",
    reason: (r.reason as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}
