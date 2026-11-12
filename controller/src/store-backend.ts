/**
 * Backend selection for the store ports.
 *
 * The composition root is the only place that knows which adapter is in use.
 * Everything above it holds the narrow ports, so the choice is one call here and
 * one config field.
 *
 * `STORE_BACKEND` defaults to `sqlite`, which keeps `make dev-local` and every
 * existing test on the file-backed adapter. `postgres` requires `DATABASE_URL`
 * (validated in `store-selection.ts`, so the process refuses to start rather than falling
 * back). The `writer` argument is the leadership decision: a replica that does
 * not hold the lease opens read-only, and on Postgres that means it does not
 * take the advisory lock and does not migrate.
 */
import type { ControllerConfig } from "./config.js";
import type { StoreBackend } from "./store/backend.js";
import { Store } from "./store.js";
import { PostgresStore } from "./store/postgres/store.js";

export async function openStore(
  cfg: ControllerConfig,
  options: { writer: boolean },
): Promise<StoreBackend> {
  if (cfg.storeBackend === "postgres") {
    // `parseStoreSelection` refuses postgres without DATABASE_URL, so a parsed
    // config always has one here.
    return PostgresStore.open(cfg.databaseUrl!, {
      writer: options.writer,
      budgetWindowMs: cfg.budgetWindowMs,
    });
  }
  const store = new Store(cfg.dbPath, { budgetWindowMs: cfg.budgetWindowMs });
  // Idempotent: `Store` is writable out of the box, which is correct for the
  // solo case and closed immediately for a lease standby.
  await store.setWritesBlocked(!options.writer);
  return store;
}
