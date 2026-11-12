/**
 * The durable store location.
 *
 * Postgres is the only backend, so the controller requires `DATABASE_URL` and
 * there is no fallback to a local file. A controller that cannot say where its
 * state lives must not start: the error names the variable, because that is the
 * one thing an operator can fix.
 *
 * Only the roles that open the store are asked for it. A relay or a proxy writes
 * nothing to the database and their Deployments do not mount the database
 * Secret, so the field is left empty there rather than failing their startup.
 * The same gate applies to the retired SQLite settings: they are only refused on
 * a role that would have used them.
 */
import type { Role } from "./role.js";
import type { ControllerConfig } from "./types.js";

type StoreSettings = Pick<ControllerConfig, "databaseUrl">;

export function parseStore(env: NodeJS.ProcessEnv, role: Role): StoreSettings {
  if (role !== "controller" && role !== "all") return { databaseUrl: "" };

  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required: the controller stores all state in Postgres and has no SQLite backend",
    );
  }
  // A leftover selection from the two-backend days is refused rather than
  // ignored, so an operator who still sets it finds out at startup instead of
  // wondering which store the process opened.
  const selected = env.STORE_BACKEND?.trim();
  if (selected && selected !== "postgres") {
    throw new Error(
      `STORE_BACKEND=${selected} is no longer supported; SQLite was removed and the controller always uses Postgres from DATABASE_URL`,
    );
  }
  // The encrypted backup path was SQLite-only (it copied the database file), so
  // it went with the adapter. A configured directory is refused rather than
  // ignored: a scheduled backup that silently does nothing is worse than a
  // startup error. Postgres deployments take a pg_dump instead.
  if (env.BACKUP_DIR?.trim()) {
    throw new Error(
      "BACKUP_DIR is no longer supported: the encrypted backup path was SQLite-only; take a pg_dump of the Postgres database instead (docs/adr/0010)",
    );
  }
  return { databaseUrl };
}
