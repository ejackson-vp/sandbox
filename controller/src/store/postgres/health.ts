/**
 * Readiness for the Postgres adapter.
 *
 * Same three questions the SQLite probe asks, in the same order, so a probe
 * result means the same thing whichever backend is configured: is the schema
 * current, is this process the writer, and does the server accept a write. The
 * write probe is a no-op UPDATE, not a `SELECT`, because a read-only replica
 * answers a `SELECT` happily and only rejects the write.
 */
import { SCHEMA_VERSION } from "../schema.js";
import type { PgConnection } from "./pg.js";

export type StoreHealth =
  | { ok: true; schemaVersion: number }
  | {
      ok: false;
      reason: "unavailable" | "closed" | "migrations_incomplete" | "read_only" | "locked" | "write_failed";
      schemaVersion?: number;
    };

const WRITE_PROBE = "UPDATE payments SET payment_key = payment_key WHERE false";

export async function checkPostgresHealth(
  conn: PgConnection,
  options: { writable?: boolean } = {},
): Promise<StoreHealth> {
  let version: number | null;
  try {
    const res = await conn.query<{ version: number }>("SELECT version FROM sandbox_schema LIMIT 1");
    version = res.rows[0]?.version ?? 0;
  } catch (err) {
    const message = String((err as Error)?.message ?? "");
    return {
      ok: false,
      reason: /terminat|closed|ended/i.test(message) ? "closed" : "unavailable",
    };
  }

  if (version !== SCHEMA_VERSION) {
    return { ok: false, reason: "migrations_incomplete", schemaVersion: version ?? 0 };
  }
  if (options.writable === false) {
    return { ok: false, reason: "read_only", schemaVersion: version };
  }

  try {
    // Deliberately not `conn.write`: the probe measures the server, not our own
    // writer-lock flag, so a standby that has been unblocked still learns that
    // the database is read-only.
    await conn.query(WRITE_PROBE);
    return { ok: true, schemaVersion: version };
  } catch (err) {
    const message = String((err as Error)?.message ?? "");
    const reason = /read-only|readonly|cannot execute/i.test(message)
      ? "read_only"
      : /deadlock|locked|timeout/i.test(message)
        ? "locked"
        : "write_failed";
    return { ok: false, reason, schemaVersion: version };
  }
}
