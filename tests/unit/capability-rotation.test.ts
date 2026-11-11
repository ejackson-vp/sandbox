/**
 * Capability key rotation (#61).
 *
 * The properties that matter:
 *  - the MAC input stays the F-08 v2 derivation, so a rotation never changes
 *    what an existing key produces (the F-08 break is not repeated);
 *  - a capability signed with the previous key verifies during the overlap and
 *    is refused once that key is retired;
 *  - the create-replay path re-derives the token a session already holds
 *    instead of signing a new one whose hash would not match;
 *  - no secret reaches a log line or a metric label.
 */
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capabilityKeyRing,
  capabilityMac,
  mintCapability,
  recoverCapability,
  ringAcceptsToken,
  splitCapability,
} from "../../shared/src/entries/crypto.js";
import { sha256Hex } from "../../shared/src/crypto.js";
import { log } from "../../shared/src/entries/runtime.js";
import { loadConfig } from "../../api/src/config.js";

const OLD_SECRET = "o".repeat(32);
const NEW_SECRET = "n".repeat(32);
const PAYMENT_KEY = "0x" + "a".repeat(64);
const COMMITMENT = `${"c".repeat(43)}:${"d".repeat(43)}`;

const overlap = capabilityKeyRing({
  keyId: "k2",
  secret: NEW_SECRET,
  previous: { keyId: "k1", secret: OLD_SECRET },
});
const retired = capabilityKeyRing({ keyId: "k2", secret: NEW_SECRET });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("capability derivation", () => {
  it("keeps the F-08 v2 MAC input byte for byte", () => {
    const expected = createHmac("sha256", OLD_SECRET)
      .update(`x402-capability:v2:${PAYMENT_KEY}:${COMMITMENT}`)
      .digest("base64url");
    expect(capabilityMac(OLD_SECRET, PAYMENT_KEY, COMMITMENT)).toBe(expected);
  });

  it("prefixes the key id without touching the MAC", () => {
    const token = mintCapability({ id: "k2", secret: NEW_SECRET }, PAYMENT_KEY, COMMITMENT);
    expect(token).toBe(`k2.${capabilityMac(NEW_SECRET, PAYMENT_KEY, COMMITMENT)}`);
    expect(splitCapability(token).keyId).toBe("k2");
    expect(token.length).toBeLessThanOrEqual(128);
  });

  it("treats a token without a key id as the legacy bare form", () => {
    const legacy = capabilityMac(OLD_SECRET, PAYMENT_KEY, COMMITMENT);
    expect(splitCapability(legacy)).toEqual({ keyId: null, mac: legacy });
    expect(ringAcceptsToken(overlap, legacy)).toBe(true);
    expect(ringAcceptsToken(retired, legacy)).toBe(true);
  });
});

describe("rotation overlap", () => {
  const oldToken = mintCapability({ id: "k1", secret: OLD_SECRET }, PAYMENT_KEY, COMMITMENT);
  const storedHash = sha256Hex(oldToken);

  it("accepts a capability signed with the previous key", () => {
    expect(ringAcceptsToken(overlap, oldToken)).toBe(true);
  });

  it("re-derives exactly the token the session was issued", () => {
    expect(recoverCapability(overlap, PAYMENT_KEY, COMMITMENT, storedHash)).toBe(oldToken);
  });

  it("keeps signing new capabilities with the current key", () => {
    const fresh = mintCapability(overlap.signing, PAYMENT_KEY, COMMITMENT);
    expect(splitCapability(fresh).keyId).toBe("k2");
    expect(fresh).not.toBe(oldToken);
    expect(recoverCapability(overlap, PAYMENT_KEY, COMMITMENT, sha256Hex(fresh))).toBe(fresh);
  });

  it("re-derives a capability issued before the key id existed", () => {
    const legacy = capabilityMac(OLD_SECRET, PAYMENT_KEY, COMMITMENT);
    expect(recoverCapability(overlap, PAYMENT_KEY, COMMITMENT, sha256Hex(legacy))).toBe(legacy);
  });
});

