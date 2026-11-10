/**
 * Relay frames and warm-claim handoff between controller, relay and guest.
 */
import type { AttestationEnvelope, ExecutionMode } from "./attestation.js";

export interface RelayRequestMessage {
  type: "request";
  /** Correlation id, chosen by the controller. */
  id: string;
  /** base64 sealed box for the guest. */
  envelope: string;
  /** Absolute epoch ms by which the operation must be abandoned. */
  deadlineMs: number;
  /**
   * Execution-epoch fence. The controller bumps a session's epoch when it
   * recovers an interrupted operation and publishes the new epoch to the relay
   * before the fence can clear. The relay refuses a frame below that floor and
   * withdraws a frame already forwarded from the superseded generation, so a
   * frame from a previous controller generation can never start after
   * recovery. The guest also refuses a frame below its own high-water mark.
   */
  epoch: number;
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

/**
 * Guest -> relay execution state. Sent on hello, when an operation takes the
 * single slot, and when it releases it. The relay exposes this to the
 * controller so restart recovery can tell whether the fenced operation is
 * still running without relying on timing.
 */
export interface GuestStatusMessage {
  type: "status";
  /** Empty while the guest has no operation in flight. */
  activeRequestId: string;
  /** Highest execution epoch the guest has observed. */
  epoch: number;
}

export type GuestToRelay =
  | GuestHelloMessage
  | GuestResponseMessage
  | GuestErrorMessage
  | GuestStatusMessage;

export interface RelaySessionState {
  registered: boolean;
  connected: boolean;
  attestation?: AttestationEnvelope;
  /** Number of requests awaiting a response. */
  pending: number;
  /** When the hello frame was received (epoch ms). */
  helloAt?: number;
  /** Guest-reported operation in flight; absent until the guest reports status. */
  activeRequestId?: string;
  /** Highest execution epoch the guest has observed. */
  execEpoch?: number;
  /**
   * Lowest execution epoch the relay will forward. The controller raises it to
   * `sessions.exec_epoch` on recovery; a frame below it is rejected with
   * `stale_epoch` and never reaches the guest. Absent means the relay has no
   * registration for the session.
   */
  epochFloor?: number;
  /** When the guest last reported its execution state (epoch ms). */
  statusAt?: number;
  error?: string;
}
