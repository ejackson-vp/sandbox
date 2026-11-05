import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  MockExactClientScheme,
  MockExactFacilitatorScheme,
  MOCK_NETWORK,
  formatUsd,
  parseUsdPrice,
  paymentKey,
  type MockNonceStore,
  type PaymentPayload,
  type PaymentRequirements,
} from "../../shared/src/index.js";
import { Store, PaymentAlreadyRedeemedError, type PaymentRecord, type SessionRecord } from "../../controller/src/store.js";
import { mintProxyToken, verifyProxyToken, newOpaqueToken } from "../../controller/src/tokens.js";
import { extractProxyToken } from "../../controller/src/egress-proxy.js";
import { parseAuthority } from "../../controller/src/egress-proxy.js";

class MemoryNonceStore implements MockNonceStore {
  readonly nonces = new Set<string>();
  async claimNonce(nonce: string): Promise<boolean> {
    if (this.nonces.has(nonce)) return false;
    this.nonces.add(nonce);
    return true;
  }
}

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: MOCK_NETWORK,
  asset: "mock:usdc",
  amount: "10000",
  payTo: "0x0000000000000000000000000000000000000402",
  maxTimeoutSeconds: 300,
  extra: {},
};

async function signedPayload(account = privateKeyToAccount(generatePrivateKey())): Promise<PaymentPayload> {
  const scheme = new MockExactClientScheme(account);
  const partial = await scheme.createPaymentPayload(2, requirements);
  return {
    x402Version: 2,
    accepted: requirements,
    payload: partial.payload,
  };
}

function facilitator(store = new MemoryNonceStore()) {
  const scheme = new MockExactFacilitatorScheme({ store, network: MOCK_NETWORK }, verifyTypedData as never);
  return { scheme, store };
}

describe("pricing", () => {
  it("parses and formats USD prices at 6 decimals", () => {
    expect(parseUsdPrice("$0.01").amount.toString()).toBe("10000");
    expect(parseUsdPrice("1.5").amount.toString()).toBe("1500000");
    expect(formatUsd("10000")).toBe("$0.01");
    expect(formatUsd("1500000")).toBe("$1.5");
  });
});

