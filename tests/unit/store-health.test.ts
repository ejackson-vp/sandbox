/**
 * Store readiness verdicts.
 *
 * The probe asks three questions in order and answers with one `StoreHealth`
 * type. The live cases run against the real test database; the scripted cases
 * pin the reason mapping without needing a broken server.
 */
import { describe, expect, it } from "vitest";
import type { StoreHealth } from "../../controller/src/store/models.js";
import { checkPostgresHealth } from "../../controller/src/store/postgres/health.js";
import type { PgConnection } from "../../controller/src/store/postgres/pg.js";
import { SCHEMA_VERSION } from "../../controller/src/store/schema.js";
import { freshStore } from "../helpers/test-store.js";

/** Stand-in for the pool: the health probe only ever calls `query`. */
function probe(answer: (sql: string) => Promise<unknown>): PgConnection {
  return { query: answer } as unknown as PgConnection;
}

function migrated(sql: string): Promise<unknown> {
  if (/sandbox_schema/.test(sql)) return Promise.resolve({ rows: [{ version: SCHEMA_VERSION }] });
  return Promise.resolve({ rows: [] });
}

describe("postgres store health, live", () => {
  it("reports the migrated version and goes read_only when the writer role is surrendered", async () => {
    const store = await freshStore();
    const health: StoreHealth = await store.healthCheck();
    expect(health).toEqual({ ok: true, schemaVersion: SCHEMA_VERSION });

    await store.setWritesBlocked(true);
    expect(await store.healthCheck()).toMatchObject({ ok: false, reason: "read_only" });
    // Hand it back so the next file's writer is not blocked on this pool.
    await store.setWritesBlocked(false);
  });

  it("reports a closed store instead of throwing", async () => {
    const store = await freshStore();
    await store.close();
    const health: StoreHealth = await store.healthCheck();
    expect(health).toMatchObject({ ok: false });
  });
});

describe("postgres store health", () => {
  it("answers with the shared StoreHealth shape", async () => {
    const health: StoreHealth = await checkPostgresHealth(probe(migrated));
    expect(health).toEqual({ ok: true, schemaVersion: SCHEMA_VERSION });
  });

  it("calls a stale schema incomplete and carries the version it found", async () => {
    const health = await checkPostgresHealth(
      probe(async (sql) =>
        /sandbox_schema/.test(sql) ? { rows: [{ version: SCHEMA_VERSION + 1 }] } : { rows: [] },
      ),
    );
    expect(health).toEqual({
      ok: false,
      reason: "migrations_incomplete",
      schemaVersion: SCHEMA_VERSION + 1,
    });
  });

  it("treats a missing schema table as not migrated yet", async () => {
    const health = await checkPostgresHealth(
      probe(async () => {
        throw Object.assign(new Error('relation "sandbox_schema" does not exist'), { code: "42P01" });
      }),
    );
    expect(health).toEqual({ ok: false, reason: "migrations_incomplete", schemaVersion: 0 });
  });

  it.each([
    ["Connection terminated unexpectedly", "closed"],
    ["getaddrinfo ENOTFOUND db", "unavailable"],
  ])("maps %s on the version read to %s", async (message, reason) => {
    const health = await checkPostgresHealth(
      probe(async () => {
        throw new Error(message);
      }),
    );
    expect(health).toMatchObject({ ok: false, reason });
  });

  it("does not probe writes on a standby", async () => {
    const statements: string[] = [];
    const health = await checkPostgresHealth(
      probe(async (sql) => {
        statements.push(sql);
        return migrated(sql);
      }),
      { writable: false },
    );
    expect(health).toMatchObject({ ok: false, reason: "read_only", schemaVersion: SCHEMA_VERSION });
    expect(statements).toHaveLength(1);
  });

  it.each([
    ["cannot execute UPDATE in a read-only transaction", "read_only"],
    ["deadlock detected", "locked"],
    ["connection reset by peer", "write_failed"],
  ])("maps %s on the write probe to %s", async (message, reason) => {
    const health = await checkPostgresHealth(
      probe(async (sql) => {
        if (/sandbox_schema/.test(sql)) return { rows: [{ version: SCHEMA_VERSION }] };
        throw new Error(message);
      }),
    );
    expect(health).toMatchObject({ ok: false, reason, schemaVersion: SCHEMA_VERSION });
  });
});
