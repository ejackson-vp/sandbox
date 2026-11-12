/**
 * Payment-intent claim/reclaim/complete race.
 *
 * Two claims are issued before either is awaited, so they land on two pool
 * connections. The point is unchanged from the SQLite version: the stale owner
 * must never settle, and after the live owner settles the stale owner receives
 * the winning session instead of an error.
 */
import { describe, expect, it } from "vitest";
import { PaymentClaimLostError } from "../../controller/src/store/models.js";
import type { PaymentRecord, SessionRecord } from "../../controller/src/store/models.js";
import { limitsFor, paymentFixture, sessionFixture } from "../helpers/store-fixtures.js";
import { countRows, freshStore } from "../helpers/test-store.js";

function paymentRecord(key: string): PaymentRecord {
  return paymentFixture({
    paymentKey: key,
    network: "mock:local",
    payer: "0x0000000000000000000000000000000000000001",
    transaction: "mock:tx",
  });
}

function sessionRecord(id: string, key: string): SessionRecord {
  return sessionFixture({
    id,
    paymentKey: key,
    clientPublicKey: "pk",
    clientNonce: `nonce-${id}`,
    tier: "standard",
    durationSeconds: 300,
    limits: limitsFor("unit"),
  });
}

describe("real Postgres payment-intent concurrency", () => {
  it("fences a reclaimed owner and hands both completions the same session", async () => {
    const store = await freshStore({ max: 10 });
    const paymentKey = "c".repeat(64);
    const specHash = "a".repeat(64);

    // 1. The first claim inserts the intent; the second reclaims it because
    //    its lease is already stale (staleMs = -1). On Postgres the two
    //    inserts serialise on the primary key, so the interesting step is the
    //    reclaim, not a simultaneous insert: a concurrent second claim can
    //    legitimately answer in_progress while the first is still in flight.
    const claims = [
      await store.claimPaymentIntent(paymentKey, specHash, -1),
      await store.claimPaymentIntent(paymentKey, specHash, -1),
    ];
    expect(claims.map((c) => c.status)).toEqual(["claimed", "claimed"]);
    const staleIndex = claims.findIndex((c) => c.status === "claimed" && c.recovered === false);
    const liveIndex = claims.findIndex((c) => c.status === "claimed" && c.recovered === true);
    expect(staleIndex).toBeGreaterThanOrEqual(0);
    expect(liveIndex).toBeGreaterThanOrEqual(0);
    expect(staleIndex).not.toBe(liveIndex);
    const stale = claims[staleIndex]!;
    const live = claims[liveIndex]!;
    if (stale.status !== "claimed" || live.status !== "claimed") throw new Error("expected claims");
    expect(stale.token).not.toBe(live.token);

    // 2. The stale owner cannot settle while the live owner holds the claim.
    await expect(
      store.completeEntitlement(
        paymentKey,
        stale.token,
        paymentRecord(paymentKey),
        sessionRecord("sbx_0000000000000000000000a1", paymentKey),
      ),
    ).rejects.toThrow(PaymentClaimLostError);

    expect(await countRows("sessions")).toBe(0);
    expect(await countRows("payments")).toBe(0);
    expect((await store.getPaymentIntent(paymentKey))?.status).toBe("claimed");

    // 3. Both owners complete concurrently with the live token and different
    //    session ids. Exactly one creates the session; the other is idempotent.
    const sessionIds = ["sbx_0000000000000000000000b1", "sbx_0000000000000000000000b2"];
    const completions = await Promise.all(
      sessionIds.map((id) =>
        store.completeEntitlement(paymentKey, live.token, paymentRecord(paymentKey), sessionRecord(id, paymentKey)),
      ),
    );
    const created = completions.filter((c) => c.created);
    const idempotent = completions.filter((c) => !c.created);
    expect(created).toHaveLength(1);
    expect(idempotent).toHaveLength(1);
    const winner = created[0]!.sessionId;
    expect(idempotent[0]!.sessionId).toBe(winner);
    expect(sessionIds).toContain(winner);

    // 4. The stale owner now learns the outcome: the winning session, no error.
    const staleAfter = await store.completeEntitlement(
      paymentKey,
      stale.token,
      paymentRecord(paymentKey),
      sessionRecord("sbx_0000000000000000000000a2", paymentKey),
    );
    expect(staleAfter).toEqual({ sessionId: winner, created: false });

    expect(await countRows("sessions")).toBe(1);
    expect(await countRows("payments")).toBe(1);
    expect((await store.getSession(winner))?.paymentKey).toBe(paymentKey);
    expect((await store.getLedgerBySession(winner))?.status).toBe("SETTLED");
    expect(await store.getPaymentIntent(paymentKey)).toMatchObject({
      status: "settled",
      sessionId: winner,
      claimToken: null,
    });
  }, 30_000);
});
