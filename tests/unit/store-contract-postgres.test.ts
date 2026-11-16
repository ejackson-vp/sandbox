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
import { NON_TERMINAL_STATES, TERMINAL_STATES } from "@x402s/shared/protocol";
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

describe("derived schema", () => {
  /**
   * The `sessions_due` predicate is generated from `SESSION_STATES`, and
   * `CREATE INDEX IF NOT EXISTS` will happily leave an older predicate in place.
   * A database that predates a state therefore keeps an index that does not
   * cover the due query for that state, which is a full scan of `sessions` on
   * every reconcile pass. Opening the store has to reconcile it.
   */
  it("rebuilds the due index when its predicate no longer matches the vocabulary", async () => {
    const url = testDatabaseUrl("unit-index");
    await ensureTestDatabase("unit-index");
    // First open creates and migrates the database, and with it the correct index.
    await (await PostgresStore.open(url, { writer: true })).close();

    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      // Stand in for a database written under an older vocabulary.
      await client.query("DROP INDEX sessions_due");
      await client.query(
        "CREATE INDEX sessions_due ON sessions(next_due_ms NULLS FIRST) WHERE state IN ('PAID')",
      );

      const reopened = await PostgresStore.open(url, { writer: true });
      await reopened.close();

      const res = await client.query<{ definition: string }>(
        "SELECT pg_get_indexdef(to_regclass('sessions_due')) AS definition",
      );
      const definition = res.rows[0]!.definition;
      for (const state of NON_TERMINAL_STATES) expect(definition).toContain(`'${state}'`);
      for (const state of TERMINAL_STATES) expect(definition).not.toContain(`'${state}'`);
    } finally {
      await client.end();
    }
  });
});
