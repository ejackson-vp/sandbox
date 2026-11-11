/**
 * Durable per-payer and global create budget (#48).
 *
 * The in-memory buckets are already tested (admission.test.ts) and are the
 * first line. What these pin is the durability and the parts a token bucket
 * cannot do:
 *
 *  - a window survives a restart, so a restart is not a reset;
 *  - spend is counted in the settlement transaction, not at reservation, so a
 *    failed payment cannot lock a payer out;
 *  - concurrency comes from live rows, so a crash cannot leak a slot;
 *  - the global budget is independent of any client-chosen field, which is what
 *    a rotated `from` cannot escape (F-09).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Store,
  type PaymentRecord,
  type SessionRecord,
} from "../../controller/src/store.js";
import type { BudgetLimits } from "../../controller/src/store/budgets.js";
import { postCreate } from "../helpers/create-route.js";

const NOW = Date.now();
const PAYER = "0x00000000000000000000000000000000000000aa";
const OTHER_PAYER = "0x00000000000000000000000000000000000000bb";

const LIMITS: BudgetLimits = {
  windowMs: 3_600_000,
  payerCreates: 3,
  payerSpend: "1000000",
  payerConcurrent: 0,
  globalCreates: 100,
  globalConcurrent: 0,
};

const SESSION_LIMITS = {
  cpuMillis: 500,
  memoryMiB: 512,
  diskMiB: 256,
  maxOutputBytes: 262_144,
  maxFileBytes: 8 * 1024 * 1024,
  maxCommandSeconds: 300,
  maxProcesses: 64,
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshStore(): { store: Store; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "x402-budget-"));
  dirs.push(dir);
  const path = join(dir, "controller.db");
  return { store: new Store(path), path };
}

function payment(key: string, payer: string, amount = "50000"): PaymentRecord {
  return {
    paymentKey: key,
    network: "mock:local",
    scheme: "exact",
    asset: "mock:usdc",
    amount,
    payTo: "0x0000000000000000000000000000000000000402",
    payer,
    transaction: "mock:tx",
    mode: "mock",
  };
}

/** A PAID row with a ledger entry, i.e. a live session owned by `payer`. */
async function seedLiveSession(
  store: Store,
  id: string,
  payer: string,
  amount = "50000",
): Promise<void> {
  const key = `key-${id}`;
  const claim = await store.claimPaymentIntent(key, "a".repeat(64), 30_000);
  if (claim.status !== "claimed") throw new Error("expected claim");
  await store.completeEntitlement(key, claim.token, payment(key, payer, amount), {
    id,
    capabilityHash: "a".repeat(64),
    capabilityExpiresAt: NOW + 3_600_000,
    clientPublicKey: `client-${id}`,
    clientNonce: `nonce-${id}`,
    clientSigner: payer,
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
  } as unknown as SessionRecord);
}

