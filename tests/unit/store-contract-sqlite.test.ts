/**
 * The store contract, over SQLite.
 *
 * Runs in the normal unit job. The Postgres half is the same suite in
 * `store-contract-postgres.test.ts`, skipped unless `DATABASE_URL` is set.
 */
import { sqliteBackend } from "./store-contract/fixtures.js";
import { describeStoreContract } from "./store-contract/suite.js";

describeStoreContract(sqliteBackend());
