/**
 * CDP facilitator authentication.
 *
 * The token is a short-lived JWT, and the failure it can produce is opaque: a
 * wrong key or a wrong algorithm is a 401 with no detail, at the first payment.
 * CDP issues Ed25519 keys now, as base64 rather than a PEM, so both shapes are
 * pinned here by *verifying the signature* rather than by checking the header.
 */
import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cdpJwt, privateKeyFromSecret } from "../../api/src/payments/facilitator-auth.js";

function parts(token: string) {
  const [header, payload, signature] = token.split(".");
  const decode = (v: string) => JSON.parse(Buffer.from(v, "base64url").toString("utf8"));
  return {
    header: decode(header!),
    payload: decode(payload!),
    signingInput: `${header}.${payload}`,
    signature: Buffer.from(signature!, "base64url"),
  };
}

/** The libsodium form CDP hands out: seed followed by the public half. */
function ed25519Secret(): { secret: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" }) as { d: string; x: string };
  const raw = Buffer.concat([
    Buffer.from(jwk.d, "base64url"),
    Buffer.from(jwk.x, "base64url"),
  ]);
  expect(raw).toHaveLength(64);
  return { secret: raw.toString("base64"), publicKey };
}

describe("CDP JWT", () => {
  it("signs EdDSA when the key is Ed25519, and the signature verifies", () => {
    const { secret, publicKey } = ed25519Secret();
    const key = privateKeyFromSecret(secret);
    expect(key.asymmetricKeyType).toBe("ed25519");

    const token = cdpJwt({ keyId: "org/apiKeys/abc", privateKey: key, uri: "POST api.cdp.coinbase.com/x" });
    const { header, payload, signingInput, signature } = parts(token);

    expect(header.alg).toBe("EdDSA");
    expect(header.kid).toBe("org/apiKeys/abc");
    expect(payload.sub).toBe("org/apiKeys/abc");
    expect(payload.uri).toBe("POST api.cdp.coinbase.com/x");
    // The point of the test: a token that merely parses is not a token CDP
    // will accept.
    expect(verify(null, Buffer.from(signingInput), publicKey, signature)).toBe(true);
  });

  it("accepts the 32-byte seed form too", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const jwk = privateKey.export({ format: "jwk" }) as { d: string };
    const seed = Buffer.from(jwk.d, "base64url");
    expect(seed).toHaveLength(32);

    const key = privateKeyFromSecret(seed.toString("base64"));
    const token = cdpJwt({ keyId: "k", privateKey: key, uri: "GET api.cdp.coinbase.com/x" });
    const { signingInput, signature } = parts(token);
    expect(verify(null, Buffer.from(signingInput), publicKey, signature)).toBe(true);
  });

  it("still signs ES256 for an EC key, so older key pairs keep working", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

    const key = privateKeyFromSecret(pem);
    expect(key.asymmetricKeyType).toBe("ec");

    const token = cdpJwt({ keyId: "k", privateKey: key, uri: "POST host/x" });
    const { header, signingInput, signature } = parts(token);
    expect(header.alg).toBe("ES256");
    expect(
      verify("sha256", Buffer.from(signingInput), { key: publicKey, dsaEncoding: "ieee-p1363" }, signature),
    ).toBe(true);
  });

  it("refuses a secret that is neither a PEM, a seed, nor DER", () => {
    // 20 bytes: not a key shape, so this must throw at startup rather than
    // produce a token that is rejected later.
    expect(() => privateKeyFromSecret(Buffer.alloc(20).toString("base64"))).toThrow();
  });
});
