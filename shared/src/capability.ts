/**
 * Session capabilities and the key ring that signs them.
 *
 * A capability is the base64url HMAC of the payment key and the client
 * commitment, prefixed with the id of the key that produced it:
 *
 *     k1.<43-char base64url HMAC-SHA256>
 *
 * The MAC input is byte-for-byte the `x402-capability:v2:<paymentKey>:<commitment>`
 * derivation that F-08 introduced. Adding the key id changes the envelope, not
 * the derivation, so the same key always yields the same MAC and a rotation
 * never re-derives an existing capability differently (#61).
 *
 * Rotation order is: add a new key, switch signing to it, retire the old key
 * after the longest capability could still be live. During the overlap the ring
 * holds both, so a capability minted under either key verifies. `previous` is
 * only ever a verification/re-derivation key; nothing new is signed with it.
 *
 * Two shapes are accepted:
 *   - `k1.<mac>` — minted since the key id existed;
 *   - `<mac>` — the bare form from before it, still valid while its session
 *     lives. `splitCapability` returns `keyId: null` for it.
 * Retiring a key removes its id from the ring, which rejects the prefixed form
 * immediately instead of waiting for the session to expire.
 *
 * Nothing in this module logs or measures a secret: the key id is the only part
 * of a key that may appear in a log line or a metric label.
 */
import { createHmac } from "node:crypto";
import { sha256Hex } from "./crypto.js";

/** Key ids are operator-chosen, short and public. No dot: it is the separator. */
export const CAPABILITY_KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;

export interface CapabilityKey {
  /** Public id written into the token. Safe to log. */
  id: string;
  /** HMAC key. Never logged, never a metric label, never in an error message. */
  secret: string;
}

export interface CapabilityKeyRing {
  /** The only key new capabilities are signed with. */
  signing: CapabilityKey;
  /** Signing key first, then older keys still inside the overlap window. */
  verify: CapabilityKey[];
}

export interface CapabilityKeyInput {
  keyId: string;
  secret: string;
  /** Retired-later key accepted during the overlap window. */
  previous?: { keyId: string; secret: string };
}

export function capabilityKeyRing(input: CapabilityKeyInput): CapabilityKeyRing {
  const signing = { id: input.keyId, secret: input.secret };
  return {
    signing,
    verify: input.previous ? [signing, { id: input.previous.keyId, secret: input.previous.secret }] : [signing],
  };
}

/**
 * The MAC for one key. The input string is the F-08 derivation and must not
 * change: a new prefix here would invalidate every live capability again.
 */
export function capabilityMac(secret: string, paymentKey: string, commitment: string): string {
  return createHmac("sha256", secret)
    .update(`x402-capability:v2:${paymentKey}:${commitment}`)
    .digest("base64url");
}

/** Sign a capability with one key, in the current (key-id prefixed) shape. */
export function mintCapability(key: CapabilityKey, paymentKey: string, commitment: string): string {
  return `${key.id}.${capabilityMac(key.secret, paymentKey, commitment)}`;
}

/** Split a token into its key id (null for the legacy bare form) and its MAC. */
export function splitCapability(token: string): { keyId: string | null; mac: string } {
  const dot = token.indexOf(".");
  if (dot < 0) return { keyId: null, mac: token };
  return { keyId: token.slice(0, dot), mac: token.slice(dot + 1) };
}

/**
 * Whether the ring knows the key that signed a presented token.
 *
 * Unknown ids are rejected rather than merely compared: a capability signed by
 * a retired key is refused on the spot, even if its stored hash still matches.
 */
export function ringAcceptsToken(ring: CapabilityKeyRing, token: string): boolean {
  const { keyId } = splitCapability(token);
  if (keyId === null) return true;
  return ring.verify.some((key) => key.id === keyId);
}

/**
 * Re-derive the exact capability a session was issued, across rotation.
 *
 * Used by the create-replay paths, which must return the same token the client
 * already holds rather than a fresh one signed with the new key (its hash would
 * not match the stored `capabilityHash`). Tries the signing key, then each
 * verification key, in both token shapes, and returns the first candidate whose
 * SHA-256 equals the stored hash. Returns null when no key in the ring can
 * produce it, which is a retired key and a fail-closed condition.
 */
export function recoverCapability(
  ring: CapabilityKeyRing,
  paymentKey: string,
  commitment: string,
  storedHash: string,
): string | null {
  for (const key of ring.verify) {
    const mac = capabilityMac(key.secret, paymentKey, commitment);
    for (const candidate of [`${key.id}.${mac}`, mac]) {
      if (sha256Hex(candidate) === storedHash) return candidate;
    }
  }
  return null;
}