describe("rotation retirement", () => {
  const oldToken = mintCapability({ id: "k1", secret: OLD_SECRET }, PAYMENT_KEY, COMMITMENT);
  const storedHash = sha256Hex(oldToken);

  it("refuses the previous key id once it is removed from the ring", () => {
    expect(ringAcceptsToken(retired, oldToken)).toBe(false);
  });

  it("cannot re-derive a capability signed by a retired key", () => {
    expect(recoverCapability(retired, PAYMENT_KEY, COMMITMENT, storedHash)).toBeNull();
  });

  it("still accepts a capability signed by the surviving key", () => {
    const token = mintCapability({ id: "k2", secret: NEW_SECRET }, PAYMENT_KEY, COMMITMENT);
    expect(ringAcceptsToken(retired, token)).toBe(true);
    expect(recoverCapability(retired, PAYMENT_KEY, COMMITMENT, sha256Hex(token))).toBe(token);
  });

  it("does not accept a token with an unknown key id even if its hash matches", () => {
    // A forged prefix cannot smuggle a hash-valid token past the id check.
    const forged = `k9.${capabilityMac(OLD_SECRET, PAYMENT_KEY, COMMITMENT)}`;
    expect(ringAcceptsToken(retired, forged)).toBe(false);
  });
});

describe("api configuration", () => {
  const base = {
    PAYMENT_MODE: "mock",
    ALLOW_INSECURE_DEV: "true",
    CONTROLLER_ADMIN_TOKEN: "a".repeat(32),
    CAPABILITY_SECRET: NEW_SECRET,
  };

  it("defaults to a single signing key with id k1", () => {
    const cfg = loadConfig(base);
    expect(cfg.capabilityKeys.signing.id).toBe("k1");
    expect(cfg.capabilityKeys.verify).toHaveLength(1);
  });

  it("adds the previous key to the verify set during a rotation", () => {
    const cfg = loadConfig({
      ...base,
      CAPABILITY_KEY_ID: "k2",
      CAPABILITY_SECRET_PREVIOUS: OLD_SECRET,
      CAPABILITY_PREVIOUS_KEY_ID: "k1",
    });
    expect(cfg.capabilityKeys.signing).toEqual({ id: "k2", secret: NEW_SECRET });
    expect(cfg.capabilityKeys.verify.map((key) => key.id)).toEqual(["k2", "k1"]);
  });

  it("requires a key id alongside a previous secret", () => {
    expect(() =>
      loadConfig({ ...base, CAPABILITY_SECRET_PREVIOUS: OLD_SECRET }),
    ).toThrow(/CAPABILITY_PREVIOUS_KEY_ID/);
  });

  it("rejects the same key twice", () => {
    expect(() =>
      loadConfig({
        ...base,
        CAPABILITY_KEY_ID: "k2",
        CAPABILITY_SECRET_PREVIOUS: NEW_SECRET,
        CAPABILITY_PREVIOUS_KEY_ID: "k1",
      }),
    ).toThrow(/must differ/);
    expect(() =>
      loadConfig({
        ...base,
        CAPABILITY_KEY_ID: "k2",
        CAPABILITY_SECRET_PREVIOUS: OLD_SECRET,
        CAPABILITY_PREVIOUS_KEY_ID: "k2",
      }),
    ).toThrow(/CAPABILITY_PREVIOUS_KEY_ID/);
  });

  it("rejects a previous key equal to the admin token", () => {
    expect(() =>
      loadConfig({
        ...base,
        CAPABILITY_KEY_ID: "k2",
        CAPABILITY_SECRET_PREVIOUS: base.CONTROLLER_ADMIN_TOKEN,
        CAPABILITY_PREVIOUS_KEY_ID: "k1",
      }),
    ).toThrow(/must differ from CONTROLLER_ADMIN_TOKEN/);
  });

  it("rejects a key id that cannot be a token prefix", () => {
    expect(() => loadConfig({ ...base, CAPABILITY_KEY_ID: "k1.bad" })).toThrow(/CAPABILITY_KEY_ID/);
  });
});

describe("no secret leaves the process", () => {
  const oldToken = mintCapability({ id: "k1", secret: OLD_SECRET }, PAYMENT_KEY, COMMITMENT);

  it("does not embed either secret in a minted capability", () => {
    expect(oldToken).not.toContain(OLD_SECRET);
    expect(oldToken).not.toContain(NEW_SECRET);
  });

  it("redacts the rotation fields if a handler ever logs its config", () => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    log.info("config", {
      capabilitySecret: NEW_SECRET,
      capabilitySecretPrevious: OLD_SECRET,
      adminTokenPrevious: "a".repeat(32),
    });
    const emitted = lines.join("");
    expect(emitted).toContain("[redacted]");
    expect(emitted).not.toContain(NEW_SECRET);
    expect(emitted).not.toContain(OLD_SECRET);
  });
});
