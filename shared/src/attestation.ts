/**
 * Session key-binding verification.
 *
 * The guest signs a statement binding its ephemeral public key to the session
 * id, the client nonce and the client's public key. The verifier is a pure
 * function of (envelope, expected bindings, policy) and fails closed on any
 * structural or cryptographic problem.
 *
 * What this proves: the guest holds the private key for the key the client is
 * about to seal commands to, and that key is bound to this session.
 *
 * What this does NOT prove: which software is running in the guest. There is no
 * hardware root of trust here, so a malicious cluster operator could run a
 * different guest and sign the same statement. Isolation comes from the VM
 * boundary (Kata), not from this signature.
 *
 * Modes:
 *   dev  - simulated Ed25519 evidence from the published dev key.
 *   kata - simulated evidence produced inside a Kata VM.
 */
import { createPublicKey, verify as edVerify } from "node:crypto";
import type { AttestationEnvelope, EvidenceType, ExecutionMode } from "./protocol.js";
import { canonicalJson } from "./crypto.js";
import { DEV_ATTESTATION_KEY_ID, DEV_ATTESTATION_PUBLIC_KEY } from "./dev-attestation.js";

export interface AttestationPolicy {
  mode: ExecutionMode;
  expectedSessionId: string;
  expectedClientNonce: string;
  expectedClientPublicKey: string;
  /** Optional allowlist of guest measurement digests (hex). */
  allowedMeasurements?: string[];
  /** Optional allowlist of approved evidence types. */
  allowedEvidenceTypes?: EvidenceType[];
  /** Maximum accepted evidence age in ms (default 120s). */
  maxEvidenceAgeMs?: number;
  /** Clock skew allowance (default 60s). */
  clockSkewMs?: number;
  now?: number;
}

export type AttestationResult =
  | {
      ok: true;
      mode: ExecutionMode;
      hardwareBacked: boolean;
      insecureDevOnly: boolean;
      evidenceType: EvidenceType;
      guestMeasurement: string;
      warnings: string[];
    }
  | { ok: false; code: string; message: string };

export function canonicalEvidenceBytes(env: AttestationEnvelope): Uint8Array {
  const unsigned = { ...env, signature: undefined };
  return new TextEncoder().encode(canonicalJson(unsigned));
}

/** Rebuild a Node KeyObject from a raw 32-byte Ed25519 public key. */
function ed25519PublicKeyFromRaw(raw: Uint8Array) {
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  return createPublicKey({ key: Buffer.concat([spkiPrefix, Buffer.from(raw)]), format: "der", type: "spki" });
}

function fail(code: string, message: string): AttestationResult {
  return { ok: false, code, message };
}

/**
 * Verify an attestation envelope against a policy.
 *
 * This function is deliberately synchronous and dependency-free so it can be
 * reused by the CLI, tests, and the API's server-side gate.
 */
