/**
 * Store-backend selection, parsed before anything is opened.
 *
 * Kept out of `config.ts` so that file stays reviewable, and kept free of the
 * adapter imports so a relay or proxy process can parse the same config without
 * loading a Postgres client.
 *
 * Fails closed in both directions: selecting Postgres without a URL must never
 * fall back to SQLite, and the scheduled backup path is SQLite-only until the
 * `pg_dump` branch ADR 0010 describes exists. A backup that silently backed up
 * nothing would be worse than a startup error.
 */
type StoreBackendName = "sqlite" | "postgres";

interface StoreSelection {
  storeBackend: StoreBackendName;
  databaseUrl: string | null;
}

export function parseStoreSelection(env: NodeJS.ProcessEnv, backupDir: string): StoreSelection {
  const raw = env.STORE_BACKEND ?? "sqlite";
  if (raw !== "sqlite" && raw !== "postgres") {
    throw new Error(`invalid STORE_BACKEND ${raw}; expected sqlite or postgres`);
  }
  const databaseUrl = env.DATABASE_URL?.trim() || null;
  if (raw === "postgres" && !databaseUrl) {
    throw new Error("STORE_BACKEND=postgres requires DATABASE_URL");
  }
  if (raw === "postgres" && backupDir) {
    throw new Error(
      "BACKUP_DIR is not supported with STORE_BACKEND=postgres; take a pg_dump instead (docs/adr/0010)",
    );
  }
  return { storeBackend: raw, databaseUrl };
}
