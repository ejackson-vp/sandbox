import { describe, expect, it } from "vitest";
import { verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  MockExactClientScheme,
  MockExactFacilitatorScheme,
  MOCK_NETWORK,
  DEFAULT_TIERS,
  loadPlatformLimits,
  paymentKey,
  resolveSessionSpec,
  specHash,
  type MockNonceStore,
} from "../../shared/src/entries/payment.js";
import { formatUsd, parseUsdPrice } from "../../shared/src/entries/money.js";
import { type SessionLimits, type SessionSpec } from "../../shared/src/entries/protocol.js";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { 
  PaymentClaimLostError,
  type PaymentRecord,
  type SessionRecord,
 } from "../../controller/src/store/models.js";
import { RefundService } from "../../controller/src/refunds.js";
import { newOpaqueToken } from "../../controller/src/secrets.js";
import { mintProxyToken, verifyProxyToken } from "../../controller/src/tokens.js";
import { extractProxyToken, parseAuthority } from "../../controller/src/egress-proxy.js";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import { limitsFor, paymentFixture, sessionFixture } from "../helpers/store-fixtures.js";
import { countRows, freshStore } from "../helpers/test-store.js";

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

const limits: SessionLimits = limitsFor("unit");

const spec: SessionSpec = { tier: "standard", durationSeconds: 300, limits, runtime: "base" };

function sessionRecord(id: string, key: string): SessionRecord {
  return sessionFixture({
    id,
    paymentKey: key,
    clientPublicKey: "pk",
    clientNonce: "nonce",
    tier: "standard",
    durationSeconds: 300,
    limits,
  });
}

function paymentRecord(key: string): PaymentRecord {
  return paymentFixture({
    paymentKey: key,
    network: MOCK_NETWORK,
    payer: "0x0000000000000000000000000000000000000001",
    transaction: "mock:tx",
  });
}

/** Claim then complete, as the API does. */
async function seedEntitlement(store: PostgresStore, key: string, record: SessionRecord): Promise<void> {
  const claim = await store.claimPaymentIntent(key, "a".repeat(64), 30_000);
  if (claim.status !== "claimed") throw new Error("expected claim");
  await store.completeEntitlement(key, claim.token, paymentRecord(key), record);
}

