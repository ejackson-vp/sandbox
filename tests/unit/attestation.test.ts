/**
 * Attestation verifier unit tests. These encode the fail-closed policy:
 * simulated evidence is only accepted with an explicit override, hardware
 * evidence is never accepted from a signature alone, and every binding is
 * checked.
 */
import { describe, expect, it } from "vitest";
import { createPrivateKey, sign } from "node:crypto";
import {
  canonicalEvidenceBytes,
  DEV_ATTESTATION_KEY_ID,
  DEV_ATTESTATION_PUBLIC_KEY,
  verifyAttestation,
  type AttestationPolicy,
} from "../../shared/src/entries/crypto.js";
import { type AttestationEnvelope } from "../../shared/src/entries/protocol.js";

const SEED_B64 = "qSgP+dPwGhb/58O0ZD/dSqCMovhhWNIQbT3MeTD35WY=";
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function signEnvelope(env: AttestationEnvelope): AttestationEnvelope {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(SEED_B64, "base64")]),
    format: "der",
    type: "pkcs8",
  });
  const sig = sign(null, canonicalEvidenceBytes(env), key);
  return { ...env, signature: { alg: "ed25519", keyId: DEV_ATTESTATION_KEY_ID, value: sig.toString("base64") } };
}

const SESSION = "sbx_0123456789abcdef01234567";
const NONCE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const CLIENT_KEY = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=";

function makeEvidence(overrides: Partial<AttestationEnvelope> = {}): AttestationEnvelope {
  const now = Date.now();
  return signEnvelope({
    v: 1,
    evidenceType: "dev-simulated",
    insecureDevOnly: true,
    hardwareBacked: false,
    sessionId: SESSION,
    guestPublicKey: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA=",
    clientPublicKey: CLIENT_KEY,
    clientNonce: NONCE,
    bootNonce: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA=",
    issuedAt: now - 1000,
    expiresAt: now + 60_000,
    claims: {
      guestMeasurement: "a".repeat(64),
      imageDigest: "sha256:test",
      runtimeClass: "x402-sandbox",
      hardwareBacked: false,
      guestPolicyEnforced: false,
    },
    report: "",
    signature: { alg: "ed25519", keyId: DEV_ATTESTATION_KEY_ID, value: "" },
    ...overrides,
  });
}

const basePolicy: AttestationPolicy = {
  mode: "dev",
  expectedSessionId: SESSION,
  expectedClientNonce: NONCE,
  expectedClientPublicKey: CLIENT_KEY,
};

describe("attestation verifier", () => {
  it("accepts correctly bound dev evidence", () => {
    const env = makeEvidence();
    const ok = verifyAttestation(env, basePolicy);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.hardwareBacked).toBe(false);
      expect(ok.insecureDevOnly).toBe(true);
      expect(ok.warnings.join(" ")).toMatch(/NO HARDWARE ROOT/);
    }
  });

  it("rejects simulated evidence when the policy forbids it", () => {
    const res = verifyAttestation(makeEvidence(), { ...basePolicy, allowInsecureDev: false });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("insecure_dev_rejected");
  });

  it("refuses any claim of hardware backing (no such path exists)", () => {    const env = makeEvidence({ hardwareBacked: true, insecureDevOnly: false });
    const res = verifyAttestation(env, basePolicy);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("inconsistent_evidence");
  });

  it("rejects mismatched session, nonce, client key and unknown signers", () => {
    expect(verifyAttestation(makeEvidence({ sessionId: "sbx_ffffffffffffffffffffffff" }), basePolicy)).toMatchObject({
      code: "session_mismatch",
    });
    expect(verifyAttestation(makeEvidence({ clientNonce: "ZZZ" }), basePolicy)).toMatchObject({ code: "nonce_mismatch" });
    expect(verifyAttestation(makeEvidence({ clientPublicKey: "ZZZ" }), basePolicy)).toMatchObject({
      code: "client_key_mismatch",
    });

    const other = makeEvidence();
    const unknown = { ...other, signature: { ...other.signature, keyId: "attacker-key" } };
    expect(verifyAttestation(unknown, basePolicy)).toMatchObject({ code: "unknown_signing_key" });
  });

  it("rejects tampered payloads, expired evidence and future evidence", () => {
    const env = makeEvidence();
    expect(verifyAttestation({ ...env, claims: { ...env.claims, guestMeasurement: "b".repeat(64) } }, basePolicy)).toMatchObject(
      { code: "bad_signature" },
    );

    const now = Date.now();
    expect(
      verifyAttestation(makeEvidence({ issuedAt: now - 120_000, expiresAt: now - 1000 }), basePolicy),
    ).toMatchObject({ code: "expired" });
    expect(
      verifyAttestation(makeEvidence({ issuedAt: now + 300_000, expiresAt: now + 600_000 }), basePolicy),
    ).toMatchObject({ code: "stale_clock" });
    expect(
      verifyAttestation(makeEvidence({ issuedAt: now - 600_000, expiresAt: now + 60_000 }), basePolicy),
    ).toMatchObject({ code: "stale" });
  });

  it("rejects evidence that claims hardware backing without matching type", () => {
    const env = makeEvidence({ hardwareBacked: true });
    expect(verifyAttestation(env, basePolicy)).toMatchObject({ code: "inconsistent_evidence" });
  });

  it("enforces the measurement allowlist", () => {
    const env = makeEvidence();
    const ok = verifyAttestation(env, { ...basePolicy, allowedMeasurements: ["a".repeat(64)] });
    expect(ok.ok).toBe(true);
    const bad = verifyAttestation(env, { ...basePolicy, allowedMeasurements: ["b".repeat(64)] });
    expect(bad).toMatchObject({ code: "measurement_not_allowed" });
  });

  it("distinguishes kata-mode evidence from dev-mode evidence", () => {
    const kata = makeEvidence({ evidenceType: "kata-dev-no-hw-attestation" });
    expect(verifyAttestation(kata, { ...basePolicy, mode: "kata" }).ok).toBe(true);
    expect(verifyAttestation(kata, { ...basePolicy, mode: "dev" })).toMatchObject({ code: "evidence_type_not_allowed" });
  });

  it("pins the dev public key so third-party evidence is rejected", () => {
    expect(DEV_ATTESTATION_PUBLIC_KEY).toBe("hfWzAO3JRsDHuoUXnf3Y9feHvt9iNtNAqTZGI70fS8E=");
  });
});
