/**
 * Wire protocol types shared by the API server, SDK/CLI, controller and (by
 * hand-written mirror) the Go guest runtime.
 *
 * Design rule: nothing in this file may carry customer plaintext. Every
 * `envelope` field is an opaque base64 libsodium sealed box. Commands, file
 * contents, stdout and stderr only ever exist inside those envelopes.
 */

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

export type SessionState =
  | "CREATED"
  | "PAID"
  | "PROVISIONING"
  | "READY"
  | "ACTIVE"
  | "SUSPENDED"
  | "TERMINATING"
  | "EXPIRED"
  | "FAILED"
  | "DESTROYED";

export const TERMINAL_STATES: readonly SessionState[] = ["EXPIRED", "FAILED", "DESTROYED"];

/** States in which a session may accept operations (subject to the lease). */
export const USABLE_STATES: readonly SessionState[] = ["READY", "ACTIVE"];

export function isTerminal(state: SessionState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function isUsable(state: SessionState): boolean {
  return USABLE_STATES.includes(state);
}

/** Hard upper bound on any lease, regardless of configuration. */
export const MAX_LEASE_SECONDS = 3600;
/** Hard upper bound on a session's wall-clock lifetime, including suspended time. */
export const MAX_SESSION_LIFETIME_SECONDS = 28800;
/** Development floor for tests. */
export const MIN_LEASE_SECONDS = 1;

export type SessionTier = "short" | "standard" | "extended" | "long" | "custom";

export const TIER_DURATIONS: Record<Exclude<SessionTier, "custom">, number> = {
  short: 60,
  standard: 300,
  extended: 900,
  long: 1800,
};

export interface SessionLimits {
  cpuMillis: number;
  memoryMiB: number;
  diskMiB: number;
  /** Cap per stream (stdout or stderr) per command. */
  maxOutputBytes: number;
  /** Cap for a single uploaded file or archive. */
  maxFileBytes: number;
  /** Cap per command, independent of the lease. */
  maxCommandSeconds: number;
  /** Max number of processes the guest will allow the workload to spawn. */
  maxProcesses: number;
}

/**
 * Suspended-session policy. Present only when the customer wants a checkpointed
 * workspace instead of a short-lived lease.
 */
export interface IdlePolicy {
  /** Suspend after this many seconds without an operation. */
  maxIdleSeconds?: number;
  /** Terminate after this many seconds in the suspended state. */
  suspendedDurationSeconds?: number;
  /** Hint to clients that they may resume automatically on the next request. */
  autoResume?: boolean;
}

export interface SessionBaseline {
  /** Scheduler reservation (steady-state). */
  cpuMillis: number;
  memoryMiB: number;
}

export interface SessionSpec {
  tier: SessionTier;
  durationSeconds: number;
  limits: SessionLimits;
  /** Steady-state reservation; `limits` is the burst ceiling. */
  baseline?: SessionBaseline;
  /** Present when the session is suspendable. */
  idlePolicy?: IdlePolicy;
  /** Wall-clock cap, including suspended time. */
  maxLifetimeSeconds?: number;
}

export interface CreateSessionRequest {
  /** Preset tier. If omitted, `durationSeconds` + limits are required. */
  tier?: SessionTier;
  durationSeconds?: number;
  cpuMillis?: number;
  memoryMiB?: number;
  diskMiB?: number;
  /** Customer ephemeral X25519 public key (base64, 32 bytes). */
  clientPublicKey: string;
  /** Customer freshness nonce (base64, 32 bytes) bound into attestation. */
  clientNonce: string;
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

/* ------------------------------------------------------------------ */
/* Operations (inside the encrypted envelope)                          */
/* ------------------------------------------------------------------ */

interface OperationBase {
  v: 2;
  sessionId: string;
  clientNonce: string;
  /** Client-generated correlation id (uuid/hex). Echoed in the response. */
  requestId: string;
}

export interface ExecOperation extends OperationBase {
  op: "exec";
  /** argv, executed without a shell. */
  command: string[];
  env?: Record<string, string>;
  /** Absolute path inside the workspace, or a path relative to it. */
  cwd?: string;
  stdin?: string;
  /** Requested timeout; the guest clamps to the lease and platform cap. */
  timeoutMs?: number;
}

export interface FilePutOperation extends OperationBase {
  op: "file.put";
  /** Workspace-relative or absolute path inside the workspace. */
  path: string;
  dataBase64: string;
  /** When true, dataBase64 is a gzipped tar archive extracted into path. */
  archive?: boolean;
  /** Octal mode, default 0644. */
  mode?: number;
}

export interface FileGetOperation extends OperationBase {
  op: "file.get";
  path: string;
  /** When true, package the path (file or directory) as a gzipped tar. */
  archive?: boolean;
}

export interface FileListOperation extends OperationBase {
  op: "file.list";
  path: string;
  recursive?: boolean;
}

export interface FileStatOperation extends OperationBase {
  op: "file.stat";
  path: string;
}

/** Start a long-running process (a local server) inside the sandbox. */
export interface ServiceStartOperation extends OperationBase {
  op: "service.start";
  name: string;
  command: string[];
  /** Loopback port the service is expected to listen on (1024-65535). */
  port: number;
  env?: Record<string, string>;
  cwd?: string;
}

export interface ServiceStopOperation extends OperationBase {
  op: "service.stop";
  name: string;
}

export interface ServiceListOperation extends OperationBase {
  op: "service.list";
}

/**
 * HTTP request to loopback only. The port must belong to a running service;
 * the guest never accepts a host, so this cannot reach the node or metadata.
 */
export interface HttpRequestOperation extends OperationBase {
  op: "http.request";
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
  timeoutMs?: number;
}

export interface HttpStreamOpenOperation extends OperationBase {
  op: "http.stream.open";
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
}

export interface HttpStreamReadOperation extends OperationBase {
  op: "http.stream.read";
  streamId: string;
}

export interface HttpStreamCloseOperation extends OperationBase {
  op: "http.stream.close";
  streamId: string;
}

export interface ServiceInfo {
  name: string;
  port: number;
  pid: number;
  state: "running" | "exited" | "stopped";
  startedAt: number;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export type GuestRequest =
  | ExecOperation
  | FilePutOperation
  | FileGetOperation
  | FileListOperation
  | FileStatOperation
  | ServiceStartOperation
  | ServiceStopOperation
  | ServiceListOperation
  | HttpRequestOperation
  | HttpStreamOpenOperation
  | HttpStreamReadOperation
  | HttpStreamCloseOperation;

export interface FileEntry {
  /** Workspace-relative path. */
  path: string;
  size: number;
  mode: number;
  isDir: boolean;
  mtimeMs: number;
}

interface ResultBase {
  v: 2;
  sessionId: string;
  clientNonce: string;
  requestId: string;
  /** False when the operation was rejected; see `error`. */
  ok: boolean;
  error?: { code: string; message: string };
}

export interface ExecResult extends ResultBase {
  ok: true;
  op: "exec";
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  truncated: { stdout: boolean; stderr: boolean };
}

export interface FilePutResult extends ResultBase {
  ok: true;
  op: "file.put";
  path: string;
  bytesWritten: number;
  filesWritten: number;
}

export interface FileGetResult extends ResultBase {
  ok: true;
  op: "file.get";
  path: string;
  dataBase64: string;
  size: number;
  archive: boolean;
}

export interface FileListResult extends ResultBase {
  ok: true;
  op: "file.list";
  path: string;
  entries: FileEntry[];
  totalBytes: number;
}

export interface FileStatResult extends ResultBase {
  ok: true;
  op: "file.stat";
  entry: FileEntry;
}

export interface OperationError extends ResultBase {
  ok: false;
  op: GuestRequest["op"];
}

export interface ServiceStartResult extends ResultBase {
  ok: true;
  op: "service.start";
  service: ServiceInfo;
}

export interface ServiceListResult extends ResultBase {
  ok: true;
  op: "service.list";
  services: ServiceInfo[];
}

export interface ServiceStopResult extends ResultBase {
  ok: true;
  op: "service.stop";
  name: string;
}

export interface HttpResponseResult extends ResultBase {
  ok: true;
  op: "http.request";
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
  truncated: boolean;
}

export interface HttpStreamOpenResult extends ResultBase {
  ok: true;
  op: "http.stream.open";
  streamId: string;
  status: number;
  headers: Record<string, string>;
}

export interface HttpStreamReadResult extends ResultBase {
  ok: true;
  op: "http.stream.read";
  chunkBase64?: string;
  pending?: boolean;
  done?: boolean;
}

export interface HttpStreamCloseResult extends ResultBase {
  ok: true;
  op: "http.stream.close";
  streamId: string;
}

export type GuestResult =
  | ExecResult
  | FilePutResult
  | FileGetResult
  | FileListResult
  | FileStatResult
  | ServiceStartResult
  | ServiceListResult
  | ServiceStopResult
  | HttpResponseResult
  | HttpStreamOpenResult
  | HttpStreamReadResult
  | HttpStreamCloseResult
  | OperationError;

/* ------------------------------------------------------------------ */
/* Attestation                                                         */
/* ------------------------------------------------------------------ */

export type ExecutionMode = "dev" | "kata" | "confidential";

export type EvidenceType = "dev-simulated" | "kata-dev-no-hw-attestation" | "sev-snp" | "tdx";

export interface AttestationClaims {
  /** Digest of the guest executable actually running. */
  guestMeasurement: string;
  /** Container image digest (immutable reference) reported by the runtime. */
  imageDigest: string;
  runtimeClass: string;
  /** Kernel identity. In a VM (Kata) this differs from the host kernel. */
  kernelRelease?: string;
  /** Tools available inside the sandbox (informational). */
  tools?: string[];
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
   * envelope with this flag set, and the SDK must refuse it unless
   * `allowInsecureDev` was passed explicitly.
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
/* Relay frames                                                        */
/* ------------------------------------------------------------------ */

export interface RelayRequestMessage {
  type: "request";
  /** Correlation id, chosen by the controller. */
  id: string;
  /** base64 sealed box for the guest. */
  envelope: string;
  /** Absolute epoch ms by which the operation must be abandoned. */
  deadlineMs: number;
}

export interface RelayCancelMessage {
  type: "cancel";
  id: string;
}

export interface RelayShutdownMessage {
  type: "shutdown";
  reason: string;
}

/**
 * Claim sent to a warm (pre-booted, unleased) guest. Everything the guest
 * needs to become a real session is here, so the pod template itself never
 * carries customer identity. The guest drops the pooled relay connection and
 * reconnects with `guestToken` before sending its session hello.
 */
export interface WarmClaim {
  sessionId: string;
  relayUrl: string;
  guestToken: string;
  clientPublicKey: string;
  clientNonce: string;
  leaseSeconds: number;
  executionMode: ExecutionMode;
  runtimeClass: string;
  imageDigest: string;
  proxyUrl: string;
  proxyToken: string;
  maxOutputBytes: number;
  maxFileBytes: number;
  maxDiskMiB: number;
  maxCommandSeconds: number;
  maxProcesses: number;
  tools: string;
}

/** Relay -> warm guest. */
export interface RelayClaimMessage {
  type: "claim";
  claim: WarmClaim;
}

export type RelayToGuest =
  | RelayRequestMessage
  | RelayCancelMessage
  | RelayShutdownMessage
  | RelayClaimMessage;

export interface GuestHelloMessage {
  type: "hello";
  evidence: AttestationEnvelope;
}

export interface GuestResponseMessage {
  type: "response";
  id: string;
  /** base64 sealed box for the customer. */
  envelope: string;
}

export interface GuestErrorMessage {
  type: "error";
  /** Present when the error belongs to a specific request. */
  id?: string;
  code: string;
  message: string;
}

export type GuestToRelay = GuestHelloMessage | GuestResponseMessage | GuestErrorMessage;

export interface RelaySessionState {
  registered: boolean;
  connected: boolean;
  attestation?: AttestationEnvelope;
  /** Number of requests awaiting a response. */
  pending: number;
  /** When the hello frame was received (epoch ms). */
  helloAt?: number;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Internal control plane (API <-> controller)                         */
/* ------------------------------------------------------------------ */

export interface EntitlementRequest {
  sessionId: string;
  capabilityHash: string;
  capabilityExpiresAt: number;
  spec: SessionSpec;
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
  state: SessionState;
}

export interface PaymentIntentStatus {
  status: "claimed" | "pending" | "settled" | "failed";
  sessionId?: string;
  reason?: string;
}
