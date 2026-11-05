/**
 * Attestation evidence verification.
 *
 * The verifier is a pure function of (envelope, expected session bindings,
 * policy). It fails closed on any structural or cryptographic problem and has
 * no way to "fall back" to accepting unverified evidence.
 *
 * Modes:
 *   dev          - simulated Ed25519 evidence from the published dev key.
 *                  Requires explicit allowInsecureDev.
 *   kata         - simulated evidence produced inside a Kata VM. Still no
 *                  hardware root of trust; requires allowInsecureDev.
 *   confidential - requires hardware evidence (SEV-SNP / TDX) verified through
 *                  the Trustee-backed verifier. Not implemented locally:
 *                  `verifyHardwareEvidence` throws unless a verifier plugin is
 *                  installed, which is intentional fail-closed behaviour.
 */
import { createPublicKey, verify as edVerify } from "node:crypto";
import type { AttestationEnvelope, EvidenceType, ExecutionMode } from "./protocol.js";
import { canonicalJson } from "./crypto.js";
import { DEV_ATTESTATION_KEY_ID, DEV_ATTESTATION_PUBLIC_KEY } from "./dev-attestation.js";

export interface AttestationPolicy {
  mode: ExecutionMode;
  allowInsecureDev: boolean;
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

const HARDWARE_EVIDENCE_TYPES: readonly EvidenceType[] = ["sev-snp", "tdx"];

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
  const hardware = e.evidenceType === "sev-snp" || e.evidenceType === "tdx";
  const hardwareClaim = e.hardwareBacked === true;

  if (hardware !== hardwareClaim) {
    return fail("inconsistent_evidence", "evidence type and hardwareBacked claim disagree");
  }

  if (policy.mode === "confidential") {
    if (!hardware) {
      return fail("not_hardware_backed", "confidential mode requires SEV-SNP or TDX evidence");
    }
    if (!HARDWARE_EVIDENCE_TYPES.includes(e.evidenceType)) {
      return fail("not_hardware_backed", "confidential mode requires hardware evidence");
    }
    if (!e.report || typeof e.report !== "string" || e.report.length < 256) {
      return fail("missing_report", "hardware evidence report is missing");
    }
    // Hardware evidence must be verified by a Trustee-backed verifier. We never
    // accept a signature-only claim of hardware backing.
    return verifyHardwareEvidence(e, policy);
  }

  // Dev/kata modes: simulated evidence must be explicitly labelled and opted in.
  if (!e.insecureDevOnly) {
    return fail("unexpected_hardware_claim", "non-hardware execution must be labelled insecureDevOnly");
  }
  if (e.evidenceType === "sev-snp" || e.evidenceType === "tdx") {
    return fail("downgrade", "hardware evidence presented in simulated mode");
  }
  if (!policy.allowInsecureDev) {
    return fail("insecure_dev_not_allowed", "simulated attestation requires --allow-insecure-dev");
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
    "SIMULATED ATTESTATION: no hardware root of trust; confidentiality is not enforced.",
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

/**
 * Production hardware evidence verification hook.
 *
 * Intentionally unimplemented in this repository. A real implementation talks
 * to Trustee / a SEV-SNP or TDX verifier and checks the report data against the
 * envelope's guest key and nonce. Returning a failure here (instead of a
 * signature-only success) is what makes "never downgrade" true.
 */
function verifyHardwareEvidence(env: AttestationEnvelope, policy: AttestationPolicy): AttestationResult {
  void env;
  void policy;
  return fail(
    "hardware_verifier_unavailable",
    "no SEV-SNP/TDX verifier is installed; refusing to accept hardware evidence (fail closed)",
  );
}
