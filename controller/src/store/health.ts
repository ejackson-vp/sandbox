/**
 * Store readiness: migrations complete and the database still accepts a write.
 *
 * The write probe deliberately touches an existing, always-present table inside
 * a transaction that is rolled back. A read-only connection accepts
 * `BEGIN IMMEDIATE` but rejects the first write statement, so a lock-only probe
 * would report a read-only database as healthy.
 */
import type { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION } from "./schema.js";

export type StoreHealth =
  | { ok: true; schemaVersion: number }
  | {
      ok: false;
      reason: "unavailable" | "closed" | "migrations_incomplete" | "read_only" | "locked" | "write_failed";
      schemaVersion?: number;
    };

const WRITE_PROBE = "UPDATE payments SET payment_key = payment_key WHERE 0";

export function checkStoreHealth(db: DatabaseSync): StoreHealth {
  let version: number;
  try {
    version =
      (db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)?.user_version ?? 0;
  } catch (err) {
    const message = String((err as Error)?.message ?? "");
    return {
      ok: false,
      reason: /closed|not open/i.test(message) ? "closed" : "unavailable",
    };
  }

  if (version !== SCHEMA_VERSION) {
    return { ok: false, reason: "migrations_incomplete", schemaVersion: version };
  }

  try {
    // A probe must not wait behind a long write before Kubernetes gives up.
    db.exec("PRAGMA busy_timeout = 200");
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec(WRITE_PROBE);
      db.exec("ROLLBACK");
    } finally {
      try {
        db.exec("PRAGMA busy_timeout = 5000");
      } catch {
        // The connection is already unusable; the failure above is the answer.
      }
    }
    return { ok: true, schemaVersion: version };
  } catch (err) {
    const message = String((err as Error)?.message ?? "");
    const reason = /readonly|read-only/i.test(message)
      ? "read_only"
      : /locked|busy/i.test(message)
        ? "locked"
        : "write_failed";
    return { ok: false, reason, schemaVersion: version };
  }
}
