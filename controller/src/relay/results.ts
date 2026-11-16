/**
 * What a relay call can answer.
 *
 * The registry produces these and the HTTP and WebSocket transports map them to
 * status codes, so they live on their own: a transport can read the vocabulary
 * without importing the 400-line registry that fills it in.
 */

/**
 * Why the relay could not produce an outcome for a request it accepted.
 *
 * `guest_disconnected` and `request_superseded` are link-loss classes: the
 * frame may have been started, so the controller must treat the operation as
 * `outcome_unknown`, never as a guest error. `guest_error` is the guest itself
 * reporting a failed operation, and `session_destroyed` means the session is
 * being torn down.
 */
export type RelayFailureCode =
  | "guest_disconnected"
  | "request_superseded"
  | "session_destroyed"
  | "guest_error";

/** What a pending waiter is resolved with. */
export type WaiterValue =
  | { envelope: string }
  | { error: RelayFailureCode; message: string }
  | null;

export type RegisterResult = "ok" | "already_connected" | "at_capacity";

export type RequestResult =
  | "sent"
  | "cached"
  | "pending"
  | "too_many"
  | "not_connected"
  | "not_registered"
  | "stale_epoch";

export type EpochResult = "ok" | "unknown";

export interface RaiseEpochResult {
  result: EpochResult;
  /** Pending frames dropped from the superseded generation. */
  withdrawn: number;
  /** Whether the guest link was reset to discard an unread frame. */
  reset: boolean;
}

export type SendResult = "sent" | "not_registered" | "not_connected";

export type AttachResult =
  | "ok"
  | "not_found"
  | "expired"
  | "bad_token"
  | "wrong_shard"
  | "connected";

export type WaitResult =
  | { kind: "envelope"; envelope: string }
  | { kind: "error"; code: RelayFailureCode; message: string }
  | { kind: "pending"; stillPending: boolean }
  | { kind: "not_registered" };