describe("mock x402 scheme", () => {
  it("verifies and settles a correctly signed payment exactly once", async () => {
    const { scheme, store } = facilitator();
    const payload = await signedPayload();
    const verify = await scheme.verify(payload, requirements);
    expect(verify.isValid).toBe(true);
    expect(verify.payer).toMatch(/^0x[0-9a-fA-F]{40}$/);

    const settle = await scheme.settle(payload, requirements);
    expect(settle.success).toBe(true);
    expect(settle.transaction).toMatch(/^mock:/);

    // Replay of the exact same authorization is rejected by the nonce store.
    const replay = await scheme.settle(payload, requirements);
    expect(replay.success).toBe(false);
    expect(replay.errorReason).toBe("nonce_already_used");
    expect(store.nonces.size).toBe(1);
  });

  it("rejects tampered amount, recipient, network and signature", async () => {
    const { scheme } = facilitator();
    const payload = await signedPayload();

    const wrongAmount = { ...payload, accepted: { ...requirements, amount: "1" } };
    expect((await scheme.verify(wrongAmount, requirements)).isValid).toBe(false);

    const wrongRecipient = {
      ...payload,
      payload: {
        ...payload.payload,
        authorization: { ...(payload.payload as { authorization: object }).authorization, to: "0x1111111111111111111111111111111111111111" },
      },
    };
    expect((await scheme.verify(wrongRecipient as PaymentPayload, requirements)).isValid).toBe(false);

    const wrongNetwork = { ...payload, accepted: { ...requirements, network: "eip155:84532" } };
    expect((await scheme.verify(wrongNetwork as PaymentPayload, requirements)).isValid).toBe(false);

    const badSignature = {
      ...payload,
      payload: { ...payload.payload, signature: `0x${"11".repeat(65)}` },
    };
    const res = await scheme.verify(badSignature as PaymentPayload, requirements);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toBe("invalid_signature");
  });

  it("rejects an expired authorization", async () => {
    const { scheme } = facilitator();
    const account = privateKeyToAccount(generatePrivateKey());
    const payload = await signedPayload(account);
    const auth = (payload.payload as { authorization: { validAfter: string; validBefore: string } }).authorization;
    auth.validAfter = "1";
    auth.validBefore = "2";
    const res = await scheme.verify(payload, requirements);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toBe("expired");
  });

  it("derives a stable, unique payment key per authorization", async () => {
    const a = await signedPayload();
    const b = await signedPayload();
    expect(paymentKey(a)).toBe(paymentKey(a));
    expect(paymentKey(a)).not.toBe(paymentKey(b));
    expect(paymentKey(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("entitlement store", () => {
  function session(id: string, paymentKeyValue: string): SessionRecord {
    const now = Date.now();
    return {
      id,
      capabilityHash: "a".repeat(64),
      capabilityExpiresAt: now + 60_000,
      clientPublicKey: "pk",
      clientNonce: "nonce",
      durationSeconds: 60,
      state: "PAID",
      createdAt: now,
      paidAt: now,
      readyAt: null,
      executionDeadlineAt: null,
      completedAt: null,
      destroyedAt: null,
      failureCode: null,
      failureMessage: null,
      attestationJson: null,
      guestPublicKey: null,
      paymentKey: paymentKeyValue,
      podName: null,
      runtimeClass: "x402-sandbox",
      executionMode: "dev",
      relayTokenHash: null,
      execStartedAt: null,
      execAccepted: 0,
      resultFetchedAt: null,
      relayPurgedAt: null,
      destroyRequested: 0,
      updatedAt: now,
    };
  }

  function payment(key: string): PaymentRecord {
    return {
      paymentKey: key,
      network: MOCK_NETWORK,
      scheme: "exact",
      asset: "mock:usdc",
      amount: "10000",
      payTo: requirements.payTo,
      payer: "0x0000000000000000000000000000000000000001",
      transaction: "mock:tx",
      mode: "mock",
    };
  }

  it("makes one payment redeemable exactly once", () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-store-"));
    const store = new Store(join(dir, "test.db"));
    try {
      const key = "f".repeat(64);
      store.createEntitlement(payment(key), session("sbx_000000000000000000000001", key));
      expect(() => store.createEntitlement(payment(key), session("sbx_000000000000000000000002", key))).toThrow(
        PaymentAlreadyRedeemedError,
      );
      expect(store.countSessions()).toBe(1);
      expect(store.countPayments()).toBe(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows only one execution claim per session", () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-store-"));
    const store = new Store(join(dir, "test.db"));
    try {
      const key = "e".repeat(64);
      const s = session("sbx_000000000000000000000003", key);
      store.createEntitlement(payment(key), s);
      store.setProvisioning(s.id, "pod-x");
      store.setReady(s.id, Date.now(), Date.now() + 60_000, "{}", "guestpk");
      expect(store.claimExecution(s.id)).toBe(true);
      expect(store.claimExecution(s.id)).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("capability and proxy tokens", () => {
  it("mints opaque capabilities with no structure", () => {
    const token = newOpaqueToken();
    expect(token.length).toBeGreaterThan(40);
    expect(token).not.toContain(".");
  });

  it("verifies signed proxy tokens and rejects tampering/expiry", () => {
    const secret = "s".repeat(32);
    const token = mintProxyToken(secret, "sbx_abc", 60_000);
    const ok = verifyProxyToken(secret, token);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.sessionId).toBe("sbx_abc");

    expect(verifyProxyToken(secret, token.replace(/\.([^.]+)$/, ".AAAA"))).toMatchObject({ ok: false });
    expect(verifyProxyToken(secret, mintProxyToken(secret, "sbx_abc", -1000))).toMatchObject({
      ok: false,
      reason: "token_expired",
    });
    expect(verifyProxyToken("other-secret", token).ok).toBe(false);
  });

  it("accepts Bearer and Basic proxy authorization forms", () => {
    expect(extractProxyToken("Bearer abc123")).toBe("abc123");
    expect(extractProxyToken(`Basic ${Buffer.from("x402:tok").toString("base64")}`)).toBe("tok");
    expect(extractProxyToken("Basic not-base64!!")).toBe("");
    expect(extractProxyToken(undefined)).toBe("");
  });

  it("parses CONNECT authorities including IPv6 literals", () => {
    expect(parseAuthority("example.com:443")).toEqual({ host: "example.com", port: 443 });
    expect(parseAuthority("[2606:4700::1111]:443")).toEqual({ host: "2606:4700::1111", port: 443 });
    expect(parseAuthority("example.com")).toBeNull();
    expect(parseAuthority("example.com:notaport")).toBeNull();
  });
});
