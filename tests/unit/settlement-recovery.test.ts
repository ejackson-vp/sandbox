/**
 * Settlement reconciliation and refund execution (#31, F-10).
 *
 * What is pinned:
 *
 *  - a payment the facilitator settled but no session consumed becomes a
 *    refundable ledger row, keyed by payment key, with a synthetic session id;
 *  - mock mode refunds it immediately, a real mode leaves REFUND_PENDING;
 *  - the worker is idempotent, backs off, and gives up after a bounded number of
 *    attempts instead of retrying forever;
 *  - a second payment for a client key pair that already owns a session is
 *    refunded and refused, not turned into a second session (double charge).
 *
 * The facilitator here is a stub: no test in this repository talks to a real
 * settlement backend, and none of this has moved real money.
 */
import { describe, expect, it, vi } from "vitest";
import { 
  DuplicateEntitlementError,
  type PaymentRecord,
  type SessionRecord,
 } from "../../controller/src/store/models.js";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import { countRows, freshStore } from "../helpers/test-store.js";
import { RefundService } from "../../controller/src/refunds.js";
import { RefundWorker, type RefundExecutor } from "../../controller/src/refund-worker.js";
import { SettlementRecovery } from "../../controller/src/settlement-recovery.js";
import type { SettlementLookup } from "../../shared/src/entries/runtime.js";

const NOW = Date.now();
const PAYER = "0x00000000000000000000000000000000000000aa";
const PAYMENT_KEY = "a".repeat(64);
const REQUIREMENTS = JSON.stringify({
  network: "mock:local",
  scheme: "exact",
  asset: "mock:usdc",
  amount: "50000",
  payTo: "0x0000000000000000000000000000000000000402",
});

const SESSION_LIMITS = {
  cpuMillis: 500,
  memoryMiB: 512,
  diskMiB: 256,
  maxOutputBytes: 262_144,
  maxFileBytes: 8 * 1024 * 1024,
  maxCommandSeconds: 300,
  maxProcesses: 64,
};

function payment(key: string, payer = PAYER): PaymentRecord {
  return {
    paymentKey: key,
    network: "mock:local",
    scheme: "exact",
    asset: "mock:usdc",
    amount: "50000",
    payTo: "0x0000000000000000000000000000000000000402",
    payer,
    transaction: "mock:tx",
    mode: "mock",
    settlementNonce: `0x${"1".repeat(64)}`,
  };
}

function sessionRecord(id: string, key: string, client: string): SessionRecord {
  return {
    id,
    capabilityHash: "a".repeat(64),
    capabilityExpiresAt: NOW + 3_600_000,
    clientPublicKey: `client-${client}`,
    clientNonce: `nonce-${client}`,
    clientSigner: PAYER,
    tier: "short",
    durationSeconds: 60,
    limits: SESSION_LIMITS,
    state: "PAID",
    createdAt: NOW,
    paidAt: NOW,
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
    execEpoch: 1,
    relayPurgedAt: null,
    destroyRequested: 0,
    timingsJson: null,
    idlePolicyJson: null,
    maxLifetimeSeconds: null,
    suspendedAt: null,
    resumeCount: 0,
    lastActivityAt: null,
    workspacePvc: null,
    baselineCpuMillis: null,
    baselineMemoryMib: null,
    nodeName: null,
    updatedAt: NOW,
  } as unknown as SessionRecord;
}

/** A claimed intent whose owner died, with the requirements recorded. */
async function seedStaleClaim(store: PostgresStore, key: string): Promise<void> {
  const claim = await store.claimPaymentIntent(key, "b".repeat(64), 30_000, REQUIREMENTS);
  if (claim.status !== "claimed") throw new Error("expected claim");
}

function lookupReturning(record: { settled: boolean; payer?: string; amount?: string }): SettlementLookup {
  return { supported: true, lookup: vi.fn(async () => (record.settled ? record : null)) };
}

