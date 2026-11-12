/**
 * Vitest global setup: fail fast when Postgres is not reachable.
 *
 * The suite has no SQLite fallback any more, so a missing server should be one
 * clear message at the start rather than thirty connection-refused failures.
 * The run id is fixed here so every worker names its databases with the same
 * prefix, and the teardown can drop exactly this run's leftovers.
 */
import pg from "pg";
import teardown from "./test-global-teardown.js";

/** Vitest has one global setup hook; returning a function is its teardown. */
export default async function setup(): Promise<() => Promise<void>> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "DATABASE_URL is required for the test suite. Start Postgres and export the connection " +
        "string, for example: DATABASE_URL=postgres://postgres:pg@127.0.0.1:55432/sandbox",
    );
  }

  const described = (() => {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.username ? `${parsed.username}@` : ""}${parsed.host}${parsed.pathname}`;
    } catch {
      return "(unparseable DATABASE_URL)";
    }
  })();

  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await client.query("SELECT 1");
  } catch (err) {
    throw new Error(
      `Postgres is not reachable at ${described}: ${(err as Error).message}. ` +
        "The test suite requires a running Postgres whose user can create databases.",
    );
  } finally {
    await client.end().catch(() => undefined);
  }

  process.env.SBX_TEST_RUN_ID = String(process.pid);
  return teardown;
}
