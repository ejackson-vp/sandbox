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
  /** System-defined runtime profile selected for this claim. */
  runtime?: string;
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

/**
 * Frame protocol this build speaks. Bump it when a change to the frames is not
 * backward compatible, and raise `MIN_SUPPORTED_GUEST_PROTOCOL_VERSION` only
 * once every guest image an operator may still be running has been replaced.
 *
 * This is the first versioned frame set: the fields added here are optional, so
 * a build that omits them speaks the same frames and is version 1 too.
 */
export const GUEST_PROTOCOL_VERSION = 1;

/**
 * Oldest guest frame protocol this build can serve.
 *
 * A guest that predates versioning sends no `protocolVersion` at all. During a
 * controller rollout a warm pool still holds pods from the previous image, so
 * an absent field is treated as exactly this value: it is accepted, never
 * rejected. Only a version below this floor is unsupported.
 */
export const MIN_SUPPORTED_GUEST_PROTOCOL_VERSION = 1;

/**
 * Whether a hello version is within the accepted range.
 *
 * The rule is deliberately one-sided: there is no upper bound. A newer guest
 * image may reach a warm pool before the controller that will claim it is
 * upgraded, and a higher version means the guest speaks a superset of the
 * frames this controller sends. Rejecting it would break that rollout
 * direction; rejecting an old guest is the case this negotiation exists for.
 */
export function supportsGuestProtocolVersion(version: number | undefined): boolean {
  if (version === undefined) return true;
  if (!Number.isInteger(version) || version < 0) return false;
  return version >= MIN_SUPPORTED_GUEST_PROTOCOL_VERSION;
}

/** Relay -> warm guest. */
export interface GuestHelloMessage {
  type: "hello";
  /**
   * Frame protocol the guest speaks. Optional: a guest built before the field
   * existed omits it and is treated as `MIN_SUPPORTED_GUEST_PROTOCOL_VERSION`.
   */
  protocolVersion?: number;
  /**
   * Operation verbs the guest implements, so the controller can see what a
   * session can do without probing it. Optional and operational only; never
   * carries customer data.
   */
  capabilities?: readonly string[];
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
  /** Frame protocol the guest reported on hello; absent for a pre-versioning guest. */
  protocolVersion?: number;
  /** Operation verbs the guest reported on hello; absent when it sent none. */
  capabilities?: readonly string[];
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

/**
 * A registry snapshot stamped with the identity of the relay process that
 * produced it. The generation and the session fields come from the same process
 * and the same event-loop turn, so a snapshot cannot be half old and half new
 * the way a separate health probe before and after a read can be.
 */
export interface RelayStateSnapshot extends RelaySessionState {
  generation: string;
}
