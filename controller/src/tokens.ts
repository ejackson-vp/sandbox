/**
 * Ephemeral, possession-based credentials.
 *
 *  - Session capability: 32 random bytes returned to the buyer once. Only its
 *    SHA-256 hash is persisted, and it is scoped to exactly one session id.
 *  - Guest relay token: per-sandbox random credential handed to the guest
 *    process, stored hashed at the relay, TTL-bound.
 *  - Egress proxy token: stateless HMAC token bound to the session id so the
 *    proxy can authorise (and bill attribution) without a database.
 *
 * None of these are user accounts or long-lived API keys.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function newOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Stateless proxy token: v1.<expMs>.<sessionId>.<hmacBase64url> */
export function mintProxyToken(secret: string, sessionId: string, ttlMs: number): string {
  const exp = Date.now() + ttlMs;
  const payload = `v1.${exp}.${sessionId}`;
  const mac = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function verifyProxyToken(
  secret: string,
  token: string,
): { ok: true; sessionId: string; expiresAt: number } | { ok: false; reason: string } {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return { ok: false, reason: "malformed_token" };
  const [, expRaw, sessionId, mac] = parts as [string, string, string, string];
  const exp = Number(expRaw);
  if (!Number.isSafeInteger(exp)) return { ok: false, reason: "malformed_token" };
  const expected = createHmac("sha256", secret).update(`v1.${expRaw}.${sessionId}`).digest("base64url");
  if (!constantTimeEqual(mac, expected)) return { ok: false, reason: "bad_token_signature" };
  if (Date.now() > exp) return { ok: false, reason: "token_expired" };
  return { ok: true, sessionId, expiresAt: exp };
}