describe("pricing and session specs", () => {
  it("parses and formats USD prices at 6 decimals", async () => {
    expect(parseUsdPrice("$0.01").amount.toString()).toBe("10000");
    expect(parseUsdPrice("1.5").amount.toString()).toBe("1500000");
    expect(formatUsd("50000")).toBe("$0.05");
    expect(formatUsd("1500000")).toBe("$1.5");
  });

  it("resolves preset tiers with fixed durations", async () => {
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

  it("supports custom durations within the hard cap and rejects out-of-range values", async () => {
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

  it("hashes specs stably", async () => {
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
  async function openStore() {
    return { store: await freshStore(), cleanup: () => undefined };
  }

  it("makes one payment redeemable exactly once and completes idempotently", async () => {
    const { store, cleanup } = await openStore();
    try {
      const key = "f".repeat(64);
      const digest = specHash(spec);
      const first = await store.claimPaymentIntent(key, digest, 30_000);
      expect(first).toMatchObject({ status: "claimed", recovered: false });
      if (first.status !== "claimed") throw new Error("expected claim");
      expect(first.token).toMatch(/^[0-9a-f]{32}$/);
      expect(await store.claimPaymentIntent(key, digest, 30_000)).toMatchObject({ status: "in_progress" });

      const firstSession = "sbx_000000000000000000000001";
      expect(await store.completeEntitlement(key, first.token, paymentRecord(key), sessionRecord(firstSession, key)))
        .toEqual({ sessionId: firstSession, created: true });
      expect(await store.claimPaymentIntent(key, digest, 30_000)).toMatchObject({
        status: "settled",
        sessionId: firstSession,
      });

      // A duplicate completion hands back the winning session instead of an
      // error, and never creates a second session.
      expect(
        await store.completeEntitlement(key, first.token, paymentRecord(key), sessionRecord("sbx_000000000000000000000002", key)),
      ).toEqual({ sessionId: firstSession, created: false });
      expect(await countRows("sessions")).toBe(1);
      expect(await countRows("payments")).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("fences a stale owner out of completion after a reclaim", async () => {
    const { store, cleanup } = await openStore();
    try {
      const key = "e".repeat(64);
      const digest = specHash(spec);
      const owner = await store.claimPaymentIntent(key, digest, 5);
      if (owner.status !== "claimed") throw new Error("expected claim");

      const stale = await store.claimPaymentIntent(key, digest, -1);
      expect(stale).toMatchObject({ status: "claimed", recovered: true });
      if (stale.status !== "claimed") throw new Error("expected reclaim");
      expect(stale.token).not.toBe(owner.token);

      // The reclaimed owner is the only one that may settle.
      await expect(
        store.completeEntitlement(
          key,
          owner.token,
          paymentRecord(key),
          sessionRecord("sbx_000000000000000000000010", key),
        ),
      ).rejects.toThrow(PaymentClaimLostError);
      expect(await countRows("sessions")).toBe(0);
      expect((await store.getPaymentIntent(key))?.status).toBe("claimed");

      expect(
        await store.completeEntitlement(key, stale.token, paymentRecord(key), sessionRecord("sbx_000000000000000000000011", key)),
      ).toEqual({ sessionId: "sbx_000000000000000000000011", created: true });

      // After settlement the old owner learns the outcome rather than an error.
      expect(
        await store.completeEntitlement(key, owner.token, paymentRecord(key), sessionRecord("sbx_000000000000000000000012", key)),
      ).toEqual({ sessionId: "sbx_000000000000000000000011", created: false });
      expect(await countRows("sessions")).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("recovers a stale claim but rejects a spec mismatch", async () => {
    const { store, cleanup } = await openStore();
    try {
      const key = "e".repeat(64);
      const digest = specHash(spec);
      expect(await store.claimPaymentIntent(key, digest, 5)).toMatchObject({ status: "claimed" });
      const stale = await store.claimPaymentIntent(key, digest, -1);
      expect(stale).toMatchObject({ status: "claimed", recovered: true });
      expect(await store.claimPaymentIntent(key, "b".repeat(64), -1)).toMatchObject({ status: "mismatch" });
      await store.failPaymentIntent(key, "settlement_failed");
      expect(await store.claimPaymentIntent(key, digest, 30_000)).toMatchObject({ status: "failed" });
      expect(await store.getPaymentIntent(key)).toMatchObject({ status: "failed", claimToken: null });
    } finally {
      cleanup();
    }
  });
});

describe("operation gating", () => {
  async function openStore() {
    const store = await freshStore();
    const key = "d".repeat(64);
    const claim = await store.claimPaymentIntent(key, specHash(spec), 30_000);
    if (claim.status !== "claimed") throw new Error("expected claim");
    await store.completeEntitlement(key, claim.token, paymentRecord(key), sessionRecord("sbx_000000000000000000000003", key));
    await store.setProvisioning("sbx_000000000000000000000003", "pod-x");
    await store.setRelayToken("sbx_000000000000000000000003", "relay-hash");
    await store.setReady("sbx_000000000000000000000003", Date.now(), Date.now() + 60_000, "{}", "guestpk");
    return { store, cleanup: () => undefined };
  }

  it("allows one active operation and treats request ids as idempotency keys", async () => {
    const { store, cleanup } = await openStore();
    try {
      const id = "sbx_000000000000000000000003";
      expect(await store.claimOperation(id, "request-1", "exec")).toMatchObject({ ok: true });
      expect(await store.claimOperation(id, "request-2", "exec")).toMatchObject({ ok: false, code: "busy" });
      expect(await store.claimOperation(id, "request-1", "exec")).toMatchObject({ ok: false, code: "duplicate" });
      await store.finishOperation(id, "request-1", "done");
      expect(await store.claimOperation(id, "request-2", "exec")).toMatchObject({ ok: true });
      expect((await store.getSession(id))?.state).toBe("ACTIVE");
    } finally {
      cleanup();
    }
  });

  it("records a payment ledger and makes refund transitions idempotent", async () => {
    const { store, cleanup } = await openStore();
    try {
      const id = "sbx_000000000000000000000003";
      const key = "d".repeat(64);
      const ledger = await store.getLedgerBySession(id);
      expect(ledger).toMatchObject({
        paymentKey: key,
        sessionId: id,
        amount: "50000",
        mode: "mock",
        status: "SETTLED",
        refundTransaction: null,
      });
      expect(await store.markRefundPending(key, "no_service")).toBe(true);
      expect((await store.getLedgerByPayment(key))?.status).toBe("REFUND_PENDING");
      expect(await store.markRefundPending(key, "again")).toBe(false);
      expect(await store.markRefunded(key, "mock:refund:1", "no_service")).toBe(true);
      expect(await store.getLedgerByPayment(key)).toMatchObject({
        status: "REFUNDED",
        refundTransaction: "mock:refund:1",
        reason: "no_service",
      });
      expect(await store.markRefunded(key, "mock:refund:2", "again")).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("repairs a refund left SETTLED after a crash", async () => {
    const store = await freshStore();
    try {
      const key = "e".repeat(64);
      const id = "sbx_000000000000000000000005";
      await seedEntitlement(store, key, sessionRecord(id, key));
      await store.requestTermination(id, "failure:crash_before_refund");
      expect(await store.finalizeTermination(id)).toBe("FAILED");
      expect((await store.getLedgerBySession(id))?.status).toBe("SETTLED");

      await new RefundService(store).reconcile();
      expect(await store.getLedgerBySession(id)).toMatchObject({
        status: "REFUNDED",
        sessionId: id,
      });
    } finally {
      await store.close();
    }
  });

  it("fences an operation interrupted by a controller crash", async () => {
    const { store, cleanup } = await openStore();
    try {
      const id = "sbx_000000000000000000000003";
      expect(await store.claimOperation(id, "request-crash", "exec")).toMatchObject({ ok: true, epoch: 1 });
      expect((await store.getSession(id))?.activeRequestId).toBe("request-crash");

      expect(await store.recoverInterruptedOperations()).toEqual({ requests: 1, sessions: 1 });
      expect(await store.getExecRequest(id, "request-crash")).toMatchObject({
        state: "outcome_unknown",
        epoch: 1,
      });
      // The gate stays closed: the old command may still run in the guest.
      expect(await store.getSession(id)).toMatchObject({
        activeRequestId: "request-crash",
        execEpoch: 2,
      });
      expect((await store.listFencedSessions()).map((session) => session.id)).toEqual([id]);
      expect(await store.claimOperation(id, "request-after-restart", "exec")).toMatchObject({
        ok: false,
        code: "busy",
        requestId: "request-crash",
      });

      // A stale caller that read the request as pending before recovery must
      // not finish it afterwards: the fence still owns the gate.
      await store.finishOperation(id, "request-crash", "error");
      expect((await store.getExecRequest(id, "request-crash"))?.state).toBe("outcome_unknown");
      expect(await store.getSession(id)).toMatchObject({ activeRequestId: "request-crash" });

      // Only the generation that owns the fence can release it.
      expect(await store.clearFencedGate(id, "request-crash", 1)).toBe(false);
      expect(await store.clearFencedGate(id, "request-crash", 2)).toBe(true);
      expect((await store.getSession(id))?.activeRequestId).toBeNull();
      expect(await store.claimOperation(id, "request-after-restart", "exec")).toMatchObject({
        ok: true,
        epoch: 2,
      });
      // The old request keeps its terminal, non-committal state.
      expect((await store.getExecRequest(id, "request-crash"))?.state).toBe("outcome_unknown");
    } finally {
      cleanup();
    }
  });

  it("does not fence sessions that had no operation in flight", async () => {
    const { store, cleanup } = await openStore();
    try {
      const id = "sbx_000000000000000000000003";
      expect(await store.recoverInterruptedOperations()).toEqual({ requests: 0, sessions: 0 });
      expect(await store.getSession(id)).toMatchObject({ activeRequestId: null, execEpoch: 1 });
      expect(await store.listFencedSessions()).toEqual([]);
      expect(await store.getExecRequest(id, "never-seen")).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("refuses operations after the lease deadline", async () => {
    const store = await freshStore();
    try {
      const id = "sbx_000000000000000000000004";
      const key = "c".repeat(64);
      await seedEntitlement(store, key, sessionRecord(id, key));
      await store.setProvisioning(id, "pod-y");
      await store.setRelayToken(id, "relay-hash");
      await store.setReady(id, Date.now() - 120_000, Date.now() - 60_000, "{}", "guestpk");
      expect(await store.claimOperation(id, "request-1", "exec")).toMatchObject({ ok: false, code: "lease_expired" });
    } finally {
      await store.close();
    }
  });

  it("finalises terminal state from the termination reason", async () => {
    const { store, cleanup } = await openStore();
    try {
      const id = "sbx_000000000000000000000003";
      await store.requestTermination(id, "lease_expired");
      expect((await store.getSession(id))?.state).toBe("TERMINATING");
      expect(await store.finalizeTermination(id)).toBe("EXPIRED");
      expect((await store.getSession(id))?.state).toBe("EXPIRED");
      expect((await store.getSession(id))?.destroyedAt).toBeTruthy();
    } finally {
      cleanup();
    }
  });
});

describe("capability and proxy tokens", () => {
  it("mints opaque capabilities with no structure", async () => {
    const token = newOpaqueToken();
    expect(token.length).toBeGreaterThan(40);
    expect(token).not.toContain(".");
  });

  it("verifies signed proxy tokens and rejects tampering/expiry", async () => {
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

  it("accepts Bearer and Basic proxy authorization forms", async () => {
    expect(extractProxyToken("Bearer abc123")).toBe("abc123");
    expect(extractProxyToken(`Basic ${Buffer.from("x402:tok").toString("base64")}`)).toBe("tok");
    expect(extractProxyToken("Basic not-base64!!")).toBe("");
    expect(extractProxyToken(undefined)).toBe("");
  });

  it("parses CONNECT authorities including IPv6 literals", async () => {
    expect(parseAuthority("example.com:443")).toEqual({ host: "example.com", port: 443 });
    expect(parseAuthority("[2606:4700::1111]:443")).toEqual({ host: "2606:4700::1111", port: 443 });
    expect(parseAuthority("example.com")).toBeNull();
    expect(parseAuthority("example.com:notaport")).toBeNull();
  });
});
