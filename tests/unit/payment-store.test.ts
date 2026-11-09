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
  DEFAULT_TIERS,
  formatUsd,
  loadPlatformLimits,
  parseUsdPrice,
  paymentKey,
  resolveSessionSpec,
  specHash,
  type MockNonceStore,
  type PaymentPayload,
  type PaymentRequirements,
  type SessionLimits,
  type SessionSpec,
} from "../../shared/src/index.js";
import { Store, PaymentAlreadyRedeemedError, type PaymentRecord, type SessionRecord } from "../../controller/src/store.js";
import { RefundService } from "../../controller/src/refunds.js";
import { mintProxyToken, verifyProxyToken, newOpaqueToken } from "../../controller/src/tokens.js";
import { extractProxyToken, parseAuthority } from "../../controller/src/egress-proxy.js";

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
  amount: "50000",
  payTo: "0x0000000000000000000000000000000000000402",
  maxTimeoutSeconds: 300,
  extra: {},
};

async function signedPayload(account = privateKeyToAccount(generatePrivateKey())): Promise<PaymentPayload> {
  const scheme = new MockExactClientScheme(account);
  const partial = await scheme.createPaymentPayload(2, requirements);
  return { x402Version: 2, accepted: requirements, payload: partial.payload };
}

function facilitator(store = new MemoryNonceStore()) {
  const scheme = new MockExactFacilitatorScheme({ store, network: MOCK_NETWORK }, verifyTypedData as never);
  return { scheme, store };
}

const limits: SessionLimits = {
  cpuMillis: 1000,
  memoryMiB: 1024,
  diskMiB: 1024,
  maxOutputBytes: 262144,
  maxFileBytes: 8 * 1024 * 1024,
  maxCommandSeconds: 300,
  maxProcesses: 256,
};

const spec: SessionSpec = { tier: "standard", durationSeconds: 300, limits };

function sessionRecord(id: string, key: string): SessionRecord {
  const now = Date.now();
  return {
    id,
    capabilityHash: "a".repeat(64),
    capabilityExpiresAt: now + 3_600_000,
    clientPublicKey: "pk",
    clientNonce: "nonce",
    tier: "standard",
    durationSeconds: 300,
    limits,
    state: "PAID",
    createdAt: now,
    paidAt: now,
    readyAt: null,
    leaseExpiresAt: null,
    terminatingAt: null,
    destroyedAt: null,
    terminationReason: null,
    failureCode: null,
    failureMessage: null,
    attestationJson: null,
    guestPublicKey: null,
    paymentKey: key,
    podName: null,
    runtimeClass: "x402-sandbox",
    executionMode: "dev",
    relayTokenHash: null,
    activeRequestId: null,
    relayPurgedAt: null,
    destroyRequested: 0,
    updatedAt: now,
  };
}

function paymentRecord(key: string): PaymentRecord {
  return {
    paymentKey: key,
    network: MOCK_NETWORK,
    scheme: "exact",
    asset: "mock:usdc",
    amount: "50000",
    payTo: requirements.payTo,
    payer: "0x0000000000000000000000000000000000000001",
    transaction: "mock:tx",
    mode: "mock",
  };
}

