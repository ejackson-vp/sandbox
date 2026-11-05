/**
 * Wire protocol types shared by the API server, controller, CLI and (by
 * hand-written mirror) the Go guest runtime.
 *
 * Design rule: nothing in this file may carry customer plaintext. Every
 * `envelope` field is an opaque base64 libsodium sealed box.
 */

export type SandboxState =
  | "CREATED"
  | "PAID"
  | "PROVISIONING"
  | "READY"
  | "RUNNING"
  | "COMPLETED"
  | "DESTROYED"
  | "FAILED"
  | "EXPIRED";

export const TERMINAL_STATES: readonly SandboxState[] = [
  "COMPLETED",
  "DESTROYED",
  "FAILED",
  "EXPIRED",
];

export function isTerminal(state: SandboxState): boolean {
  return TERMINAL_STATES.includes(state);
}

export const MAX_DURATION_SECONDS = 60;
export const MIN_DURATION_SECONDS = 1;

/** Fixed, trusted runtime image contents. Customers never choose an image. */
export type GuestLanguage = "python3";

export interface CreateSandboxRequest {
  /** Requested execution window in seconds, 1..60. */
  durationSeconds: number;
  /** Customer ephemeral X25519 public key (base64, 32 bytes) for result encryption. */
  clientPublicKey: string;
  /** Customer freshness nonce (base64, 32 bytes) bound into attestation. */
  clientNonce: string;
  /** Only "python3" is supported; images are fixed and operator-controlled. */
  language: GuestLanguage;
}

export interface PaymentSummary {
  mode: "mock" | "testnet";
  network: string;
  scheme: string;
  asset: string;
  amount: string;
  /** Human readable amount, e.g. "$0.01". */
  priceUsd: string;
  payTo: string;
  payer?: string;
  transaction?: string;
}

export interface CreateSandboxResponse {
  sandboxId: string;
  /** Possession capability. Returned exactly once; the server stores only its hash. */
  capability: string;
  state: SandboxState;
  durationSeconds: number;
  /** Absolute deadline after which the capability is rejected. */
  capabilityExpiresAt: string;
  clientNonce: string;
  payment: PaymentSummary;
  /**
   * Present when attestation evidence already arrived before the payment
   * response was written (rare). Clients normally poll GET /v1/sandboxes/{id}.
   */
  attestation?: AttestationEnvelope;
}

export interface SandboxStatus {
  sandboxId: string;
  state: SandboxState;
  durationSeconds: number;
  createdAt: string;
  paidAt?: string;
  readyAt?: string;
  /** Execution window ends here; computed from readyAt + durationSeconds. */
  executionDeadline?: string;
  completedAt?: string;
  destroyedAt?: string;
  clientNonce: string;
  guestPublicKey?: string;
  attestation?: AttestationEnvelope;
  payment: PaymentSummary;
  failure?: { code: string; message: string };
  /** Non-sensitive operator-visible metadata. */
  runtimeClass?: string;
  executionMode?: ExecutionMode;
}

export interface ExecuteRequest {
  /** base64 sealed box containing ExecutePlaintext. */
  envelope: string;
}

export interface ExecuteResponse {
  state: SandboxState;
  /** Remaining execution budget in milliseconds at the time of acceptance. */
  remainingMs: number;
}

export interface ResultResponse {
  state: SandboxState;
  /** base64 sealed box containing ResultPlaintext. Only sent once. */
  envelope?: string;
}

export interface ExecutePlaintext {
  v: 1;
  sessionId: string;
  clientNonce: string;
  language: GuestLanguage;
  code: string;
  stdin?: string;
}

export interface ResultPlaintext {
  v: 1;
  sessionId: string;
  clientNonce: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  truncated: { stdout: boolean; stderr: boolean };
}

/* ------------------------------------------------------------------ */
/* Attestation                                                         */
/* ------------------------------------------------------------------ */

export type ExecutionMode = "dev" | "kata" | "confidential";

export type EvidenceType =
  | "dev-simulated"
  | "kata-dev-no-hw-attestation"
  | "sev-snp"
  | "tdx";

export interface AttestationClaims {
  /** Digest of the guest executable actually running. */
  guestMeasurement: string;
  /** Container image digest (immutable reference) reported by the runtime. */
  imageDigest: string;
  runtimeClass: string;
  /** Kernel identity. In a VM (Kata) this differs from the host kernel. */
  kernelRelease?: string;
  /** True only for SEV-SNP/TDX evidence verified by a hardware verifier. */
  hardwareBacked: boolean;
  /** Guest-enforced management restrictions present? */
  guestPolicyEnforced: boolean;
  [key: string]: unknown;
}

export interface AttestationEnvelope {
  v: 1;
  evidenceType: EvidenceType;
  /**
   * Set by simulated evidence producers. A production verifier MUST reject any
   * envelope with this flag set, and the CLI must refuse it unless
   * `--allow-insecure-dev` was passed explicitly.
   */
  insecureDevOnly: boolean;
  hardwareBacked: boolean;
  sessionId: string;
  guestPublicKey: string;
  clientPublicKey: string;
  clientNonce: string;
  /** Random per-boot value; prevents replaying evidence across boots. */
  bootNonce: string;
  issuedAt: number;
  expiresAt: number;
  claims: AttestationClaims;
  /** Raw hardware evidence (base64). Empty for simulated modes. */
  report?: string;
  /** Signature over the canonical envelope (all fields except `signature`). */
  signature: {
    alg: "ed25519";
    keyId: string;
    value: string;
  };
}

/* ------------------------------------------------------------------ */
/* Internal control plane (API <-> controller <-> relay)               */
/* ------------------------------------------------------------------ */

export interface EntitlementRequest {
  sessionId: string;
  capabilityHash: string;
  capabilityExpiresAt: number;
  durationSeconds: number;
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
  state: SandboxState;
}

export interface RelaySessionState {
  registered: boolean;
  connected: boolean;
  attestation?: AttestationEnvelope;
  resultAvailable: boolean;
  error?: string;
}

export interface RelayExecuteMessage {
  type: "execute";
  /** base64 sealed box for the guest. */
  envelope: string;
  /** Absolute epoch ms after which the guest must abort. */
  deadlineMs: number;
}

export interface GuestHelloMessage {
  type: "hello";
  evidence: AttestationEnvelope;
}

export interface GuestResultMessage {
  type: "result";
  /** base64 sealed box for the client. */
  envelope: string;
  resultId: string;
}

export interface GuestErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export type GuestToRelay = GuestHelloMessage | GuestResultMessage | GuestErrorMessage;
