/**
 * SQLite scrape-time gauges. Refreshed on scrape instead of on a timer so the
 * number matches the file the scraper just asked about.
 */
import { metrics, type MetricsRegistry } from "@x402s/shared/runtime";
import type { MetricsStore } from "./store/ports.js";

export function registerSqliteMetrics(registry: MetricsRegistry = metrics): void {
  registry.gauge("sandbox_sqlite_size_bytes", "Main SQLite database file size");
  registry.gauge("sandbox_sqlite_wal_bytes", "SQLite WAL sidecar file size");
  registry.counter("sandbox_sqlite_busy_retries_total", "SQLite operations retried after SQLITE_BUSY");
}

export function collectSqliteMetrics(store: MetricsStore, registry: MetricsRegistry = metrics): void {
  const stats = store.stats();
  registry.gauge("sandbox_sqlite_size_bytes", "Main SQLite database file size").set({}, stats.sizeBytes);
  registry.gauge("sandbox_sqlite_wal_bytes", "SQLite WAL sidecar file size").set({}, stats.walBytes);
}