describe("pricing and session specs", () => {
  it("parses and formats USD prices at 6 decimals", () => {
    expect(parseUsdPrice("$0.01").amount.toString()).toBe("10000");
    expect(parseUsdPrice("1.5").amount.toString()).toBe("1500000");
    expect(formatUsd("50000")).toBe("$0.05");
    expect(formatUsd("1500000")).toBe("$1.5");
  });

  it("resolves preset tiers with fixed durations", () => {
    const limits = loadPlatformLimits({});
    const resolved = resolveSessionSpec(
      { tier: "standard", clientPublicKey: "a", clientNonce: "b" },
      DEFAULT_TIERS,
      limits,
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.spec.durationSeconds).toBe(300);
      expect(resolved.spec.limits.cpuMillis).toBe(1000);
      expect(resolved.priceUsd).toBe("$0.05");
    }

    const mismatch = resolveSessionSpec(
      { tier: "standard", durationSeconds: 61, clientPublicKey: "a", clientNonce: "b" },
      DEFAULT_TIERS,
      limits,
    );
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.code).toBe("tier_duration_mismatch");
  });

  it("supports custom durations within the hard cap and rejects out-of-range values", () => {
    const limits = loadPlatformLimits({});
    const custom = resolveSessionSpec(
      { tier: "custom", durationSeconds: 2, cpuMillis: 200, memoryMiB: 256, diskMiB: 64, clientPublicKey: "a", clientNonce: "b" },
      DEFAULT_TIERS,
      limits,
    );
    expect(custom.ok).toBe(true);
    if (custom.ok) expect(custom.spec.durationSeconds).toBe(2);

    const tooLong = resolveSessionSpec(
      { tier: "custom", durationSeconds: 7200, clientPublicKey: "a", clientNonce: "b" },
      DEFAULT_TIERS,
      limits,
    );
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.code).toBe("invalid_duration");

    const disabled = resolveSessionSpec(
      { tier: "custom", durationSeconds: 30, clientPublicKey: "a", clientNonce: "b" },
      DEFAULT_TIERS,
      loadPlatformLimits({ ALLOW_CUSTOM_DURATIONS: "false" }),
    );
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.code).toBe("custom_not_allowed");
  });

  it("hashes specs stably", () => {
    expect(specHash(spec)).toBe(specHash({ ...spec }));
    expect(specHash(spec)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("mock x402 scheme", () => {
  it("verifies and settles a correctly signed payment exactly once", async () => {
    const { scheme, store } = facilitator();
    const payload = await signedPayload();
    const verify = await scheme.verify(payload, requirements);
    expect(verify.isValid).toBe(true);
    const settle = await scheme.settle(payload, requirements);
    expect(settle.success).toBe(true);
    const replay = await scheme.settle(payload, requirements);
    expect(replay.success).toBe(false);
    expect(replay.errorReason).toBe("nonce_already_used");
    expect(store.nonces.size).toBe(1);
  });

  it("rejects tampered amount and signatures", async () => {
    const { scheme } = facilitator();
    const payload = await signedPayload();
    const wrongAmount = { ...payload, accepted: { ...requirements, amount: "1" } };
    expect((await scheme.verify(wrongAmount, requirements)).isValid).toBe(false);
    const badSignature = { ...payload, payload: { ...payload.payload, signature: `0x${"11".repeat(65)}` } };
    const res = await scheme.verify(badSignature as PaymentPayload, requirements);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toBe("invalid_signature");
  });

  it("derives a stable, unique payment key per authorization", async () => {
    const a = await signedPayload();
    const b = await signedPayload();
    expect(paymentKey(a)).toBe(paymentKey(a));
    expect(paymentKey(a)).not.toBe(paymentKey(b));
  });
});

describe("payment intent outbox and entitlements", () => {
  function openStore() {
    const dir = mkdtempSync(join(tmpdir(), "x402-store-"));
    const store = new Store(join(dir, "test.db"));
    return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
  }

  it("makes one payment redeemable exactly once", () => {
    const { store, cleanup } = openStore();
    try {
      const key = "f".repeat(64);
      const digest = specHash(spec);
      expect(store.claimPaymentIntent(key, digest, 30_000)).toMatchObject({ status: "claimed", recovered: false });
      expect(store.claimPaymentIntent(key, digest, 30_000)).toMatchObject({ status: "in_progress" });
      store.completeEntitlement(key, paymentRecord(key), sessionRecord("sbx_000000000000000000000001", key));
      expect(store.claimPaymentIntent(key, digest, 30_000)).toMatchObject({
        status: "settled",
        sessionId: "sbx_000000000000000000000001",
      });
      expect(() =>
        store.completeEntitlement(key, paymentRecord(key), sessionRecord("sbx_000000000000000000000002", key)),
      ).toThrow(PaymentAlreadyRedeemedError);
      expect(store.countSessions()).toBe(1);
      expect(store.countPayments()).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("recovers a stale claim but rejects a spec mismatch", () => {
    const { store, cleanup } = openStore();
    try {
      const key = "e".repeat(64);
      const digest = specHash(spec);
      expect(store.claimPaymentIntent(key, digest, 5)).toMatchObject({ status: "claimed" });
      const stale = store.claimPaymentIntent(key, digest, -1);
      expect(stale).toMatchObject({ status: "claimed", recovered: true });
      expect(store.claimPaymentIntent(key, "b".repeat(64), -1)).toMatchObject({ status: "mismatch" });
      store.failPaymentIntent(key, "settlement_failed");
      expect(store.claimPaymentIntent(key, digest, 30_000)).toMatchObject({ status: "failed" });
    } finally {
      cleanup();
    }
  });
});

describe("operation gating", () => {
  function openStore() {
    const dir = mkdtempSync(join(tmpdir(), "x402-store-"));
    const store = new Store(join(dir, "test.db"));
    const key = "d".repeat(64);
    store.claimPaymentIntent(key, specHash(spec), 30_000);
    store.completeEntitlement(key, paymentRecord(key), sessionRecord("sbx_000000000000000000000003", key));
    store.setProvisioning("sbx_000000000000000000000003", "pod-x");
    store.setRelayToken("sbx_000000000000000000000003", "relay-hash");
    store.setReady("sbx_000000000000000000000003", Date.now(), Date.now() + 60_000, "{}", "guestpk");
    return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
  }

  it("allows one active operation and treats request ids as idempotency keys", () => {
    const { store, cleanup } = openStore();
    try {
      const id = "sbx_000000000000000000000003";
      expect(store.claimOperation(id, "request-1", "exec")).toMatchObject({ ok: true });
      expect(store.claimOperation(id, "request-2", "exec")).toMatchObject({ ok: false, code: "busy" });
      expect(store.claimOperation(id, "request-1", "exec")).toMatchObject({ ok: false, code: "duplicate" });
      store.finishOperation(id, "request-1", "done");
      expect(store.claimOperation(id, "request-2", "exec")).toMatchObject({ ok: true });
      expect(store.getSession(id)?.state).toBe("ACTIVE");
    } finally {
      cleanup();
    }
  });

  it("records a payment ledger and makes refund transitions idempotent", () => {
    const { store, cleanup } = openStore();
    try {
      const id = "sbx_000000000000000000000003";
      const key = "d".repeat(64);
      const ledger = store.getLedgerBySession(id);
      expect(ledger).toMatchObject({
        paymentKey: key,
        sessionId: id,
        amount: "50000",
        mode: "mock",
        status: "SETTLED",
        refundTransaction: null,
      });
      expect(store.markRefundPending(key, "no_service")).toBe(true);
      expect(store.getLedgerByPayment(key)?.status).toBe("REFUND_PENDING");
      expect(store.markRefundPending(key, "again")).toBe(false);
      expect(store.markRefunded(key, "mock:refund:1", "no_service")).toBe(true);
      expect(store.getLedgerByPayment(key)).toMatchObject({
        status: "REFUNDED",
        refundTransaction: "mock:refund:1",
        reason: "no_service",
      });
      expect(store.markRefunded(key, "mock:refund:2", "again")).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("repairs a refund left SETTLED after a crash", () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-store-"));
    const store = new Store(join(dir, "test.db"));
    try {
      const key = "e".repeat(64);
      const id = "sbx_000000000000000000000005";
      store.claimPaymentIntent(key, specHash(spec), 30_000);
      store.completeEntitlement(key, paymentRecord(key), sessionRecord(id, key));
      store.requestTermination(id, "failure:crash_before_refund");
      expect(store.finalizeTermination(id)).toBe("FAILED");
      expect(store.getLedgerBySession(id)?.status).toBe("SETTLED");

      new RefundService(store).reconcile();
      expect(store.getLedgerBySession(id)).toMatchObject({
        status: "REFUNDED",
        sessionId: id,
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers an operation interrupted by a controller crash", () => {
    const { store, cleanup } = openStore();
    try {
      const id = "sbx_000000000000000000000003";
      expect(store.claimOperation(id, "request-crash", "exec")).toMatchObject({ ok: true });
      expect(store.getSession(id)?.activeRequestId).toBe("request-crash");

      expect(store.recoverInterruptedOperations()).toEqual({ requests: 1, sessions: 1 });
      expect(store.getExecRequest(id, "request-crash")?.state).toBe("abandoned");
      expect(store.getSession(id)?.activeRequestId).toBeNull();
      expect(store.claimOperation(id, "request-after-restart", "exec")).toMatchObject({ ok: true });
    } finally {
      cleanup();
    }
  });

  it("refuses operations after the lease deadline", () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-store-"));
    const store = new Store(join(dir, "test.db"));
    try {
      const id = "sbx_000000000000000000000004";
      const key = "c".repeat(64);
      store.claimPaymentIntent(key, specHash(spec), 30_000);
      store.completeEntitlement(key, paymentRecord(key), sessionRecord(id, key));
      store.setProvisioning(id, "pod-y");
      store.setRelayToken(id, "relay-hash");
      store.setReady(id, Date.now() - 120_000, Date.now() - 60_000, "{}", "guestpk");
      expect(store.claimOperation(id, "request-1", "exec")).toMatchObject({ ok: false, code: "lease_expired" });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finalises terminal state from the termination reason", () => {
    const { store, cleanup } = openStore();
    try {
      const id = "sbx_000000000000000000000003";
      store.requestTermination(id, "lease_expired");
      expect(store.getSession(id)?.state).toBe("TERMINATING");
      expect(store.finalizeTermination(id)).toBe("EXPIRED");
      expect(store.getSession(id)?.state).toBe("EXPIRED");
      expect(store.getSession(id)?.destroyedAt).toBeTruthy();
    } finally {
      cleanup();
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
    expect(verifyProxyToken(secret, token.replace(/\.([^.]+)$/, ".AAAA")).ok).toBe(false);
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
