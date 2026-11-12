/**
 * The store contract, over Postgres, plus the writer lock.
 *
 * Runs unconditionally: Postgres is the only backend now, and the suite harness
 * has already failed the run if `DATABASE_URL` is missing. The tests use this
 * worker's throwaway database, so the truncation in the contract fixture cannot
 * touch anything else.
 */
import { beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { PostgresStore } from "../../controller/src/store/postgres/store.js";
import { WriterLockUnavailableError } from "../../controller/src/store/postgres/pg.js";
import { ensureTestDatabase, testDatabaseUrl } from "../helpers/test-store.js";
import { postgresBackend } from "./store-contract/fixtures.js";
import { describeStoreContract } from "./store-contract/suite.js";

const url = testDatabaseUrl();

describe("postgres", () => {
  beforeAll(async () => {
    await ensureTestDatabase();
  });

  describeStoreContract(postgresBackend(url));

  describe("writer lock", () => {
    it("refuses a second writer for the same database", async () => {
      const first = await PostgresStore.open(url, { writer: true });
      try {
        await expect(PostgresStore.open(url, { writer: true })).rejects.toThrow(
          WriterLockUnavailableError,
        );
      } finally {
        await first.close();
      }
    });

    it("starts a standby read-only and lets it take over after the writer releases", async () => {
      const first = await PostgresStore.open(url, { writer: true });
      const standby = await PostgresStore.open(url, { writer: false });
      try {
        expect(standby.writesAreBlocked).toBe(true);

        // A write is a loud refusal, not a silent no-op.
        await expect(
          standby.claimPaymentIntent("d".repeat(64), "e".repeat(64), 30_000),
        ).rejects.toThrow(WriterLockUnavailableError);

        // And it cannot promote itself while the lock is held.
        await expect(standby.setWritesBlocked(false)).rejects.toThrow(WriterLockUnavailableError);

        await first.close();

        await standby.setWritesBlocked(false);
        expect(standby.writesAreBlocked).toBe(false);
        const claim = await standby.claimPaymentIntent("d".repeat(64), "e".repeat(64), 30_000);
        expect(claim.status).toBe("claimed");
      } finally {
        await first.close();
        await standby.close();
      }
    });

    it("reports migrations_incomplete for a standby on an unmigrated database", async () => {
      const scratch = `sandbox_unmigrated_${Date.now().toString(36)}`;
      const admin = new pg.Client({ connectionString: url });
      await admin.connect();
      try {
        await admin.query(`CREATE DATABASE "${scratch}"`);
        const scratchUrl = new URL(url);
        scratchUrl.pathname = `/${scratch}`;
        const standby = await PostgresStore.open(scratchUrl.toString(), { writer: false });
        try {
          expect(standby.writesAreBlocked).toBe(true);
          expect(await standby.healthCheck()).toMatchObject({
            ok: false,
            reason: "migrations_incomplete",
          });
          await expect(
            standby.claimPaymentIntent("f".repeat(64), "e".repeat(64), 30_000),
          ).rejects.toThrow(WriterLockUnavailableError);
        } finally {
          await standby.close();
        }
      } finally {
        await admin.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
        await admin.end();
      }
    });
  });
});
