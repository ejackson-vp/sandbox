/**
 * Facilitator authentication.
 *
 * The Coinbase CDP facilitator authenticates with a short-lived ES256 JWT
 * derived from a CDP API key id and secret, sent as `Authorization: Bearer`.
 * The x402.org facilitator needs no auth at all, so this module returns no
 * headers when no key is configured.
 *
 * The token is minted per request: it is bound to the method and path
 * (`uri`), it expires in minutes, and it is never logged. That is the whole
 * reason there is no long-lived credential on the wire.
 */
import { createPrivateKey, randomBytes, sign, type KeyObject } from "node:crypto";

/** How long a minted token may be used. CDP accepts short-lived tokens. */
const JWT_LIFETIME_SECONDS = 120;

export interface FacilitatorAuth {
  /** Headers for one request. Empty when the deployment configured no auth. */
  headers(method: string, url: URL): Record<string, string>;
}

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * Read a CDP secret. CDP hands out either a PEM block or the base64 of the
 * PKCS#8 DER. Both are accepted; anything else throws here rather than at the
 * first payment.
 */
export function privateKeyFromSecret(secret: string): KeyObject {
  const trimmed = secret.trim();
  if (trimmed.includes("BEGIN")) {
    return createPrivateKey({ key: trimmed, format: "pem" });
  }
  return createPrivateKey({ key: Buffer.from(trimmed, "base64"), format: "der", type: "pkcs8" });
}

export interface CdpJwtInput {
  keyId: string;
  privateKey: KeyObject;
  /** The request this token authorises, e.g. `POST api.cdp.coinbase.com/x/verify`. */
  uri: string;
  nowSeconds?: number;
  nonce?: string;
}

/** Mint one ES256 JWT for one CDP request. */
export function cdpJwt(input: CdpJwtInput): string {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = {
    alg: "ES256",
    typ: "JWT",
    kid: input.keyId,
    nonce: input.nonce ?? randomBytes(16).toString("hex"),
  };
  const payload = {
    sub: input.keyId,
    iss: "cdp",
    aud: ["cdp_service"],
    nbf: now,
    exp: now + JWT_LIFETIME_SECONDS,
    uri: input.uri,
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  // JOSE wants the raw r||s form, not the DER wrapper `sign` produces by
  // default for ECDSA.
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: input.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64Url(signature)}`;
}

/** CDP bearer auth. The token is minted per request and never stored. */
export function cdpFacilitatorAuth(keyId: string, secret: string): FacilitatorAuth {
  const privateKey = privateKeyFromSecret(secret);
  return {
    headers(method, url) {
      const uri = `${method.toUpperCase()} ${url.host}${url.pathname}`;
      return { Authorization: `Bearer ${cdpJwt({ keyId, privateKey, uri })}` };
    },
  };
}

/** No auth: the public facilitator, and the mock facilitator on localhost. */
export function noFacilitatorAuth(): FacilitatorAuth {
  return { headers: () => ({}) };
}
