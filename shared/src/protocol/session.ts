/**
 * Public session wire shapes (create request/response, status, timings).
 */
import type { AttestationEnvelope, ExecutionMode } from "./attestation.js";
import type {
  IdlePolicy,
  SessionBaseline,
  SessionLimits,
  SessionState,
  SessionTier,
} from "./lifecycle.js";

export interface CreateSessionRequest {
  /** Preset tier. If omitted, `durationSeconds` + limits are required. */
  tier?: SessionTier;
  /** Guest runtime profile (`base`, `python`, `node`). Defaults to `base`. */
  runtime?: string;
  durationSeconds?: number;
  cpuMillis?: number;
  memoryMiB?: number;
  diskMiB?: number;
  /** Customer ephemeral X25519 public key (base64, 32 bytes). */
  clientPublicKey: string;
  /** Customer freshness nonce (base64, 32 bytes) bound into attestation. */
  clientNonce: string;
  /**
   * Proof that the payer wallet (the EIP-3009 `from`) authorised this exact
   * payment + client key. Personal-sign over `clientCommitmentMessage`.
   * Required on the paid request; absent on the initial 402 probe.
   */
  clientSignature?: string;
  /** Opt into checkpointed suspend/resume. */
  idlePolicy?: IdlePolicy;
  /** Wall-clock cap, including suspended time (default 8h for suspendable). */
  maxLifetimeSeconds?: number;
  /** Optional steady-state reservation; defaults to a quarter of the peak. */
  baselineCpuMillis?: number;
  baselineMemoryMiB?: number;
}

export interface PaymentSummary {
  mode: "mock" | "testnet";
  network: string;
  scheme: string;
  asset: string;
  amount: string;
  /** Human readable amount, e.g. "$0.05". */
  priceUsd: string;
  payTo: string;
  payer?: string;
  transaction?: string;
}

export interface CreateSessionResponse {
  sessionId: string;
  /**
   * Guest runtime profile for this session. Always `base` or one of the
   * supported profiles; echoed here so an old client can read it without
   * parsing the embedded status view.
   */
  runtime?: string;
  /**
   * Possession capability. Derived deterministically from the settled payment
   * (HMAC) so that a retried request can recover it; only its SHA-256 hash is
   * stored server-side.
   */
  capability: string;
  state: SessionState;
  tier: SessionTier;
  durationSeconds: number;
  limits: SessionLimits;
  baseline?: SessionBaseline;
  capabilityExpiresAt: string;
  clientNonce: string;
  payment: PaymentSummary;
  /**
   * Session view at completion time, in the same shape as
   * `GET /v1/sessions/{id}`. Additive and optional: older SDKs ignore it and
   * newer SDKs build the local handle from it, so a create needs no immediate
   * status request. It never contains capability material (only the hash is
   * stored server-side, and it is not echoed here).
   */
  session?: SessionStatus;
}

/**
 * Per-session lifecycle timings captured by the control plane. Used by the
 * benchmark harness and exposed on the status endpoint (no customer data).
 */
export interface SessionTimings {
  /** Epoch ms when the API handler started processing the create request. */
  apiReceivedAt?: number;
  paymentVerifyMs?: number;
  paymentSettleMs?: number;
  /** API: create request start -> 201 written. */
  entitlementMs?: number;
  /** Controller: entitlement row visible -> pod create call. */
  provisionStartAt?: number;
  podRequestedAt?: number;
  /** Controller: duration of the Kubernetes create-pod API call. */
  podCreateCallMs?: number;
  /** Controller: first poll where the pod phase was Running / container started. */
  podRunningObservedAt?: number;
  podCreatedAt?: number;
  podScheduledAt?: number;
  containerStartedAt?: number;
  /** Relay: timestamp when the guest hello arrived. */
  guestHelloAt?: number;
  readyAt?: number;
  leaseExpiresAt?: number;
  /** Controller: a pre-booted pod was claimed instead of creating one. */
  warmClaimAt?: number;
  /** 1 when the session was served by the warm pool. */
  warmPoolHit?: number;
  provisionBeginAt?: number;
  warmPickMs?: number;
  warmRegisterMs?: number;
  warmClaimCallMs?: number;
  warmRelabelMs?: number;
  terminationStartedAt?: number;
  podDeletedAt?: number;
  /** Controller: TERMINATING -> final state. */
  cleanupMs?: number;
}

export interface SessionStatus {
  sessionId: string;
  state: SessionState;
  tier: SessionTier;
  durationSeconds: number;
  limits: SessionLimits;
  /** Guest runtime profile (`base`, `python`, `node`). */
  runtime?: string;
  createdAt: string;
  paidAt?: string;
  readyAt?: string;
  /** Immutable lease deadline: readyAt + purchased duration. */
  leaseExpiresAt?: string;
  /** Whole seconds remaining in the lease (0 when expired or suspended). */
  remainingSeconds: number;
  /** Present once the session has been checkpointed. */
  suspendedAt?: string;
  /** Number of times this session has been resumed. */
  resumeCount?: number;
  /** Wall-clock cap, including suspended time. */
  maxLifetimeSeconds?: number;
  /** Present for suspendable sessions. */
  idlePolicy?: IdlePolicy;
  /** Steady-state reservation (limits are the burst ceiling). */
  baseline?: SessionBaseline;
  terminatingAt?: string;
  destroyedAt?: string;
  clientNonce: string;
  guestPublicKey?: string;
  attestation?: AttestationEnvelope;
  payment: PaymentSummary;
  failure?: { code: string; message: string };
  runtimeClass?: string;
  executionMode?: ExecutionMode;
  /** True while a command/file operation is in flight. */
  busy: boolean;
  timings?: SessionTimings;
}
