/**
 * Stable operation keys (#31, ADR 0011).
 *
 * A call that may be delivered more than once needs one name that is the same
 * on every attempt, is durable before the first send, and is derived from the
 * payment rather than from a process or a request. That name is the payment
 * key, which already identifies the money and already outlives the caller
 * (ADR 0001).
 *
 * Two consumers, one convention:
 *
 *  - `refund:<paymentKey>` is sent as `Idempotency-Key` on the refund webhook.
 *    The provider's contract is that the same key returns the original
 *    transaction and moves no funds again.
 *  - `settlement:<paymentKey>` names the grant-path operation for logs and
 *    diagnostics. The x402 facilitator protocol has no `Idempotency-Key`
 *    header: settlement is deduped by the EIP-3009 authorisation nonce inside
 *    the signed payload, on the facilitator side. The key is therefore naming,
 *    not transport, and this module does not pretend otherwise.
 *
 * The value is restricted to printable ASCII so it is safe as an HTTP header,
 * as a log field, and as a SQL parameter. Deriving it is pure: the same payment
 * always produces the same key, on every controller and after every restart.
 */

/** External systems this service calls and must not double-charge. */
export type OperationKind = "refund" | "settlement";

const KINDS: readonly OperationKind[] = ["refund", "settlement"];

/**
 * The durable identity of the work. Always the payment key: not a session id
 * (a payment may have no session), not a transaction id (it does not exist
 * before the call), not a claim token (it changes on every reclaim).
 */
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export interface OperationKey {
  readonly kind: OperationKind;
  readonly subject: string;
  /** `<kind>:<subject>`, the value a provider dedupes on. */
  readonly value: string;
}

/**
 * The textual prefix for a kind. Exported because one claim statement has to
 * build the key in SQL for rows that predate the column; a single source of
 * truth is what keeps the stored key and the derived key equal.
 */
export function keyPrefix(kind: OperationKind): string {
  return `${kind}:`;
}

export function operationKey(kind: OperationKind, subject: string): OperationKey {
  if (!KINDS.includes(kind)) {
    throw new TypeError(`unknown operation kind: ${JSON.stringify(kind)}`);
  }
  if (!SUBJECT_PATTERN.test(subject)) {
    // A key that varies, or that a transport mangles, silently defeats the
    // provider's dedupe, so a bad subject is a programming error, not data.
    throw new TypeError(`operation key subject is not a stable printable identity: ${JSON.stringify(subject)}`);
  }
  return { kind, subject, value: `${keyPrefix(kind)}${subject}` };
}

/** The refund webhook key. */
export function refundKey(paymentKey: string): OperationKey {
  return operationKey("refund", paymentKey);
}

/** The grant-path settlement name. Naming only, see the module comment. */
export function settlementKey(paymentKey: string): OperationKey {
  return operationKey("settlement", paymentKey);
}

/** Parse a stored or received key back into its parts, or null if malformed. */
export function parseOperationKey(value: string): OperationKey | null {
  const at = value.indexOf(":");
  if (at <= 0) return null;
  const kind = value.slice(0, at);
  if (!KINDS.includes(kind as OperationKind)) return null;
  try {
    return operationKey(kind as OperationKind, value.slice(at + 1));
  } catch {
    return null;
  }
}
