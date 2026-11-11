/**
 * Hash, compare and random primitives for secrets.
 *
 * These are not part of any token format. They live here rather than in
 * `tokens.ts` because seven modules needed one of them while only five need
 * the proxy or guest token wire format, so keeping them together made every
 * token-format change look as wide as every hashing change (#148).
 *
 * No state, no I/O: node:crypto only.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Compare two strings without leaking their common prefix length through
 * timing. Length is compared first because `timingSafeEqual` throws on a
 * length mismatch; no caller here treats length as the secret.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** A URL-safe random credential, 256 bits by default. */
export function newOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
