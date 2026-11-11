/**
 * The store contract, over Postgres, plus the writer lock.
 *
 * Skipped unless `DATABASE_URL` points at a throwaway database. CI runs it in
 * the `postgres contract` job against a `postgres:17` service container; locally
 * it runs when the variable is exported. The suite truncates every table, so
 * point it at a database nobody else is using.
 */
import { describe, expect, it } from "vitest";
import { PostgresStore } from "../../controller/src/store/postgres/store.js";
import { WriterLockUnavailableError } from "../../controller/src/store/postgres/pg.js";
import { postgresBackend } from "./store-contract/fixtures.js";
import { describeStoreContract } from "./store-contract/suite.js";

const url = process.env.DATABASE_URL ?? "";

describe.skipIf(!url)("postgres", () => {
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
  });
});
