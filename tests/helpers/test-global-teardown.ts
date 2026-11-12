/**
 * Vitest global teardown: drop the databases this run created.
 *
 * Vitest runs one setup and one teardown in the main process, while the
 * databases live in forked workers. The run id in the database name is what
 * bridges the two: a concurrent run has a different id and is left alone.
 */
import { dropTestDb, runId } from "./test-store.js";

export default async function teardown(): Promise<void> {
  await dropTestDb(runId());
}
