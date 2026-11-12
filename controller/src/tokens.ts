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
import { createHmac } from "node:crypto";
import { constantTimeEqual } from "./secrets.js";

/**
 * The claims a verified proxy token carries. Split out as a type so the token
 * format has a named contract and `verifyProxyToken` does not return an
 * anonymous object (#148).
 */
interface ProxyTokenClaims {
  sessionId: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** Present on v2 tokens only: the proxy shard the token is scoped to. */
  shard?: number;
}

type ProxyTokenVerification =
  | ({ ok: true } & ProxyTokenClaims)
  | { ok: false; reason: string };

/**
 * Stateless proxy token: v1.<expMs>.<sessionId>.<hmacBase64url>, or
 * v2.<expMs>.<shard>.<sessionId>.<hmacBase64url> when the proxy runs with more
 * than one replica.
 *
 * v2 is the same token, with one claim added, not a second credential format.
 * A single-replica deployment mints v1 unchanged so existing tokens and
 * deployments keep working. The MAC covers the shard, so a claim cannot be
 * stripped or rewritten in flight.
 */
export function mintProxyToken(secret: string, sessionId: string, ttlMs: number, shard?: number): string {
  const exp = Date.now() + ttlMs;
  const payload =
    shard === undefined ? `v1.${exp}.${sessionId}` : `v2.${exp}.${shard}.${sessionId}`;
  const mac = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function verifyProxyToken(
  secret: string,
  token: string,
): ProxyTokenVerification {
  const parts = token.split(".");
  let expRaw: string;
  let sessionId: string;
  let mac: string;
  let payload: string;
  let shard: number | undefined;
  if (parts.length === 4 && parts[0] === "v1") {
    [, expRaw, sessionId, mac] = parts as [string, string, string, string];
    payload = `v1.${expRaw}.${sessionId}`;
  } else if (parts.length === 5 && parts[0] === "v2") {
    let shardRaw: string;
    [, expRaw, shardRaw, sessionId, mac] = parts as [string, string, string, string, string];
    if (!/^\d{1,3}$/.test(shardRaw)) return { ok: false, reason: "malformed_token" };
    shard = Number(shardRaw);
    payload = `v2.${expRaw}.${shardRaw}.${sessionId}`;
  } else {
    return { ok: false, reason: "malformed_token" };
  }
  const exp = Number(expRaw);
  if (!Number.isSafeInteger(exp)) return { ok: false, reason: "malformed_token" };
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!constantTimeEqual(mac, expected)) return { ok: false, reason: "bad_token_signature" };
  if (Date.now() > exp) return { ok: false, reason: "token_expired" };
  return { ok: true, sessionId, expiresAt: exp, ...(shard !== undefined ? { shard } : {}) };
}

/**
 * Per-session relay guest token, optionally carrying the owning relay shard.
 *
 * The token stays opaque and is still verified by comparing its hash with the
 * one the controller registered, so the shard is a routing claim covered by
 * that hash rather than a separately trusted value. The opaque part is
 * base64url and therefore never contains a dot, so the suffix is unambiguous.
 */
export function guestTokenFor(token: string, shard?: number): string {
  return shard === undefined ? token : `${token}.${shard}`;
}

/** The shard claim on a relay guest token, or null when it carries none. */
export function guestTokenShard(token: string): number | null {
  const match = /\.(\d{1,3})$/.exec(token);
  return match ? Number(match[1]) : null;
}
