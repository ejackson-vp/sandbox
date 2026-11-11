/**
 * Client commitment: the payer wallet authorises the exact client key that
 * will receive the session capability, for one server-issued challenge.
 *
 * Without this, a PAYMENT-SIGNATURE is a bearer receipt: whoever holds it can
 * derive the capability after settlement, or bind the session to their own key
 * before the real client submits. The signature is made by the same wallet the
 * payment authorisation comes from (`authorization.from`), so a receipt thief
 * cannot produce it.
 *
 * The `challengeNonce` is issued by the server in the 402 challenge and burned
 * on first use, so the signature is bound to a live challenge rather than to
 * (payment, client key) alone. A captured *complete* create request is then only
 * replayable inside that challenge's TTL, and only until the original lands;
 * see security-review/FINDINGS.md F-07.
 */
import { canonicalJson } from "./crypto.js";

/** v2 adds `challengeNonce`. A v1 signature is not accepted by a v2 verifier. */
export const CLIENT_COMMITMENT_DOMAIN = "x402-sandbox/client-commitment/v2";

/** Shape of a server-issued challenge nonce: `cn_` + 128 bits of hex. */
export const CHALLENGE_NONCE_PATTERN = /^cn_[0-9a-f]{32}$/;

export function isChallengeNonce(value: unknown): value is string {
  return typeof value === "string" && CHALLENGE_NONCE_PATTERN.test(value);
}

export interface ClientCommitmentInput {
  paymentKey: string;
  clientPublicKey: string;
  clientNonce: string;
  /**
   * Server-issued, single-use challenge value. Required: an empty or missing
   * value produces a different message, so it cannot be silently omitted.
   */
  challengeNonce: string;
}

/** Canonical message signed by the payer wallet. */
export function clientCommitmentMessage(input: ClientCommitmentInput): string {
  return canonicalJson({
    domain: CLIENT_COMMITMENT_DOMAIN,
    paymentKey: input.paymentKey,
    clientPublicKey: input.clientPublicKey,
    clientNonce: input.clientNonce,
    challengeNonce: input.challengeNonce,
  });
}

/**
 * Extract the EIP-3009 authorising address from an x402 payload. Both the mock
 * scheme and @x402/evm's exact scheme use this shape.
 */
export function paymentAuthorizer(payload: unknown): `0x${string}` | null {
  const auth = (payload as { payload?: { authorization?: { from?: unknown } } } | undefined)?.payload
    ?.authorization;
  if (typeof auth?.from === "string" && /^0x[0-9a-fA-F]{40}$/.test(auth.from)) {
    return auth.from as `0x${string}`;
  }
  return null;
}

/**
 * The EIP-3009 authorisation nonce, when the payload carries one. Recorded on
 * the ledger so a facilitator refund or reconciliation webhook can be keyed by
 * it as well as by the payment key.
 */
export function settlementNonce(payload: unknown): string | null {
  const auth = (payload as { payload?: { authorization?: { nonce?: unknown } } } | undefined)?.payload
    ?.authorization;
  return typeof auth?.nonce === "string" && /^0x[0-9a-fA-F]{64}$/.test(auth.nonce)
    ? auth.nonce.toLowerCase()
    : null;
}
