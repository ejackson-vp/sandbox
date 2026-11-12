/**
 * Store readiness: migrations complete and the database still accepts a write.
 *
 * The write probe deliberately touches an existing, always-present table inside
 * a transaction that is rolled back. A read-only connection accepts
 * `BEGIN IMMEDIATE` but rejects the first write statement, so a lock-only probe
 * would report a read-only database as healthy.
 *
 * A standby replica blocks writes on purpose (leader election, docs/adr/0009).
 * Probing it would always fail, and a failed write probe must never leave the
 * `BEGIN IMMEDIATE` open: a leaked RESERVED lock would then block the writes it
 * inherits the moment it becomes the leader. So the caller states whether this
 * connection is meant to be writable.
 */
import type { DatabaseSync } from "node:sqlite";
import type { StoreHealth } from "./models.js";
import { SCHEMA_VERSION } from "./schema.js";

export type { StoreHealth };

const WRITE_PROBE = "UPDATE payments SET payment_key = payment_key WHERE 0";

export function checkStoreHealth(
  db: DatabaseSync,
  options: { writable?: boolean } = {},
): StoreHealth {
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

  if (options.writable === false) {
    // Migrated and readable, but this replica is not the writer.
    return { ok: false, reason: "read_only", schemaVersion: version };
  }

  try {
    // A probe must not wait behind a long write before Kubernetes gives up.
    db.exec("PRAGMA busy_timeout = 200");
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(WRITE_PROBE);
      } finally {
        // Roll back even on failure: an open transaction holds a RESERVED lock.
        db.exec("ROLLBACK");
      }
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
