/**
 * CDP facilitator auth: an ES256 JWT per request, never a stored credential.
 *
 * The key here is generated in the test process, so this checks the JWT is
 * well-formed and verifies under the matching public key. It does not prove the
 * live CDP service accepts it; that needs a real account.
 */
import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  cdpFacilitatorAuth,
  cdpJwt,
  noFacilitatorAuth,
  privateKeyFromSecret,
} from "../../api/src/payments/facilitator-auth.js";

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const secret = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  return { privateKey, publicKey, secret };
}

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("CDP JWT", () => {
  it("mints an ES256 token bound to the method and path", () => {
    const { privateKey, publicKey } = keyPair();
    const token = cdpJwt({
      keyId: "key-id",
      privateKey,
      uri: "POST api.cdp.coinbase.com/platform/v2/x402/verify",
      nowSeconds: 1_700_000_000,
      nonce: "n".repeat(32),
    });

    const [header, payload, signature] = token.split(".");
    expect(decode(header!)).toMatchObject({ alg: "ES256", typ: "JWT", kid: "key-id" });
    expect(decode(payload!)).toMatchObject({
      sub: "key-id",
      iss: "cdp",
      aud: ["cdp_service"],
      nbf: 1_700_000_000,
      uri: "POST api.cdp.coinbase.com/platform/v2/x402/verify",
    });
    expect(decode(payload!).exp as number).toBeGreaterThan(1_700_000_000);

    const verified = createVerify("sha256")
      .update(`${header}.${payload}`)
      .verify(
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature!, "base64url"),
      );
    expect(verified).toBe(true);
  });

  it("does not verify when the payload is changed", () => {
    const { privateKey, publicKey } = keyPair();
    const token = cdpJwt({ keyId: "k", privateKey, uri: "POST host/verify" });
    const [header, , signature] = token.split(".");
    const tampered = Buffer.from(
      JSON.stringify({ sub: "someone-else", iss: "cdp", aud: ["cdp_service"] }),
    ).toString("base64url");

    const verified = createVerify("sha256")
      .update(`${header}.${tampered}`)
      .verify(
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature!, "base64url"),
      );
    expect(verified).toBe(false);
  });

  it("builds a bearer header whose token is never the secret", () => {
    const { secret } = keyPair();
    const auth = cdpFacilitatorAuth("key-id", secret);
    const headers = auth.headers("POST", new URL("https://api.cdp.coinbase.com/platform/v2/x402/settle"));

    const authorization = headers.Authorization ?? "";
    expect(authorization.startsWith("Bearer ")).toBe(true);
    expect(authorization).not.toContain(secret);
    const [, payload] = authorization.slice("Bearer ".length).split(".");
    expect(decode(payload!)).toMatchObject({
      uri: "POST api.cdp.coinbase.com/platform/v2/x402/settle",
    });
  });

  it("accepts a PEM secret as well as base64 DER", () => {
    const { privateKey } = keyPair();
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(privateKeyFromSecret(pem).type).toBe("private");
  });

  it("sends nothing when no auth is configured", () => {
    expect(noFacilitatorAuth().headers("POST", new URL("https://x402.org/facilitator/verify"))).toEqual(
      {},
    );
  });
});
