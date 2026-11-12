/**
 * Opens the store.
 *
 * The composition root is the only place that knows which adapter is in use.
 * Everything above it holds the narrow ports, so this is one call and no
 * branching: Postgres is the only backend.
 *
 * `DATABASE_URL` is required and `parseStore` refuses a config without it, so a
 * process that reaches this function has a URL. The `writer` argument is the
 * leadership decision: a replica that does not hold the lease opens read-only,
 * and on Postgres that means it takes no advisory lock and migrates nothing.
 */
import type { ControllerConfig } from "./config.js";
import type { StoreBackend } from "./store/backend.js";
import { PostgresStore } from "./store/postgres/store.js";

export async function openStore(
  cfg: ControllerConfig,
  options: { writer: boolean },
): Promise<StoreBackend> {
  return PostgresStore.open(cfg.databaseUrl, {
    writer: options.writer,
    budgetWindowMs: cfg.budgetWindowMs,
  });
}
