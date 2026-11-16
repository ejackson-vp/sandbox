/**
 * The operation row: one claimed request, its payload binding and its result.
 */
import type { SessionState } from "./session.js";

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
 * nothing to store. Applied at the write site in the Postgres adapter so the
 * bound is one decision.
 */
export function persistableResultEnvelope(envelope: string | null | undefined): string | null {
  if (!envelope) return null;
  return Buffer.byteLength(envelope, "utf8") > MAX_PERSISTED_RESULT_BYTES ? null : envelope;
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