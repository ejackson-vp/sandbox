/**
 * Schema v19 -> v20: `payment_intents` gains the attribution chain recovery
 * needs (F-19, ADR 0014).
 *
 * The ladder is additive and replayed by every writer open, but the money rule
 * is that a version bump must never recreate a money table. This pins the
 * upgrade the way an operator would hit it: a populated v19 database, the
 * writer reopened, the intent still there, and the new columns present and
 * writeable. It also proves the backfill rule: a row claimed before the columns
 * existed keeps NULL (so recovery uses the lookup) and gains the values the
 * next claim of the same payment supplies.
 */
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../../controller/src/store/schema-version.js";
import { closeStore, freshStore, openStore, sqlExec, sqlRows } from "../helpers/test-store.js";

const PAYMENT_KEY = "d".repeat(64);
const SPEC_HASH = "e".repeat(64);
const AUTHORIZER = `0x${"b".repeat(40)}`;
const NONCE = `0x${"a".repeat(64)}`;
const REQUIREMENTS = JSON.stringify({
  network: "eip155:84532",
  scheme: "exact",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  amount: "50000",
  payTo: "0x0000000000000000000000000000000000000402",
});

describe("payment_intents attribution migration", () => {
  it("upgrades a populated v19 database without losing the intent", async () => {
    const store = await freshStore();
    const claim = await store.claimPaymentIntent(PAYMENT_KEY, SPEC_HASH, 30_000, {
      requirementsJson: REQUIREMENTS,
      authorizer: AUTHORIZER,
      settlementNonce: NONCE,
    });
    expect(claim.status).toBe("claimed");

    // Recreate the v19 shape: the columns are gone and the version says 19.
    // The store is closed first so no pooled prepared statement outlives the
    // column drop.
    await closeStore();
    await sqlExec(
      "ALTER TABLE payment_intents DROP COLUMN authorizer, DROP COLUMN settlement_nonce",
    );
    await sqlExec("UPDATE sandbox_schema SET version = 19");

    const upgraded = await openStore();
    expect(await upgraded.healthCheck()).toMatchObject({
      ok: true,
      schemaVersion: SCHEMA_VERSION,
    });

    // The rows the ladder must never touch are still there.
    const intent = (await upgraded.getPaymentIntent(PAYMENT_KEY))!;
    expect(intent.specHash).toBe(SPEC_HASH);
    expect(intent.requirementsJson).toBe(REQUIREMENTS);
    // A pre-v20 row has nothing to ask the chain about, so recovery falls back
    // to the facilitator lookup for it.
    expect(intent.authorizer).toBeNull();
    expect(intent.settlementNonce).toBeNull();

    // The next claim of the same payment backfills both, so a row from an older
    // build is repaired the first time a current API retries it.
    const reclaimed = await upgraded.claimPaymentIntent(PAYMENT_KEY, SPEC_HASH, -1, {
      authorizer: AUTHORIZER,
      settlementNonce: NONCE,
    });
    expect(reclaimed.status).toBe("claimed");
    expect(await upgraded.getPaymentIntent(PAYMENT_KEY)).toMatchObject({
      authorizer: AUTHORIZER,
      settlementNonce: NONCE,
    });
  });

  it("creates the columns on a fresh database", async () => {
    await closeStore();
    const store = await freshStore();
    const columns = await sqlRows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'payment_intents'
          AND column_name IN ('authorizer','settlement_nonce')`,
    );
    expect(columns.map((row) => row.column_name).sort()).toEqual([
      "authorizer",
      "settlement_nonce",
    ]);
    expect((await store.healthCheck()).schemaVersion).toBe(SCHEMA_VERSION);
  });
});
