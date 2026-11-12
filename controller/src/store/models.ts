/**
 * Persistence models and row mappers. Kept free of any SQL client so the
 * controller and tests can share the shapes.
 */
import { DEFAULT_RUNTIME, type RuntimeName } from "@x402s/shared/runtimes";
import type { SessionLimits, SessionState, SessionTier } from "@x402s/shared/protocol";

export type { SessionState };

/**
 * Readiness verdict for the store: the same three questions in the same order.
 * The probe keeps its own SQL and reason matching, so only the shape is shared
 * between the adapter and the readiness route.
 */
export type StoreHealth =
  | { ok: true; schemaVersion: number }
  | {
      ok: false;
      reason: "unavailable" | "closed" | "migrations_incomplete" | "read_only" | "locked" | "write_failed";
      schemaVersion?: number;
    };

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
  /** EIP-3009 authorisation nonce, when the payload carried one. */
  settlementNonce?: string | null;
}

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

export interface ExecRequestRecord {
  id: string;
  sessionId: string;
  op: string;
  /**
   * `outcome_unknown` is terminal and distinct from `abandoned`: the request
   * was in flight when the controller restarted, so it may still execute. A
   * lookup must never turn it into a success or a plain expiry.
   */
  state: "pending" | "done" | "error" | "abandoned" | "outcome_unknown";
  /**
   * Hash of the canonical operation this request id was first claimed with,
   * or SHA-256 of the sealed envelope when the client sends no canonical hash.
   * Null on rows written before v16: those predate payload binding, so a
   * duplicate against them is accepted.
   */
  payloadHash: string | null;
  /**
   * The sealed result the guest produced, kept so a retry can still be answered
   * after the relay's 5 minute / 64 entry cache evicts it (schema v17). It is
   * client-sealed ciphertext: the controller stores it with no key for it and
   * cannot open it. Null when the operation has not finished, when the envelope
   * exceeded `MAX_PERSISTED_RESULT_BYTES`, and after the session is finalized.
   */
  resultEnvelope: string | null;
  epoch: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Largest sealed result kept with the request row.
 *
 * The relay holds a result for 5 minutes; this row holds one for the life of
 * the session, so the ceiling is the only lever on what a single operation can
 * add to the database. 1 MiB covers ordinary command output many times over
 * (the tier's `maxOutputBytes` caps stdout/stderr, and base64 adds a third), and
 * a `file.get` result is the case that can exceed it. An envelope above the
 * bound is not persisted at all, so that operation keeps the relay-cache-only
 * behaviour it had before v17. It is never truncated: a partial sealed box
 * cannot be opened by the client, so storing one would turn a cache miss into a
 * corrupt result.
 */
export const MAX_PERSISTED_RESULT_BYTES = 1024 * 1024;

/**
 * The value to store in `exec_requests.result_envelope`, or null when there is
 * nothing to store. Applied at the write site in both adapters so the bound is
 * one decision, not two.
 */
export function persistableResultEnvelope(envelope: string | null | undefined): string | null {
  if (!envelope) return null;
  return Buffer.byteLength(envelope, "utf8") > MAX_PERSISTED_RESULT_BYTES ? null : envelope;
}

export type IntentStatus = "claimed" | "settled" | "failed";

export type LedgerStatus = "SETTLED" | "REFUND_PENDING" | "REFUND_SENDING" | "REFUNDED";

/**
 * A refund the worker has claimed and not yet resolved (#31). `reclaimed` is
 * true when the row was already `REFUND_SENDING`: its previous owner's lease
 * expired, so this owner found it on the stale-lease path. The worker counts it
 * separately, and the resend reuses the stored idempotency key.
 */
export interface ClaimedRefund {
  ledger: PaymentLedgerRecord;
  reclaimed: boolean;
}

/** What a refund claim pass asks the store for. */
export interface RefundClaimRequest {
  nowMs: number;
  /**
   * A `REFUND_SENDING` row claimed at or before this instant has an expired
   * lease and is due again. The caller computes it as `now - leaseMs`, so the
   * lease policy lives with the worker and the store only compares timestamps.
   */
  leaseCutoffMs: number;
  limit: number;
  /** Rows at or above this many attempts are never claimed again. */
  maxAttempts: number;
  /** Fence written onto every row this pass claims. */
  claimToken: string;
}

export interface PaymentLedgerRecord {
  paymentKey: string;
  sessionId: string;
  payer: string | null;
  amount: string;
  asset: string;
  network: string;
  mode: "mock" | "testnet";
  status: LedgerStatus;
  reason: string | null;
  refundTransaction: string | null;
  /** EIP-3009 authorisation nonce; lets a refund be keyed by it (#31). */
  settlementNonce: string | null;
  /** Refund worker retry state. */
  refundAttempts: number;
  refundLastError: string | null;
  refundNextAttemptAt: number | null;
  /** Fence held by the worker while the row is `REFUND_SENDING`. */
  refundClaimToken: string | null;
  /** When the current `REFUND_SENDING` lease was taken, in epoch ms. */
  refundClaimedAt: number | null;
  /**
   * Stable provider idempotency key, `refund:<paymentKey>`. Set when the row is
   * first claimed and never rewritten, so every retry presents the same key.
   */
  refundIdempotencyKey: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A ledger row written for a settled payment that no session consumed (#31):
 * unentitled or a duplicate charge. Shared by the refund and settlement-recovery
 * ports, so the shape lives with the record it inserts rather than with an
 * adapter.
 */
export interface UnclaimedLedgerEntry {
  paymentKey: string;
  sessionId: string;
  payer: string | null;
  amount: string;
  asset: string;
  network: string;
  mode: "mock" | "testnet";
  status: LedgerStatus;
  reason: string;
  /** Set when the row is written already refunded (a mock refund). */
  refundTransaction?: string | null;
  settlementNonce: string | null;
}

export interface PaymentIntentRecord {
  paymentKey: string;
  status: IntentStatus;
  sessionId: string | null;
  specHash: string;
  reason: string | null;
  /** Owner of the current claim; null once settled or failed. */
  claimToken: string | null;
  /** Lease deadline for the current claim, in epoch ms. */
  claimExpiresAt: number | null;
  /**
   * Payment requirements recorded at claim time (`PaymentRequirements` JSON).
   * Settlement recovery needs them to describe a payment the API no longer has.
   */
  requirementsJson: string | null;
  createdAt: number;
  updatedAt: number;
}

export class PaymentAlreadyRedeemedError extends Error {
  constructor(paymentKey: string) {
    super(`payment ${paymentKey.slice(0, 12)}… has already been redeemed`);
    this.name = "PaymentAlreadyRedeemedError";
  }
}

/**
 * A second payment settled for a client key pair that already owns a session.
 * The new payment is refunded rather than creating a second session (#31).
 */
export class DuplicateEntitlementError extends Error {
  constructor(
    readonly paymentKey: string,
    readonly existingSessionId: string,
  ) {
    super(`client key pair already owns session ${existingSessionId}`);
    this.name = "DuplicateEntitlementError";
  }
}

/** The caller's claim token is no longer the intent owner (stale or mismatched). */
export class PaymentClaimLostError extends Error {
  constructor(paymentKey: string) {
    super(`claim on payment ${paymentKey.slice(0, 12)}… is no longer held by this owner`);
    this.name = "PaymentClaimLostError";
  }
}

/**
 * True when two stored payload hashes disagree. A NULL on either side means the
 * check cannot be made (pre-v16 row, or a caller that supplied no hash) and the
 * duplicate is accepted, which is the documented upgrade behaviour.
 */
export function payloadDiffers(
  stored: string | null,
  incoming: string | null | undefined,
): boolean {
  return stored !== null && incoming !== null && incoming !== undefined && stored !== incoming;
}

export type ClaimOperationResult =
  | { ok: true; requestId: string; epoch: number }
  | {
      ok: false;
      code: "busy" | "not_usable" | "lease_expired" | "duplicate" | "idempotency_key_reused";
      state: SessionState;
      requestId?: string;
    };

export type IntentClaimResult =
  | { status: "claimed"; recovered: boolean; token: string; expiresAt: number }
  | { status: "settled"; sessionId: string }
  | { status: "in_progress" }
  | { status: "failed"; reason: string | null }
  | { status: "mismatch" };

/**
 * Single-use challenge nonce outcome (F-07). Shared by the store port and the
 * control API, which maps each status to a response.
 */
export type ChallengeBurnResult =
  | { status: "burned" }
  /** The same payment already burned this nonce: the retry/recovery path. */
  | { status: "replay" }
  | { status: "expired" }
  | { status: "unknown" }
  /** A different payment already burned this nonce. */
  | { status: "reused" };

export class ChallengeNonceCapacityError extends Error {
  constructor(active: number, max: number) {
    super(`challenge nonce table is full (${active}/${max}); refusing to issue`);
    this.name = "ChallengeNonceCapacityError";
  }
}

/**
 * Session states that still need reconcile work. The due query and the
 * `sessions_due` partial index are both built from this list, so the index
 * predicate can never drift away from the query it serves.
 */
const NON_TERMINAL_STATES = [
  "PAID",
  "PROVISIONING",
  "READY",
  "ACTIVE",
  "SUSPENDING",
  "SUSPENDED",
  "RESUMING",
  "TERMINATING",
] as const;

/** The same list as a SQL `IN` body: `'PAID','PROVISIONING',...`. */
export const NON_TERMINAL_STATE_SQL = NON_TERMINAL_STATES.map((state) => `'${state}'`).join(",");

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

export function mapIntent(r: Record<string, unknown>): PaymentIntentRecord {
  return {
    paymentKey: r.payment_key as string,
    status: r.status as IntentStatus,
    sessionId: (r.session_id as string | null) ?? null,
    specHash: (r.spec_hash as string) ?? "",
    reason: (r.reason as string | null) ?? null,
    claimToken: (r.claim_token as string | null) ?? null,
    claimExpiresAt: (r.claim_expires_at as number | null) ?? null,
    requirementsJson: (r.requirements_json as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

export function mapLedger(r: Record<string, unknown>): PaymentLedgerRecord {
  return {
    paymentKey: r.payment_key as string,
    sessionId: r.session_id as string,
    payer: (r.payer as string | null) ?? null,
    amount: r.amount as string,
    asset: r.asset as string,
    network: r.network as string,
    mode: r.mode as "mock" | "testnet",
    status: r.status as LedgerStatus,
    reason: (r.reason as string | null) ?? null,
    refundTransaction: (r.refund_tx as string | null) ?? null,
    settlementNonce: (r.settlement_nonce as string | null) ?? null,
    refundAttempts: (r.refund_attempts as number | null) ?? 0,
    refundLastError: (r.refund_last_error as string | null) ?? null,
    refundNextAttemptAt: (r.refund_next_attempt_at as number | null) ?? null,
    refundClaimToken: (r.refund_claim_token as string | null) ?? null,
    refundClaimedAt: (r.refund_claimed_at as number | null) ?? null,
    refundIdempotencyKey: (r.refund_idempotency_key as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}