describe("settlement recovery", () => {
  it("records a settled payment with no entitlement as refundable", async () => {
    const store = await freshStore();
    await seedStaleClaim(store, PAYMENT_KEY);
    const lookup = lookupReturning({ settled: true, payer: PAYER, amount: "50000" });

    const result = await new SettlementRecovery(store, new RefundService(store), lookup, {
      graceMs: 0,
      limit: 10,
      mode: "testnet",
    }).run();

    expect(result).toEqual({ checked: 1, recovered: 1, errors: 0 });
    const ledger = (await store.getLedgerByPayment(PAYMENT_KEY))!;
    expect(ledger.status).toBe("REFUND_PENDING");
    expect(ledger.sessionId).toBe(`unsettled:${PAYMENT_KEY}`);
    expect(ledger.reason).toBe("settled_without_entitlement");
    expect(ledger.mode).toBe("testnet");
    // The requirements recorded at claim time are what make the row complete.
    expect(ledger.asset).toBe("mock:usdc");
    expect(ledger.amount).toBe("50000");
    expect(ledger.payer).toBe(PAYER);
  });

  it("refunds a recovered mock payment immediately", async () => {
    const store = await freshStore();
    await seedStaleClaim(store, PAYMENT_KEY);

    await new SettlementRecovery(store, new RefundService(store), lookupReturning({ settled: true }), {
      graceMs: 0,
      limit: 10,
      mode: "mock",
    }).run();

    const ledger = (await store.getLedgerByPayment(PAYMENT_KEY))!;
    expect(ledger.status).toBe("REFUNDED");
    expect(ledger.refundTransaction).toMatch(/^mock:refund:/);
  });

  it("leaves an unsettled intent alone: the API still owns the retry", async () => {
    const store = await freshStore();
    await seedStaleClaim(store, PAYMENT_KEY);

    const result = await new SettlementRecovery(store, new RefundService(store), lookupReturning({ settled: false }), {
      graceMs: 0,
      limit: 10,
      mode: "testnet",
    }).run();

    expect(result.recovered).toBe(0);
    expect(await store.getLedgerByPayment(PAYMENT_KEY)).toBeNull();
    // Still claimed, so a client retry can still complete it.
    expect((await store.getPaymentIntent(PAYMENT_KEY))?.status).toBe("claimed");
  });

  it("is a no-op without a settlement lookup", async () => {
    const store = await freshStore();
    await seedStaleClaim(store, PAYMENT_KEY);

    const result = await new SettlementRecovery(store, new RefundService(store), null, {
      graceMs: 0,
      limit: 10,
      mode: "testnet",
    }).run();

    expect(result).toEqual({ checked: 0, recovered: 0, errors: 0 });
    expect(await store.getLedgerByPayment(PAYMENT_KEY)).toBeNull();
  });

  it("does not duplicate a row that already exists", async () => {
    const store = await freshStore();
    await seedStaleClaim(store, PAYMENT_KEY);
    const lookup = lookupReturning({ settled: true, payer: PAYER, amount: "50000" });
    const recovery = new SettlementRecovery(store, new RefundService(store), lookup, {
      graceMs: 0,
      limit: 10,
      mode: "testnet",
    });

    await recovery.run();
    const second = await recovery.run();

    expect(second.recovered).toBe(0);
    expect(await store.listLedgerByStatus("REFUND_PENDING")).toHaveLength(1);
  });
});

describe("refund worker", () => {
  async function seedPending(store: PostgresStore, key = PAYMENT_KEY): Promise<void> {
    await store.insertUnclaimedLedger({
      paymentKey: key,
      sessionId: `unsettled:${key}`,
      payer: PAYER,
      amount: "50000",
      asset: "mock:usdc",
      network: "mock:local",
      mode: "testnet",
      status: "REFUND_PENDING",
      reason: "no_service_delivered:provisioning_timeout",
      settlementNonce: `0x${"2".repeat(64)}`,
    });
  }

  it("executes a pending refund once and records the transaction", async () => {
    const store = await freshStore();
    await seedPending(store);
    const executor: RefundExecutor = { refund: vi.fn(async () => ({ transaction: "0xdeadbeef" })) };
    const worker = new RefundWorker(store, executor, { maxAttempts: 3, retryBaseMs: 1000, limit: 10 });

    const first = await worker.run();
    expect(first).toMatchObject({ attempted: 1, refunded: 1, failed: 0, skipped: false });
    expect(executor.refund).toHaveBeenCalledWith(
      expect.objectContaining({ paymentKey: PAYMENT_KEY, settlementNonce: `0x${"2".repeat(64)}` }),
    );

    const ledger = (await store.getLedgerByPayment(PAYMENT_KEY))!;
    expect(ledger.status).toBe("REFUNDED");
    expect(ledger.refundTransaction).toBe("0xdeadbeef");

    // Idempotent: a second pass has nothing to do.
    const second = await worker.run();
    expect(second.attempted).toBe(0);
    expect(executor.refund).toHaveBeenCalledTimes(1);
  });

  it("backs off after a failure and gives up at the attempt limit", async () => {
    const store = await freshStore();
    await seedPending(store);
    const executor: RefundExecutor = {
      refund: vi.fn(async () => {
        throw new Error("treasury offline");
      }),
    };
    const worker = new RefundWorker(store, executor, {
      maxAttempts: 1,
      retryBaseMs: 0,
      limit: 10,
    });

    const first = await worker.run();
    expect(first).toMatchObject({ attempted: 1, refunded: 0, failed: 1 });
    const after = (await store.getLedgerByPayment(PAYMENT_KEY))!;
    expect(after.status).toBe("REFUND_PENDING");
    expect(after.refundAttempts).toBe(1);
    expect(after.refundLastError).toBe("treasury offline");

    // Attempts are exhausted: the row is skipped, not retried forever, and stays
    // visible to the operator endpoint and the pending gauge.
    const second = await worker.run();
    expect(second).toMatchObject({ refunded: 0, failed: 0, exhausted: 1 });
    expect(executor.refund).toHaveBeenCalledTimes(1);
    expect((await store.getLedgerByPayment(PAYMENT_KEY))?.status).toBe("REFUND_PENDING");
  });

  it("does nothing without a configured executor", async () => {
    const store = await freshStore();
    await seedPending(store);
    const worker = new RefundWorker(store, null, { maxAttempts: 3, retryBaseMs: 1000, limit: 10 });

    const result = await worker.run();
    expect(result).toMatchObject({ attempted: 0, skipped: true });
    expect((await store.getLedgerByPayment(PAYMENT_KEY))?.status).toBe("REFUND_PENDING");
  });

  it("repairs an unentitled row left SETTLED by a crash", async () => {
    const store = await freshStore();
    await store.insertUnclaimedLedger({
      paymentKey: PAYMENT_KEY,
      sessionId: `unsettled:${PAYMENT_KEY}`,
      payer: PAYER,
      amount: "50000",
      asset: "mock:usdc",
      network: "mock:local",
      mode: "mock",
      status: "SETTLED",
      reason: "settled_without_entitlement",
      settlementNonce: null,
    });

    await new RefundService(store).reconcile();
    expect((await store.getLedgerByPayment(PAYMENT_KEY))?.status).toBe("REFUNDED");
  });
});

