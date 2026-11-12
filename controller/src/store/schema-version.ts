/**
 * The store schema version.
 *
 * Postgres is the only backend, so this is the version of the ladder in
 * `store/postgres/schema.ts`. It used to live next to the SQLite migrations;
 * it stays in its own module because the readiness probe reads it without
 * needing the DDL, and a version bump is a deliberate edit in one place.
 *
 * Payment identity, the ledger and refund obligations are money: a bump must
 * never recreate those tables. The ladder is additive and idempotent, and a
 * database from a newer build is refused rather than silently downgraded.
 */
export const SCHEMA_VERSION = 18;
