/**
 * The allowlist decision and its budgets, against real Postgres (ADR 0013).
 *
 * These are the parts the API cannot enforce alone: a tier ceiling, a
 * concurrency ceiling counted from live sessions, and a budget namespace that
 * keeps a free session out of the paying payer's rows.
 */
import { describe, expect, it } from "vitest";
import type { PaymentRecord, SessionRecord } from "../../controller/src/store/models.js";
import type { BudgetLimits } from "../../controller/src/store/budget-decision.js";
import { freshStore, sqlExec, sqlRows } from "../helpers/test-store.js";

const NOW = Date.now();
const OWNER = "0x00000000000000000000000000000000000000aa";
const FRIEND = "0x00000000000000000000000000000000000000bb";

const SESSION_LIMITS = {
  cpuMillis: 500,
  memoryMiB: 512,
  diskMiB: 256,
  maxOutputBytes: 262_144,
  maxFileBytes: 8 * 1024 * 1024,
  maxCommandSeconds: 300,
  maxProcesses: 64,
};

const BUDGET_LIMITS: BudgetLimits = {
  windowMs: 3_600_000,
  payerCreates: 10,
  payerSpend: "1000000",
  payerConcurrent: 1,
  globalCreates: 100,
  globalConcurrent: 0,
};

async function addEntry(
  address: string,
  maxTier: string,
  maxConcurrent: number,
): Promise<void> {
  await sqlExec(
    `INSERT INTO payer_allowlist (address, label, max_tier, max_concurrent, created_at, disabled_at)
     VALUES ($1, $2, $3, $4, $5, NULL)`,
    [address.toLowerCase(), "owner-agent", maxTier, maxConcurrent, NOW],
  );
}

