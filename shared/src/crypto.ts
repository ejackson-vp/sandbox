/**
 * Confidentiality primitives.
 *
 * We use libsodium's `crypto_box_seal` (X25519 + XSalsa20-Poly1305, with an
 * ephemeral sender key hashed into the nonce). The Go guest runtime uses
 * golang.org/x/crypto/nacl/box SealAnonymous/OpenAnonymous, which implements the
 * identical construction. No primitives are invented here.
 *
 * Interop is covered by tests/unit/crypto-interop.test.ts.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import sodium from "libsodium-wrappers";

let readyPromise: Promise<void> | undefined;

export async function initCrypto(): Promise<void> {
  readyPromise ??= sodium.ready.then(() => undefined);
  return readyPromise;
}

export interface BoxKeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export const KEY_BYTES = 32;
export const NONCE_BYTES = 32;
/** Hard cap on ciphertext we accept over the wire (1 MiB). */
export const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;

export async function generateBoxKeyPair(): Promise<BoxKeyPair> {
  await initCrypto();
  const kp = sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

export async function generateNonce(): Promise<Uint8Array> {
  await initCrypto();
  return sodium.randombytes_buf(NONCE_BYTES);
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Anonymous public-key encryption to `recipientPublicKey`. */
export async function sealTo(recipientPublicKey: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  await initCrypto();
  if (recipientPublicKey.length !== KEY_BYTES) throw new Error("invalid recipient public key length");
  return sodium.crypto_box_seal(plaintext, recipientPublicKey);
}

/**
 * Open a sealed box. Throws a generic error on any authentication failure; we
 * never leak decryption details (padding/format oracles).
 */
export async function openSealed(
  ciphertext: Uint8Array,
  recipientPublicKey: Uint8Array,
  recipientPrivateKey: Uint8Array,
): Promise<Uint8Array> {
  await initCrypto();
  try {
    const out = sodium.crypto_box_seal_open(ciphertext, recipientPublicKey, recipientPrivateKey);
    if (!out) throw new Error("empty plaintext");
    return out;
  } catch {
    throw new Error("decryption failed");
  }
}

export async function sealJsonTo(recipientPublicKey: Uint8Array, value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return toBase64(await sealTo(recipientPublicKey, bytes));
}

export async function openSealedJson<T>(
  envelopeB64: string,
  recipientPublicKey: Uint8Array,
  recipientPrivateKey: Uint8Array,
): Promise<T> {
  const raw = fromBase64(envelopeB64);
  if (raw.length > MAX_ENVELOPE_BYTES) throw new Error("envelope too large");
  const plain = await openSealed(raw, recipientPublicKey, recipientPrivateKey);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)) as T;
}

export function sha256Hex(data: string | Uint8Array): string {
  // Node's crypto is used only for hashing/identity, not for secrecy.
  return createHash("sha256").update(data).digest("hex");
}

/** Constant-time comparison for capability hashes. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Stable JSON serialization used for signature payloads and payment identity
 * keys. Sorts object keys recursively so independent implementations agree.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