export function verifyAttestation(env: unknown, policy: AttestationPolicy): AttestationResult {
  const now = policy.now ?? Date.now();
  const skew = policy.clockSkewMs ?? 60_000;
  const maxAge = policy.maxEvidenceAgeMs ?? 120_000;

  if (!env || typeof env !== "object") return fail("malformed", "evidence is not an object");
  const e = env as AttestationEnvelope;

  // --- structural checks (order matters: cheap first, but all fail closed) ---
  if (e.v !== 1) return fail("unsupported_version", "unsupported evidence version");
  if (!e.signature || e.signature.alg !== "ed25519" || typeof e.signature.value !== "string") {
    return fail("malformed", "missing signature");
  }
  if (typeof e.sessionId !== "string" || typeof e.clientNonce !== "string" || typeof e.guestPublicKey !== "string") {
    return fail("malformed", "missing binding fields");
  }
  if (typeof e.issuedAt !== "number" || typeof e.expiresAt !== "number") {
    return fail("malformed", "missing validity window");
  }
  if (!e.claims || typeof e.claims.guestMeasurement !== "string") {
    return fail("malformed", "missing claims");
  }

  const allowedTypes = policy.allowedEvidenceTypes;
  if (allowedTypes && !allowedTypes.includes(e.evidenceType)) {
    return fail("evidence_type_not_allowed", `evidence type ${e.evidenceType} is not allowed by policy`);
  }

  // --- freshness ---
  if (e.expiresAt <= now) return fail("expired", "evidence has expired");
  if (e.issuedAt > now + skew) return fail("stale_clock", "evidence issued in the future");
  if (now - e.issuedAt > maxAge) return fail("stale", "evidence is older than the accepted window");

  // --- session binding (prevents cross-session replay/substitution) ---
  if (e.sessionId !== policy.expectedSessionId) return fail("session_mismatch", "evidence bound to another session");
  if (e.clientNonce !== policy.expectedClientNonce) return fail("nonce_mismatch", "evidence nonce does not match request");
  if (e.clientPublicKey !== policy.expectedClientPublicKey) {
    return fail("client_key_mismatch", "evidence bound to a different client key");
  }

  // --- signature over the exact canonical bytes ---
  const keyId = e.signature.keyId;
  const devKey = keyId === DEV_ATTESTATION_KEY_ID;
  if (!devKey) return fail("unknown_signing_key", "evidence signed by an unpinned key");

  const rawPub = new Uint8Array(Buffer.from(DEV_ATTESTATION_PUBLIC_KEY, "base64"));
  if (rawPub.length !== 32) return fail("verifier_misconfigured", "pinned dev key is malformed");

  let sigOk = false;
  try {
    sigOk = edVerify(
      null,
      canonicalEvidenceBytes(e),
      ed25519PublicKeyFromRaw(rawPub),
      new Uint8Array(Buffer.from(e.signature.value, "base64")),
    );
  } catch {
    sigOk = false;
  }
  if (!sigOk) return fail("bad_signature", "evidence signature verification failed");

  // --- simulated-vs-hardware separation ---
  // There is no hardware evidence path in this product: any claim of hardware
  // backing is rejected outright rather than downgraded.
  const hardwareClaim = e.hardwareBacked === true;
  if (hardwareClaim) {
    return fail("inconsistent_evidence", "simulated evidence cannot claim hardware backing");
  }

  // Dev/kata modes: simulated evidence must be explicitly labelled.
  if (!e.insecureDevOnly) {
    return fail("unexpected_hardware_claim", "non-hardware execution must be labelled insecureDevOnly");
  }
  if (policy.mode === "kata" && e.evidenceType !== "kata-dev-no-hw-attestation") {
    return fail("evidence_type_not_allowed", "kata mode expects kata-dev-no-hw-attestation evidence");
  }
  if (policy.mode === "dev" && e.evidenceType !== "dev-simulated") {
    return fail("evidence_type_not_allowed", "dev mode expects dev-simulated evidence");
  }

  // --- measurement policy ---
  if (policy.allowedMeasurements && policy.allowedMeasurements.length > 0) {
    const ok = policy.allowedMeasurements
      .map((m) => m.toLowerCase())
      .includes(e.claims.guestMeasurement.toLowerCase());
    if (!ok) return fail("measurement_not_allowed", "guest measurement is not in the allowlist");
  }

  const warnings: string[] = [
    "NO HARDWARE ROOT OF TRUST: this binds the guest's session key, it does not prove which software the guest is running.",
  ];
  if (policy.mode === "kata") {
    warnings.push("Kata VM detected via guest kernel, but evidence is not hardware-backed.");
  }
  if (!policy.allowedMeasurements || policy.allowedMeasurements.length === 0) {
    warnings.push("No measurement allowlist configured; measurement was not pinned.");
  }

  return {
    ok: true,
    mode: policy.mode,
    hardwareBacked: false,
    insecureDevOnly: true,
    evidenceType: e.evidenceType,
    guestMeasurement: e.claims.guestMeasurement,
    warnings,
  };
}