describe("double charge", () => {
  it("refunds a second payment for a client key that already owns a session", async () => {
    const store = await freshStore();
    const firstKey = "c".repeat(64);
    const firstClaim = await store.claimPaymentIntent(firstKey, "d".repeat(64), 30_000);
    if (firstClaim.status !== "claimed") throw new Error("expected claim");
    await store.completeEntitlement(firstKey, firstClaim.token, payment(firstKey), sessionRecord("sbx_first", firstKey, "shared"));

    const secondKey = "e".repeat(64);
    const secondClaim = await store.claimPaymentIntent(secondKey, "d".repeat(64), 30_000);
    if (secondClaim.status !== "claimed") throw new Error("expected claim");

    await expect(
      store.completeEntitlement(
        secondKey,
        secondClaim.token,
        payment(secondKey),
        sessionRecord("sbx_second", secondKey, "shared"),
      ),
    ).rejects.toThrow(DuplicateEntitlementError);

    // One session, one charge, and the second charge is already refunded.
    expect(await countRows("sessions")).toBe(1);
    expect(await countRows("payments")).toBe(2);
    const ledger = (await store.getLedgerByPayment(secondKey))!;
    expect(ledger.sessionId).toBe(`duplicate:${secondKey}`);
    expect(ledger.reason).toBe("duplicate_client_nonce");
    expect(ledger.status).toBe("REFUNDED");
    // The mock transaction id lands in refund_tx, not in the settlement nonce.
    expect(ledger.refundTransaction).toMatch(/^mock:refund:/);
    expect(ledger.settlementNonce).toBe(`0x${"1".repeat(64)}`);
    // The intent is failed, so a retry of that payment cannot mint a session.
    expect((await store.getPaymentIntent(secondKey))?.status).toBe("failed");
  });

  it("leaves a real-mode duplicate charge REFUND_PENDING", async () => {
    const store = await freshStore();
    const firstKey = "f".repeat(64);
    const firstClaim = await store.claimPaymentIntent(firstKey, "d".repeat(64), 30_000);
    if (firstClaim.status !== "claimed") throw new Error("expected claim");
    await store.completeEntitlement(firstKey, firstClaim.token, payment(firstKey), sessionRecord("sbx_a", firstKey, "shared"));

    const secondKey = "1".repeat(64);
    const secondClaim = await store.claimPaymentIntent(secondKey, "d".repeat(64), 30_000);
    if (secondClaim.status !== "claimed") throw new Error("expected claim");
    const testnetPayment: PaymentRecord = { ...payment(secondKey), mode: "testnet", transaction: undefined };

    await expect(
      store.completeEntitlement(
        secondKey,
        secondClaim.token,
        testnetPayment,
        sessionRecord("sbx_b", secondKey, "shared"),
      ),
    ).rejects.toThrow(DuplicateEntitlementError);

    expect((await store.getLedgerByPayment(secondKey))?.status).toBe("REFUND_PENDING");
    expect(await store.listLedgerByStatus("REFUND_PENDING")).toHaveLength(1);
  });
});
