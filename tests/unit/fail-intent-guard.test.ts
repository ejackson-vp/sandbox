/**
 * The fail-intent ledger guard.
 *
 * `intent_failed_ledger_settled` is the alert that the books disagree, so no API
 * path may write that pair: the fail route used to mark an intent `failed` while
 * a `SETTLED` ledger row already existed for the same payment key, which made the
 * loudest money alert fire on an operator action.
 *
 * These run the real router over the real store. The last test forces the pair
 * with raw SQL, which is the only way left to reach it: that proves both that
 * the route cannot produce it and that the audit still catches a row edited
 * outside the service, so removing either half fails here.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditLedger,
  DEFAULT_LEDGER_AUDIT_LIMITS,
  type LedgerDivergence,
} from "../../controller/src/ledger-audit.js";
import { registerPaymentRoutes } from "../../controller/src/control-api/payments.js";
import type { ControlApiDeps } from "../../controller/src/control-api/types.js";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import { LedgerSettledError } from "../../controller/src/store/models.js";
import { limitsFor, paymentFixture, sessionFixture } from "../helpers/store-fixtures.js";
import { freshStore, sqlExec, sqlRows } from "../helpers/test-store.js";

const SERVERS: Server[] = [];

afterEach(async () => {
  await Promise.all(
    SERVERS.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

/** The payment routes over a real store, and nothing else they do not touch. */
async function listen(store: PostgresStore): Promise<string> {
  const app = express();
  app.use(express.json());
  registerPaymentRoutes(app, { store } as unknown as ControlApiDeps);
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  SERVERS.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** `POST /internal/payment-intents/:key/fail`, as the API and an operator call it. */
async function failIntentRoute(
  base: string,
  paymentKey: string,
  reason = "settlement_failed",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/internal/payment-intents/${encodeURIComponent(paymentKey)}/fail`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** What one audit sample would report for this key, and nothing else. */
async function divergences(store: PostgresStore, paymentKey: string): Promise<LedgerDivergence[]> {
  const now = Date.now();
  const snapshot = await store.readLedgerAudit(now, DEFAULT_LEDGER_AUDIT_LIMITS);
  return auditLedger(snapshot, DEFAULT_LEDGER_AUDIT_LIMITS, now).divergences.filter(
    (row) => row.paymentKey === paymentKey,
  );
}

const SPEC_HASH = "a".repeat(64);
const PAYER = "0x0000000000000000000000000000000000000001";

/** Claim the intent and settle it, so the ledger row is `SETTLED`. */
async function seedSettled(
  store: PostgresStore,
  paymentKey: string,
  sessionId: string,
): Promise<void> {
  const claim = await store.claimPaymentIntent(paymentKey, SPEC_HASH, 30_000);
  if (claim.status !== "claimed") throw new Error(`expected a claim, got ${claim.status}`);
  await store.completeEntitlement(
    paymentKey,
    claim.token,
    paymentFixture({ paymentKey, network: "mock:local", payer: PAYER, transaction: "mock:tx" }),
    sessionFixture({
      id: sessionId,
      paymentKey,
      clientPublicKey: "pk-fail-guard",
      clientNonce: `nonce-${sessionId}`,
      tier: "standard",
      durationSeconds: 300,
      limits: limitsFor("unit"),
    }),
  );
}

/**
 * The settle-then-crash shape settlement recovery writes: a `claimed` intent and
 * a `SETTLED` ledger row for it. This is the pair the route used to complete.
 */
async function seedRecovered(store: PostgresStore, paymentKey: string): Promise<void> {
  const claim = await store.claimPaymentIntent(paymentKey, SPEC_HASH, 30_000);
  if (claim.status !== "claimed") throw new Error(`expected a claim, got ${claim.status}`);
  const now = Date.now();
  await sqlExec(
    `INSERT INTO payment_ledger
       (payment_key, session_id, payer, amount, asset, network, mode, status, reason,
        created_at, updated_at)
     VALUES ($1, $2, $3, '50000', 'mock:usdc', 'eip155:84532', 'mock', 'SETTLED',
             'settled_without_entitlement', $4, $4)`,
    [paymentKey, `unsettled:${paymentKey}`, PAYER, now],
  );
}

describe("fail intent refuses a settled ledger", () => {
  it("answers 409 naming the ledger state and changes nothing", async () => {
    const store = await freshStore();
    const paymentKey = "1".repeat(64);
    const sessionId = "sbx_fail_guard_settled";
    await seedSettled(store, paymentKey, sessionId);
    const base = await listen(store);

    const res = await failIntentRoute(base, paymentKey);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "ledger_settled",
      ledgerStatus: "SETTLED",
      message: expect.stringContaining("SETTLED"),
    });
    // The operator is told what to do instead of retrying.
    expect(String(res.body.message)).toMatch(/reverse the settlement/);

    // Both rows are exactly as they were: nothing was failed, nothing rewritten.
    expect(await store.getPaymentIntent(paymentKey)).toMatchObject({
      status: "settled",
      sessionId,
    });
    expect(await store.getLedgerByPayment(paymentKey)).toMatchObject({
      status: "SETTLED",
      sessionId,
    });

    // The store port names the same refusal for a caller that is not the route.
    await expect(store.failPaymentIntent(paymentKey, "settlement_failed")).rejects.toThrow(
      LedgerSettledError,
    );
    expect(await divergences(store, paymentKey)).toEqual([]);
  });

  it("still fails an intent whose money never moved", async () => {
    const store = await freshStore();
    const paymentKey = "2".repeat(64);
    const claim = await store.claimPaymentIntent(paymentKey, SPEC_HASH, 30_000);
    if (claim.status !== "claimed") throw new Error("expected a claim");
    const base = await listen(store);

    const res = await failIntentRoute(base, paymentKey, "settlement_refused");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(await store.getPaymentIntent(paymentKey)).toMatchObject({
      status: "failed",
      reason: "settlement_refused",
      claimToken: null,
    });
    expect(await store.getLedgerByPayment(paymentKey)).toBeNull();
    expect(await divergences(store, paymentKey)).toEqual([]);
  });

  it("refuses the settlement-recovery shape that used to reach the alert", async () => {
    const store = await freshStore();
    const paymentKey = "3".repeat(64);
    await seedRecovered(store, paymentKey);
    const base = await listen(store);

    const res = await failIntentRoute(base, paymentKey);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("ledger_settled");
    // The intent stays claimed, which the audit documents as silent, so recovery
    // still owns the payment and the refund policy resolves it.
    expect((await store.getPaymentIntent(paymentKey))?.status).toBe("claimed");
    expect((await store.getLedgerByPayment(paymentKey))?.status).toBe("SETTLED");
    expect(await divergences(store, paymentKey)).toEqual([]);
  });

  it("leaves the divergence reachable only by editing rows outside the service", async () => {
    const store = await freshStore();
    const paymentKey = "4".repeat(64);
    await seedRecovered(store, paymentKey);
    const base = await listen(store);

    // No route path writes the pair: the refusal is the whole point.
    expect((await failIntentRoute(base, paymentKey)).status).toBe(409);
    expect(await divergences(store, paymentKey)).toEqual([]);

    // The audit itself still works. A direct edit is now the only way to make
    // the books disagree, and it must still be caught.
    await sqlExec("UPDATE payment_intents SET status = 'failed' WHERE payment_key = $1", [
      paymentKey,
    ]);
    expect(await divergences(store, paymentKey)).toEqual([
      { paymentKey, reason: "intent_failed_ledger_settled" },
    ]);
    expect(
      await sqlRows("SELECT status FROM payment_intents WHERE payment_key = $1", [paymentKey]),
    ).toMatchObject([{ status: "failed" }]);
  });
});
