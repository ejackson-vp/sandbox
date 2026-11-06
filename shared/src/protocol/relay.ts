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
