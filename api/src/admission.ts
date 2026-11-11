/**
 * Admission control primitives.
 *
 * Two buckets guard session creation:
 *   - a coarse per-source-IP bucket before the payment is decoded (anti-abuse),
 *   - a per-payer bucket after the payment payload is decoded but before the
 *     payment is claimed or settled (fairness for a paid, multi-tenant API).
 *
 * The payer key comes from the unverified EIP-3009 authorization. That is fine
 * for rate limiting (it is not a trust decision): an attacker who spoofs the
 * `from` field only moves their own bucket, and the IP bucket still bounds the
 * total. The verified payer is recorded separately on the payment.
 *
 * The token-bucket implementation lives in `@x402s/shared/runtime` so the
 * controller and relay use the same bounded table for their internal listeners.
 */

export { TokenBucket as RateLimiter } from "@x402s/shared/runtime";

/**
 * Best-effort payer identity from an x402 payment payload. Falls back to the
 * source IP for schemes that do not carry an `authorization.from`.
 */
export function paymentPayerKey(payload: unknown, ip: string): string {
  const p = payload as { payload?: Record<string, unknown> } | undefined;
  const auth = p?.payload?.authorization as { from?: unknown } | undefined;
  if (typeof auth?.from === "string" && /^0x[0-9a-fA-F]{40}$/.test(auth.from)) {
    return `payer:${auth.from.toLowerCase()}`;
  }
  return `ip:${ip}`;
}
