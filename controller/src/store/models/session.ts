/**
 * The session row and its mapper.
 *
 * `SESSION_COLUMNS`, `RawSession` and `mapSession` are one tuple: a column added
 * to the select must be added to the raw shape and the mapper in the same
 * change. The state vocabulary is not here: it lives in
 * `@x402s/shared/protocol`, including the SQL `IN` bodies generated from it.
 */
import { DEFAULT_RUNTIME, type RuntimeName } from "@x402s/shared/runtimes";
import type {
  IdlePolicy,
  SessionBaseline,
  SessionLimits,
  SessionState,
  SessionTier,
} from "@x402s/shared/protocol";

export type { SessionState };

export interface SessionRecord {
  id: string;
  capabilityHash: string;
  capabilityExpiresAt: number;
  clientPublicKey: string;
  clientNonce: string;
  /** Wallet that signed the client commitment; absent on pre-v8 rows. */
  clientSigner?: string | null;
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
  /**
   * Guest runtime profile. Always present on rows written by v12 or later;
   * optional so a hand-built record (or a caller from an older build) is
   * treated as the historical default.
   */
  runtime?: RuntimeName;
  relayTokenHash: string | null;
  activeRequestId: string | null;
  /** Monotonic fence bumped when restart recovery abandons an operation. */
  execEpoch: number;
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

/**
 * Everything a fresh entitlement knows. The caller states the facts it was
 * given; every field whose value is an invariant of "newly paid" is set by the
 * factory below, not by the caller.
 */
export interface NewPaidEntitlementInput {
  id: string;
  paymentKey: string;
  capabilityHash: string;
  capabilityExpiresAt: number;
  clientPublicKey: string;
  clientNonce: string;
  clientSigner?: string | null;
  tier: SessionTier;
  durationSeconds: number;
  limits: SessionLimits;
  runtime: RuntimeName;
  /** Isolation handler the controller verified at startup. */
  runtimeClass: string | null;
  executionMode: string | null;
  /** Clock for `createdAt`, `paidAt`, `updatedAt` and the initial activity mark. */
  now: number;
  idlePolicy?: IdlePolicy | null;
  maxLifetimeSeconds?: number | null;
  baseline?: SessionBaseline | null;
}

/**
 * The one construction site for a newly paid row.
 *
 * The route that settles a payment and the adapter that inserts the row are
 * two different modules, and the column list is a third. The fields below are
 * identical on every fresh entitlement, and they are the ones a transition
 * reads before anything else: `execEpoch` fences relay work, `destroyRequested`
 * and `resumeCount` are counters a resumed or destroyed session must not
 * inherit, and the nulls are what distinguish "not started yet" from "started
 * and lost". Setting them here means a new column or a changed initial value is
 * one edit, not five.
 */
export const SessionRecord = {
  newPaidEntitlement(input: NewPaidEntitlementInput): SessionRecord {
    return {
      id: input.id,
      capabilityHash: input.capabilityHash,
      capabilityExpiresAt: input.capabilityExpiresAt,
      clientPublicKey: input.clientPublicKey,
      clientNonce: input.clientNonce,
      clientSigner: input.clientSigner ?? null,
      tier: input.tier,
      durationSeconds: input.durationSeconds,
      limits: input.limits,
      state: "PAID",
      createdAt: input.now,
      paidAt: input.now,
      readyAt: null,
      leaseExpiresAt: null,
      terminatingAt: null,
      destroyedAt: null,
      terminationReason: null,
      failureCode: null,
      failureMessage: null,
      attestationJson: null,
      guestPublicKey: null,
      paymentKey: input.paymentKey,
      podName: null,
      runtimeClass: input.runtimeClass,
      executionMode: input.executionMode,
      runtime: input.runtime,
      relayTokenHash: null,
      activeRequestId: null,
      execEpoch: 1,
      relayPurgedAt: null,
      destroyRequested: 0,
      timingsJson: null,
      idlePolicyJson: input.idlePolicy ? JSON.stringify(input.idlePolicy) : null,
      maxLifetimeSeconds: input.maxLifetimeSeconds ?? null,
      suspendedAt: null,
      resumeCount: 0,
      // The adapter used to substitute `createdAt` for a null activity mark, so
      // that is the value the row has always held. Stating it here makes the
      // record and the row agree, and keeps the idle clock honest.
      lastActivityAt: input.now,
      workspacePvc: null,
      baselineCpuMillis: input.baseline?.cpuMillis ?? null,
      baselineMemoryMib: input.baseline?.memoryMiB ?? null,
      nodeName: null,
      updatedAt: input.now,
    };
  },
};

export const SESSION_COLUMNS = `
  id, capability_hash, capability_expires_at, client_public_key, client_nonce, client_signer,
  tier, duration_seconds, cpu_millis, memory_mib, disk_mib, max_output_bytes,
  max_file_bytes, max_command_seconds, max_processes,
  state, created_at, paid_at, ready_at, lease_expires_at, terminating_at,
  destroyed_at, termination_reason, failure_code, failure_message,
  attestation_json, guest_public_key, payment_key, pod_name, runtime_class,
  execution_mode, runtime, relay_token_hash, active_request_id, exec_epoch, relay_purged_at,
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
  client_signer: string | null;
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
  runtime: string | null;
  relay_token_hash: string | null;
  active_request_id: string | null;
  exec_epoch: number;
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
    clientSigner: r.client_signer,
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
    runtime: (r.runtime as RuntimeName | null) ?? DEFAULT_RUNTIME,
    relayTokenHash: r.relay_token_hash,
    activeRequestId: r.active_request_id,
    execEpoch: r.exec_epoch,
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