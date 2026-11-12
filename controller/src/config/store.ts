/**
 * The durable store location and adapter.
 *
 * `dbPath` is read before the adapter is chosen because the SQLite backup path
 * needs to know whether backups are configured (`parseStoreSelection` refuses
 * a SQLite backup directory under Postgres).
 */
import { parseStoreSelection } from "../store-selection.js";
import type { ControllerConfig } from "./types.js";

type StoreSettings = Pick<ControllerConfig, "dbPath" | "storeBackend" | "databaseUrl">;

export function parseStore(env: NodeJS.ProcessEnv, backupDir: string): StoreSettings {
  return {
    dbPath: env.DB_PATH ?? "/data/controller.db",
    ...parseStoreSelection(env, backupDir),
  };
}