describe("durable create budget", () => {
  it("caps creates per payer per window and reports what is left", async () => {
    const { store } = freshStore();
    const limits = { ...LIMITS, payerCreates: 2 };

    expect((await store.reserveBudgets(PAYER, "50000", limits)).ok).toBe(true);
    expect((await store.reserveBudgets(PAYER, "50000", limits)).ok).toBe(true);
    const rejected = await store.reserveBudgets(PAYER, "50000", limits);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("expected rejection");
    expect(rejected.scope).toBe("payer_create");
    expect(rejected.remaining.payerCreates).toBe(0);
    expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
    // A different payer is unaffected.
    expect((await store.reserveBudgets(OTHER_PAYER, "50000", limits)).ok).toBe(true);
  });

  it("keeps the window across a restart", async () => {
    const { store, path } = freshStore();
    const limits = { ...LIMITS, payerCreates: 2 };
    await store.reserveBudgets(PAYER, "50000", limits);
    await store.reserveBudgets(PAYER, "50000", limits);
    store.close();

    const reopened = new Store(path);
    const rejected = await reopened.reserveBudgets(PAYER, "50000", limits);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("expected rejection");
    expect(rejected.scope).toBe("payer_create");
    reopened.close();
  });

  it("rolls the window when it expires", async () => {
    const { store } = freshStore();
    const limits = { ...LIMITS, payerCreates: 1, windowMs: 1_000 };
    const now = NOW;
    expect(store.budgets.reserve(PAYER, "0", limits, now).ok).toBe(true);
    expect(store.budgets.reserve(PAYER, "0", limits, now + 10).ok).toBe(false);
    expect(store.budgets.reserve(PAYER, "0", limits, now + 1_001).ok).toBe(true);
  });

  it("commits spend in the settlement transaction and refuses over-budget payers", async () => {
    const { store } = freshStore();
    const limits = { ...LIMITS, payerCreates: 100, payerSpend: "1000000" };

    // A settled payment commits 400000 to the verified payer.
    await seedLiveSession(store, "sbx_spend_1", PAYER, "400000");
    // 400000 committed + 700000 requested > 1000000.
    const rejected = await store.reserveBudgets(PAYER, "700000", limits);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("expected rejection");
    expect(rejected.scope).toBe("payer_spend");
    expect(rejected.remaining.payerSpend).toBe("600000");
    // Exactly the remainder is admitted.
    expect((await store.reserveBudgets(PAYER, "600000", limits)).ok).toBe(true);
  });

  it("does not count spend for a payment that never settled", async () => {
    const { store } = freshStore();
    const limits = { ...LIMITS, payerCreates: 100, payerSpend: "100000" };
    expect((await store.reserveBudgets(PAYER, "100000", limits)).ok).toBe(true);
    // The create was reserved but nothing settled, so the payer can still spend
    // up to the limit.
    expect((await store.reserveBudgets(PAYER, "100000", limits)).ok).toBe(true);
  });

  it("counts concurrency from live sessions", async () => {
    const { store } = freshStore();
    const limits = { ...LIMITS, payerCreates: 100, payerConcurrent: 1 };
    await seedLiveSession(store, "sbx_live_1", PAYER);

    const rejected = await store.reserveBudgets(PAYER, "0", limits);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("expected rejection");
    expect(rejected.scope).toBe("payer_concurrent");
    expect(rejected.remaining.payerConcurrent).toBe(0);
    // The same payer's terminal session would not count, and another payer is
    // unaffected right now.
    expect((await store.reserveBudgets(OTHER_PAYER, "0", limits)).ok).toBe(true);
  });

  it("bounds the global budget independently of the payer key", async () => {
    const { store } = freshStore();
    const limits = { ...LIMITS, payerCreates: 100, globalCreates: 2 };
    expect((await store.reserveBudgets(PAYER, "0", limits)).ok).toBe(true);
    expect((await store.reserveBudgets(OTHER_PAYER, "0", limits)).ok).toBe(true);
    // A third, never-seen address still hits the global cap: rotating `from`
    // buys a fresh payer row, not a fresh global row.
    const rejected = await store.reserveBudgets("0x00000000000000000000000000000000000000cc", "0", limits);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("expected rejection");
    expect(rejected.scope).toBe("global_create");
  });

  it("does not consume global budget when the payer budget refuses", async () => {
    const { store } = freshStore();
    const limits = { ...LIMITS, payerCreates: 1, globalCreates: 10 };
    expect((await store.reserveBudgets(PAYER, "0", limits)).ok).toBe(true);

    const refused = await store.reserveBudgets(PAYER, "0", limits);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected rejection");
    // 10 - 1 reserved so far; the refused attempt consumed nothing.
    expect(refused.remaining.globalCreates).toBe(9);

    const next = await store.reserveBudgets(OTHER_PAYER, "0", limits);
    expect(next.ok).toBe(true);
    if (!next.ok) throw new Error("expected admission");
    // Two successful reservations in a budget of 10.
    expect(next.remaining.globalCreates).toBe(8);
  });
});

describe("create route with an exhausted budget", () => {
  it("answers 429 with the remaining budget before capacity or money", async () => {
    const result = await postCreate(({ controller }) => {
      controller.reserveBudget.mockResolvedValue({
        ok: false,
        scope: "payer_create",
        retryAfterSeconds: 900,
        remaining: {
          payerCreates: 0,
          payerSpend: "50000000",
          payerConcurrent: 4,
          globalCreates: 1200,
          globalConcurrent: 190,
        },
        windowResetsAt: Date.now() + 900_000,
      });
    });

    expect(result.status).toBe(429);
    expect(result.body).toMatchObject({
      error: "budget_exhausted",
      scope: "payer_create",
      retryAfterSeconds: 900,
      remaining: { payerCreates: 0, globalCreates: 1200 },
    });
    expect(result.controller.holdCapacity).not.toHaveBeenCalled();
    expect(result.controller.claimIntent).not.toHaveBeenCalled();
  });

  it("fails closed when the budget store is unreachable", async () => {
    const result = await postCreate(({ controller }) => {
      controller.reserveBudget.mockRejectedValue(new Error("connect ECONNREFUSED"));
    });

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ error: "admission_unavailable", retryable: true });
    expect(result.controller.holdCapacity).not.toHaveBeenCalled();
  });
});
