/**
 * Client commitment: the payer wallet authorises the exact client key that
 * will receive the session capability.
 *
 * Without this, a PAYMENT-SIGNATURE is a bearer receipt: whoever holds it can
 * derive the capability after settlement, or bind the session to their own key
 * before the real client submits. The signature is made by the same wallet the
 * payment authorisation comes from (`authorization.from`), so a receipt thief
 * cannot produce it.
 */
import { canonicalJson } from "./crypto.js";

export const CLIENT_COMMITMENT_DOMAIN = "x402-sandbox/client-commitment/v1";

export interface ClientCommitmentInput {
  paymentKey: string;
  clientPublicKey: string;
  clientNonce: string;
}

/** Canonical message signed by the payer wallet. */
export function clientCommitmentMessage(input: ClientCommitmentInput): string {
  return canonicalJson({
    domain: CLIENT_COMMITMENT_DOMAIN,
    paymentKey: input.paymentKey,
    clientPublicKey: input.clientPublicKey,
    clientNonce: input.clientNonce,
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
