/**
 * Settlement reconciliation and refund execution (#31, F-10, F-19).
 *
 * What is pinned:
 *
 *  - a payment that settled but no session consumed becomes a refundable ledger
 *    row, keyed by payment key, with a synthetic session id;
 *  - the chain is asked first, from the authorizer and nonce recorded on the
 *    intent, so recovery works when the facilitator exposes no settlement
 *    lookup (the public testnet facilitator does not);
 *  - a chain answer is final: `unsettled` is never overridden by a lookup, and a
 *    read that failed is left for the next pass rather than recorded as debt;
 *  - mock mode refunds immediately, a real mode leaves REFUND_PENDING;
 *  - the worker is idempotent, backs off, and gives up after a bounded number of
 *    attempts instead of retrying forever;
 *  - a second payment for a client key pair that already owns a session is
 *    refunded and refused, not turned into a second session (double charge).
 *
 * The chain and the facilitator here are stubs: no test in this repository talks
 * to a real settlement backend, and none of this has moved real money.
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
import {
  SettlementRecovery,
  type SettlementRecoverySources,
} from "../../controller/src/settlement-recovery.js";
import type { SettlementProof } from "../../shared/src/entries/settlement.js";
import type { SettlementLookup } from "../../shared/src/entries/runtime.js";
import {
  AUTHORIZER,
  NONCE,
  RECIPIENT,
  TERMS,
  disproven,
  notFound,
  proven,
} from "../helpers/settlement-fixtures.js";

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

/** Base Sepolia, the network a chain-read deployment would configure. */
const TESTNET_NETWORK = "eip155:84532";
const TESTNET_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const TESTNET_REQUIREMENTS = JSON.stringify({
  network: TESTNET_NETWORK,
  scheme: "exact",
  asset: TESTNET_USDC,
  amount: TERMS.amount.toString(),
  payTo: RECIPIENT,
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

/**
 * A claimed intent whose owner died, with the requirements and (unless asked
 * otherwise) the authorizer and nonce a v20 controller records at claim time.
 */
async function seedStaleClaim(
  store: PostgresStore,
  key: string,
  opts: { requirements?: string; attribution?: boolean } = {},
): Promise<void> {
  const attribution = opts.attribution ?? true;
  const claim = await store.claimPaymentIntent(key, "b".repeat(64), 30_000, {
    requirementsJson: opts.requirements ?? REQUIREMENTS,
    authorizer: attribution ? AUTHORIZER : null,
    settlementNonce: attribution ? NONCE : null,
  });
  if (claim.status !== "claimed") throw new Error("expected claim");
}

function lookupReturning(record: {
  settled: boolean;
  payer?: string;
  amount?: string;
}): SettlementLookup {
  return { supported: true, lookup: vi.fn(async () => (record.settled ? record : null)) };
}

function sources(overrides: Partial<SettlementRecoverySources> = {}): SettlementRecoverySources {
  return { verifier: null, lookup: null, ...overrides };
}

describe("settlement recovery from the facilitator lookup", () => {
  it("records a settled payment with no entitlement as refundable", async () => {
    const store = await freshStore();
    await seedStaleClaim(store, PAYMENT_KEY, { attribution: false });
    const lookup = lookupReturning({ settled: true, payer: PAYER, amount: "50000" });

    const result = await new SettlementRecovery(store, new RefundService(store), sources({ lookup }), {
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
    await seedStaleClaim(store, PAYMENT_KEY, { attribution: false });

    await new SettlementRecovery(store, new RefundService(store), sources({
      lookup: lookupReturning({ settled: true }),
    }), {
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
    await seedStaleClaim(store, PAYMENT_KEY, { attribution: false });

    const result = await new SettlementRecovery(store, new RefundService(store), sources({
      lookup: lookupReturning({ settled: false }),
    }), {
      graceMs: 0,
      limit: 10,
      mode: "testnet",
    }).run();

    expect(result.recovered).toBe(0);
    expect(await store.getLedgerByPayment(PAYMENT_KEY)).toBeNull();
    // Still claimed, so a client retry can still complete it.
    expect((await store.getPaymentIntent(PAYMENT_KEY))?.status).toBe("claimed");
  });

  it("is a no-op with neither a chain read nor a settlement lookup", async () => {
    const store = await freshStore();
    await seedStaleClaim(store, PAYMENT_KEY);

    const result = await new SettlementRecovery(store, new RefundService(store), sources(), {
      graceMs: 0,
      limit: 10,
      mode: "testnet",
    }).run();

    expect(result).toEqual({ checked: 0, recovered: 0, errors: 0 });
    expect(await store.getLedgerByPayment(PAYMENT_KEY)).toBeNull();
  });

  it("does not duplicate a row that already exists", async () => {
    const store = await freshStore();
    await seedStaleClaim(store, PAYMENT_KEY, { attribution: false });
    const lookup = lookupReturning({ settled: true, payer: PAYER, amount: "50000" });
    const recovery = new SettlementRecovery(store, new RefundService(store), sources({ lookup }), {
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

describe("chain-verified settlement recovery (F-19, F-17)", () => {
  const chainOpts = {
    graceMs: 0,
    limit: 10,
    mode: "testnet" as const,
    network: TESTNET_NETWORK,
  };

  /** A verifier that answers one proof and records the terms it was asked about. */
  function proofVerifier(answer: SettlementProof) {
    return { settlementProof: vi.fn(async () => answer) };
  }

  it("records a settled payment from the chain with no facilitator lookup", async () => {
    const store = await freshStore();
    await seedStaleClaim(store, PAYMENT_KEY, { requirements: TESTNET_REQUIREMENTS });
    const verifier = proofVerifier(proven());

    const result = await new SettlementRecovery(store, new RefundService(store), sources({ verifier }), chainOpts).run();

    // The public testnet facilitator exposes no `GET /settlements/:key`, so the
    // chain is the only source in this case.
    expect(result).toEqual({ checked: 1, recovered: 1, errors: 0 });
    // The worker proves the transfer the API priced: authorizer and nonce from
    // the claim, recipient and amount from the same intent's requirements. A
    // nonce on its own is not a settlement.
    expect(verifier.settlementProof).toHaveBeenCalledWith(TERMS);
    const ledger = (await store.getLedgerByPayment(PAYMENT_KEY))!;
    expect(ledger.status).toBe("REFUND_PENDING");
    expect(ledger.sessionId).toBe(`unsettled:${PAYMENT_KEY}`);
    expect(ledger.reason).toBe("settled_without_entitlement");
    expect(ledger.payer).toBe(AUTHORIZER);
    expect(ledger.amount).toBe(TERMS.amount.toString());
    expect(ledger.asset).toBe(TESTNET_USDC);
    expect(ledger.network).toBe(TESTNET_NETWORK);
    // The nonce the chain proved is the nonce the refund can be keyed by.
    expect(ledger.settlementNonce).toBe(NONCE);
  });

  it("writes exactly one row when a lookup is also configured", async () => {
    const store = await freshStore();
    await seedStaleClaim(store, PAYMENT_KEY, { requirements: TESTNET_REQUIREMENTS });
    const verifier = proofVerifier(proven());
    const lookup = lookupReturning({ settled: true, payer: PAYER, amount: "50000" });
    const recovery = new SettlementRecovery(store, new RefundService(store), sources({ verifier, lookup }), chainOpts);

    await recovery.run();
    const second = await recovery.run();

    expect(second.recovered).toBe(0);
    expect(await store.listLedgerByStatus("REFUND_PENDING")).toHaveLength(1);
    // The chain already proved it; the weaker source is never consulted.
    expect(lookup.lookup).not.toHaveBeenCalled();
    expect(verifier.settlementProof).toHaveBeenCalledTimes(1);
  });

  it("records nothing for a used nonce whose transfer went to another address", async () => {
    const store = await freshStore();
    await seedStaleClaim(store, PAYMENT_KEY, { requirements: TESTNET_REQUIREMENTS });
    const verifier = proofVerifier(disproven("transfer_to_another_recipient"));
    const lookup = lookupReturning({ settled: true, payer: PAYER, amount: "50000" });

    const result = await new SettlementRecovery(store, new RefundService(store), sources({ verifier, lookup }), chainOpts).run();

    expect(result).toEqual({ checked: 1, recovered: 0, errors: 0 });
    expect(await store.getLedgerByPayment(PAYMENT_KEY)).toBeNull();
    expect((await store.getPaymentIntent(PAYMENT_KEY))?.status).toBe("claimed");
    // A positive disproof is final for this network; the lookup cannot override
    // it into a debt.
    expect(lookup.lookup).not.toHaveBeenCalled();
  });

  it("records nothing for a used nonce that underpaid the price", async () => {
    const store = await freshStore();
    await seedStaleClaim(store, PAYMENT_KEY, { requirements: TESTNET_REQUIREMENTS });
    const verifier = proofVerifier(disproven("transfer_below_price"));

    const result = await new SettlementRecovery(store, new RefundService(store), sources({ verifier }), chainOpts).run();

    expect(result).toEqual({ checked: 1, recovered: 0, errors: 0 });
    expect(await store.getLedgerByPayment(PAYMENT_KEY)).toBeNull();
    // The full terms were checked; the nonce alone would have looked settled.
    expect(verifier.settlementProof).toHaveBeenCalledWith(TERMS);
  });

  it("withholds when the nonce is outside the window, then falls back to the lookup", async () => {
    const store = await freshStore();
    await seedStaleClaim(store, PAYMENT_KEY, { requirements: TESTNET_REQUIREMENTS });
    const verifier = proofVerifier(notFound());

    const withheld = await new SettlementRecovery(store, new RefundService(store), sources({ verifier }), chainOpts).run();
    expect(withheld).toEqual({ checked: 1, recovered: 0, errors: 0 });
    expect(await store.getLedgerByPayment(PAYMENT_KEY)).toBeNull();
    expect((await store.getPaymentIntent(PAYMENT_KEY))?.status).toBe("claimed");

    // `not-found` is "could not place the payment", so the lookup may still
    // answer for the payment key.
    const lookup = lookupReturning({ settled: true, payer: PAYER, amount: "50000" });
    const fellBack = await new SettlementRecovery(store, new RefundService(store), sources({ verifier, lookup }), chainOpts).run();
    expect(fellBack).toEqual({ checked: 1, recovered: 1, errors: 0 });
    expect(lookup.lookup).toHaveBeenCalledWith(PAYMENT_KEY);
    expect((await store.getLedgerByPayment(PAYMENT_KEY))?.reason).toBe("settled_without_entitlement");
  });

  it("leaves the intent alone on a chain read error and retries it later", async () => {
    const store = await freshStore();
    await seedStaleClaim(store, PAYMENT_KEY, { requirements: TESTNET_REQUIREMENTS });
    let rpcDown = true;
    const verifier = {
      settlementProof: vi.fn(async () => {
        if (rpcDown) throw new Error("rpc unavailable");
        return proven();
      }),
    };
    const recovery = new SettlementRecovery(store, new RefundService(store), sources({ verifier }), chainOpts);

    const first = await recovery.run();
    expect(first).toEqual({ checked: 1, recovered: 0, errors: 1 });
    expect(await store.getLedgerByPayment(PAYMENT_KEY)).toBeNull();
    expect((await store.getPaymentIntent(PAYMENT_KEY))?.status).toBe("claimed");

    // The next pass asks again; the intent was only deferred, never failed.
    rpcDown = false;
    const second = await recovery.run();
    expect(second).toEqual({ checked: 1, recovered: 1, errors: 0 });
    expect((await store.getLedgerByPayment(PAYMENT_KEY))?.status).toBe("REFUND_PENDING");
  });

  it("does not ask the chain about another network's payment", async () => {
    const store = await freshStore();
    // Recorded requirements name mock:local, while the verifier reads Base
    // Sepolia. One USDC contract cannot answer for another chain.
    await seedStaleClaim(store, PAYMENT_KEY, { requirements: REQUIREMENTS });
    const verifier = proofVerifier(proven());
    const lookup = lookupReturning({ settled: true, payer: PAYER, amount: "50000" });

    const result = await new SettlementRecovery(store, new RefundService(store), sources({ verifier, lookup }), chainOpts).run();

    expect(result).toEqual({ checked: 1, recovered: 1, errors: 0 });
    expect(verifier.settlementProof).not.toHaveBeenCalled();
    expect((await store.getLedgerByPayment(PAYMENT_KEY))?.reason).toBe("settled_without_entitlement");
  });

  it("falls back to the lookup when the intent has no recorded nonce", async () => {
    const store = await freshStore();
    // A row claimed before schema v20 has no authorizer or nonce to ask about.
    await seedStaleClaim(store, PAYMENT_KEY, {
      requirements: TESTNET_REQUIREMENTS,
      attribution: false,
    });
    const verifier = proofVerifier(proven());
    const lookup = lookupReturning({ settled: true, payer: PAYER, amount: "50000" });

    const result = await new SettlementRecovery(store, new RefundService(store), sources({ verifier, lookup }), chainOpts).run();

    expect(result).toEqual({ checked: 1, recovered: 1, errors: 0 });
    expect(verifier.settlementProof).not.toHaveBeenCalled();
    expect(lookup.lookup).toHaveBeenCalledWith(PAYMENT_KEY);
  });

  it("will not prove a payment whose recorded terms have no usable price", async () => {
    const store = await freshStore();
    // No amount in the requirements: `value >= 0` would prove any transfer, so
    // the chain is not asked and the nonce alone decides nothing.
    await seedStaleClaim(store, PAYMENT_KEY, {
      requirements: JSON.stringify({
        network: TESTNET_NETWORK,
        scheme: "exact",
        asset: TESTNET_USDC,
        amount: "0",
        payTo: RECIPIENT,
      }),
    });
    const verifier = proofVerifier(proven());
    const lookup = lookupReturning({ settled: true, payer: PAYER, amount: "50000" });

    const result = await new SettlementRecovery(store, new RefundService(store), sources({ verifier, lookup }), chainOpts).run();

    expect(verifier.settlementProof).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, recovered: 1, errors: 0 });
    expect(lookup.lookup).toHaveBeenCalledWith(PAYMENT_KEY);
  });

  it("backfills the authorizer and nonce when a stale claim is reclaimed", async () => {
    const store = await freshStore();
    // Claimed by a build that did not record attribution, and already stale.
    const first = await store.claimPaymentIntent(PAYMENT_KEY, "b".repeat(64), -1);
    expect(first.status).toBe("claimed");
    expect((await store.getPaymentIntent(PAYMENT_KEY))?.authorizer).toBeNull();

    const reclaimed = await store.claimPaymentIntent(PAYMENT_KEY, "b".repeat(64), -1, {
      authorizer: AUTHORIZER,
      settlementNonce: NONCE,
    });
    expect(reclaimed.status).toBe("claimed");
    const intent = (await store.getPaymentIntent(PAYMENT_KEY))!;
    expect(intent.authorizer).toBe(AUTHORIZER);
    expect(intent.settlementNonce).toBe(NONCE);
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

  it("writes the payment source the caller names, and defaults it to x402", async () => {
    const store = await freshStore();
    const entry = {
      paymentKey: PAYMENT_KEY,
      sessionId: `unsettled:${PAYMENT_KEY}`,
      payer: PAYER,
      amount: "0",
      asset: "mock:usdc",
      network: "mock:local",
      mode: "mock" as const,
      status: "SETTLED" as const,
      reason: "settled_without_entitlement",
      settlementNonce: null,
    };
    // The unclaimed row is a ledger row, so it has to be able to say what the
    // ledger says. `source` is the column that used to be unreachable from
    // this insert.
    await store.insertUnclaimedLedger({ ...entry, source: "allowlist" });
    expect((await store.getLedgerByPayment(PAYMENT_KEY))?.source).toBe("allowlist");

    const other = { ...entry, paymentKey: "b".repeat(64), sessionId: "unsettled:other" };
    await store.insertUnclaimedLedger(other);
    expect((await store.getLedgerByPayment(other.paymentKey))?.source).toBe("x402");
  });

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
    expect(first).toMatchObject({ attempted: 1, refunded: 0, failed: 0, exhausted: 1 });
    const after = (await store.getLedgerByPayment(PAYMENT_KEY))!;
    expect(after.status).toBe("REFUND_PENDING");
    expect(after.refundAttempts).toBe(1);
    expect(after.refundLastError).toBe("treasury offline");
    // The claim is released, so no token is left behind.
    expect(after.refundClaimToken).toBeNull();

    // Attempts are exhausted: the row is not claimed again, so it is never sent
    // to the provider a second time, and it stays visible to the operator
    // endpoint and the pending gauge.
    const second = await worker.run();
    expect(second).toMatchObject({ attempted: 0, refunded: 0, failed: 0, exhausted: 0 });
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