/** A live session with a ledger row, paid or free. */
async function seedSession(
  store: Awaited<ReturnType<typeof freshStore>>,
  id: string,
  address: string,
  source: "x402" | "allowlist",
): Promise<void> {
  const key = `${source}-${id}`;
  const claim = await store.claimPaymentIntent(key, "a".repeat(64), 30_000);
  if (claim.status !== "claimed") throw new Error("expected claim");
  const payment: PaymentRecord = {
    paymentKey: key,
    network: "mock:local",
    scheme: "exact",
    asset: "mock:usdc",
    amount: source === "allowlist" ? "0" : "50000",
    payTo: "0x0000000000000000000000000000000000000402",
    payer: address,
    transaction: source === "allowlist" ? undefined : "mock:tx",
    mode: "mock",
    source,
    ...(source === "allowlist"
      ? { label: "owner-agent", budgetKey: `allow:${address.toLowerCase()}` }
      : {}),
  };
  await store.completeEntitlement(key, claim.token, payment, {
    id,
    capabilityHash: "a".repeat(64),
    capabilityExpiresAt: NOW + 3_600_000,
    clientPublicKey: `client-${id}`,
    clientNonce: `nonce-${id}`,
    clientSigner: address,
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

describe("allowlist decision", () => {
  it("admits a listed address and reports the entry's ceilings", async () => {
    const store = await freshStore();
    await addEntry(OWNER, "standard", 2);

    await expect(store.authorizeAllowlistedPayer(OWNER, "standard")).resolves.toEqual({
      allowed: true,
      label: "owner-agent",
      maxTier: "standard",
      maxConcurrent: 2,
    });
    // Address matching is case-insensitive; the row is the same row.
    await expect(store.authorizeAllowlistedPayer(OWNER.toUpperCase(), "short")).resolves.toMatchObject({
      allowed: true,
    });
  });

  it("refuses a missing row and a disabled row", async () => {
    const store = await freshStore();
    await expect(store.authorizeAllowlistedPayer(FRIEND, "short")).resolves.toEqual({
      allowed: false,
      reason: "not_allowlisted",
    });

    await addEntry(OWNER, "long", 2);
    await sqlExec("UPDATE payer_allowlist SET disabled_at = $1 WHERE address = $2", [
      NOW,
      OWNER.toLowerCase(),
    ]);
    await expect(store.authorizeAllowlistedPayer(OWNER, "short")).resolves.toEqual({
      allowed: false,
      reason: "disabled",
    });
  });

  it("enforces max_tier and refuses an unrankable custom tier", async () => {
    const store = await freshStore();
    await addEntry(OWNER, "standard", 2);

    await expect(store.authorizeAllowlistedPayer(OWNER, "extended")).resolves.toEqual({
      allowed: false,
      reason: "tier_not_allowed",
    });
    await expect(store.authorizeAllowlistedPayer(OWNER, "custom")).resolves.toEqual({
      allowed: false,
      reason: "tier_not_allowed",
    });
    await expect(store.authorizeAllowlistedPayer(OWNER, "short")).resolves.toMatchObject({
      allowed: true,
    });
  });

  it("enforces max_concurrent against free sessions only", async () => {
    const store = await freshStore();
    await addEntry(OWNER, "long", 1);

    // A paid session by the same address does not consume the free ceiling.
    await seedSession(store, "sbx_paid", OWNER, "x402");
    await expect(store.authorizeAllowlistedPayer(OWNER, "short")).resolves.toMatchObject({
      allowed: true,
    });

    await seedSession(store, "sbx_free", OWNER, "allowlist");
    await expect(store.authorizeAllowlistedPayer(OWNER, "short")).resolves.toEqual({
      allowed: false,
      reason: "concurrency_exhausted",
    });
  });
});

describe("allowlist budgets", () => {
  it("keeps the free row out of the paying payer's budget", async () => {
    const store = await freshStore();
    await seedSession(store, "sbx_free", OWNER, "allowlist");

    // The free session counts in its own namespace...
    const free = await store.reserveBudgets(`allow:${OWNER.toLowerCase()}`, "0", BUDGET_LIMITS);
    expect(free.ok).toBe(false);
    if (free.ok) throw new Error("expected a refusal");
    expect(free.scope).toBe("payer_concurrent");

    // ...and not in the paying one, which is still free to open a session.
    const paid = await store.reserveBudgets(OWNER, "50000", BUDGET_LIMITS);
    expect(paid.ok).toBe(true);

    // The two rows are distinct keys, not one row with a shared count.
    const rows = await sqlRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM payer_budgets WHERE budget_key IN ($1, $2)",
      [`payer:${OWNER.toLowerCase()}`, `payer:allow:${OWNER.toLowerCase()}`],
    );
    expect(Number(rows[0]?.n ?? 0)).toBe(2);
  });

  it("records zero spend for a free session", async () => {
    const store = await freshStore();
    await seedSession(store, "sbx_free", OWNER, "allowlist");
    const ledger = await store.getLedgerBySession("sbx_free");
    expect(ledger).toMatchObject({
      amount: "0",
      source: "allowlist",
      reason: "owner-agent",
      payer: OWNER,
      settlementNonce: null,
    });
  });

  it("never queues a $0 allowlist row for a refund", async () => {
    const store = await freshStore();
    await seedSession(store, "sbx_free", OWNER, "allowlist");
    // Terminal before READY would refund a paid row. A free one has nothing to
    // send back, so it must not appear in the candidate list.
    await sqlExec("UPDATE sessions SET state = 'EXPIRED' WHERE id = $1", ["sbx_free"]);

    expect(await store.listUnrefundedTerminalBeforeReady()).toHaveLength(0);
    expect(await store.listUnclaimedSettled()).toHaveLength(0);
  });

  it("scopes source-defaulting to existing rows", async () => {
    const store = await freshStore();
    await seedSession(store, "sbx_paid", OWNER, "x402");
    expect((await store.getLedgerBySession("sbx_paid"))?.source).toBe("x402");
  });
});
