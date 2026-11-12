/**
 * Postgres schema, the same tables and the same ladder as the SQLite migrations.
 *
 * The tables, columns, uniques and indexes are the SQLite ones (see
 * `controller/src/store/schema.ts`, schema v16). Two dialect differences are
 * deliberate and are called out where they occur:
 *
 *   - epoch milliseconds are `BIGINT`, because 2026 is past `int4`'s ceiling.
 *     The pool decodes int8 as a number (`postgres/pg.ts`), so records map
 *     identically to the SQLite adapter's;
 *   - `sessions_due` is declared `NULLS FIRST`, matching SQLite's ordering, so
 *     `listDue` can use the index without a sort. Postgres sorts NULLs last by
 *     default, which would starve every never-scheduled row.
 *
 * Versioning is one row in `sandbox_schema`, not a `PRAGMA`. A database from a
 * newer build is refused, and a database with no version row is treated as v0
 * and migrated forward: the ladder is additive and idempotent, so replaying a
 * step cannot corrupt a money table.
 */
import type { Tx } from "./pg.js";
import { SCHEMA_VERSION } from "../schema.js";

/** DDL statements are applied under one transaction-scoped advisory lock. */
const MIGRATION_LOCK_KEY = 8_402_000;

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS payments (
  payment_key TEXT PRIMARY KEY,
  network TEXT NOT NULL,
  scheme TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  payer TEXT,
  tx TEXT,
  mode TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_intents (
  payment_key TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  session_id TEXT,
  spec_hash TEXT NOT NULL,
  reason TEXT,
  claim_token TEXT,
  claim_expires_at BIGINT,
  requirements_json TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_ledger (
  payment_key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  payer TEXT,
  amount TEXT NOT NULL,
  asset TEXT NOT NULL,
  network TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  refund_tx TEXT,
  settlement_nonce TEXT,
  refund_attempts INTEGER NOT NULL DEFAULT 0,
  refund_last_error TEXT,
  refund_next_attempt_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS payment_ledger_status ON payment_ledger(status);
CREATE INDEX IF NOT EXISTS payment_ledger_session ON payment_ledger(session_id);
CREATE INDEX IF NOT EXISTS payment_ledger_nonce ON payment_ledger(settlement_nonce);
CREATE TABLE IF NOT EXISTS challenge_nonces (
  nonce TEXT PRIMARY KEY,
  payment_key TEXT,
  issued_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  burned_at BIGINT
);
CREATE INDEX IF NOT EXISTS challenge_nonces_expires ON challenge_nonces(expires_at);
CREATE TABLE IF NOT EXISTS payer_budgets (
  budget_key TEXT PRIMARY KEY,
  window_start_ms BIGINT NOT NULL,
  creates INTEGER NOT NULL DEFAULT 0,
  spend TEXT NOT NULL DEFAULT '0',
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  capability_hash TEXT NOT NULL,
  capability_expires_at BIGINT NOT NULL,
  client_public_key TEXT NOT NULL,
  client_nonce TEXT NOT NULL,
  client_signer TEXT,
  tier TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  cpu_millis INTEGER NOT NULL,
  memory_mib INTEGER NOT NULL,
  disk_mib INTEGER NOT NULL,
  max_output_bytes INTEGER NOT NULL,
  max_file_bytes INTEGER NOT NULL,
  max_command_seconds INTEGER NOT NULL,
  max_processes INTEGER NOT NULL,
  state TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  paid_at BIGINT,
  ready_at BIGINT,
  lease_expires_at BIGINT,
  terminating_at BIGINT,
  destroyed_at BIGINT,
  termination_reason TEXT,
  failure_code TEXT,
  failure_message TEXT,
  attestation_json TEXT,
  guest_public_key TEXT,
  payment_key TEXT NOT NULL UNIQUE REFERENCES payments(payment_key),
  pod_name TEXT,
  runtime_class TEXT,
  execution_mode TEXT,
  runtime TEXT NOT NULL DEFAULT 'base',
  relay_token_hash TEXT,
  active_request_id TEXT,
  exec_epoch INTEGER NOT NULL DEFAULT 1,
  relay_purged_at BIGINT,
  destroy_requested INTEGER NOT NULL DEFAULT 0,
  timings_json TEXT,
  idle_policy_json TEXT,
  max_lifetime_seconds INTEGER,
  suspended_at BIGINT,
  resume_count INTEGER NOT NULL DEFAULT 0,
  last_activity_at BIGINT,
  workspace_pvc TEXT,
  baseline_cpu_millis INTEGER,
  baseline_memory_mib INTEGER,
  node_name TEXT,
  next_due_ms BIGINT,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  payment_key TEXT UNIQUE,
  session_id TEXT UNIQUE,
  warm_id TEXT UNIQUE,
  spec_hash TEXT,
  node_id TEXT NOT NULL,
  pod_name TEXT,
  state TEXT NOT NULL,
  baseline_cpu_millis INTEGER NOT NULL,
  baseline_memory_bytes BIGINT NOT NULL,
  baseline_storage_bytes BIGINT NOT NULL,
  peak_cpu_millis INTEGER NOT NULL,
  peak_memory_bytes BIGINT NOT NULL,
  peak_storage_bytes BIGINT NOT NULL,
  expires_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS reservations_state ON reservations(state);
CREATE INDEX IF NOT EXISTS reservations_node ON reservations(node_id);
CREATE TABLE IF NOT EXISTS exec_requests (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  op TEXT NOT NULL,
  state TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 1,
  payload_hash TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (session_id, id)
);
CREATE INDEX IF NOT EXISTS sessions_state ON sessions(state);
CREATE INDEX IF NOT EXISTS payment_ledger_payer ON payment_ledger(lower(payer));
CREATE INDEX IF NOT EXISTS sessions_client_key ON sessions(client_public_key, client_nonce);
CREATE INDEX IF NOT EXISTS exec_requests_session ON exec_requests(session_id);
`;

/**
 * The due index is created separately because the predicate is built from the
 * same constant as the query it serves.
 */
function dueIndexSql(nonTerminalStatesSql: string): string {
  return `CREATE INDEX IF NOT EXISTS sessions_due ON sessions(next_due_ms NULLS FIRST)
    WHERE state IN (${nonTerminalStatesSql});`;
}

/** Additive steps, mirroring `migrateV7toV8` … `migrateV14toV15` in SQLite. */
const LADDER: ReadonlyArray<{ from: number; sql: string }> = [
  { from: 8, sql: "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS client_signer TEXT;" },
  {
    from: 9,
    sql: `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS exec_epoch INTEGER NOT NULL DEFAULT 1;
          ALTER TABLE exec_requests ADD COLUMN IF NOT EXISTS epoch INTEGER NOT NULL DEFAULT 1;`,
  },
  {
    from: 10,
    sql: `ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS claim_token TEXT;
          ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS claim_expires_at BIGINT;`,
  },
  { from: 11, sql: "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS next_due_ms BIGINT;" },
  {
    from: 12,
    sql: "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS runtime TEXT NOT NULL DEFAULT 'base';",
  },
  {
    from: 13,
    sql: `CREATE TABLE IF NOT EXISTS challenge_nonces (
            nonce TEXT PRIMARY KEY, payment_key TEXT, issued_at BIGINT NOT NULL,
            expires_at BIGINT NOT NULL, burned_at BIGINT);
          CREATE INDEX IF NOT EXISTS challenge_nonces_expires ON challenge_nonces(expires_at);`,
  },
  {
    from: 14,
    sql: `CREATE TABLE IF NOT EXISTS payer_budgets (
            budget_key TEXT PRIMARY KEY, window_start_ms BIGINT NOT NULL,
            creates INTEGER NOT NULL DEFAULT 0, spend TEXT NOT NULL DEFAULT '0',
            updated_at BIGINT NOT NULL);
          CREATE INDEX IF NOT EXISTS payment_ledger_payer ON payment_ledger(lower(payer));`,
  },
  {
    from: 15,
    sql: `ALTER TABLE payment_ledger ADD COLUMN IF NOT EXISTS settlement_nonce TEXT;
          ALTER TABLE payment_ledger ADD COLUMN IF NOT EXISTS refund_attempts INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE payment_ledger ADD COLUMN IF NOT EXISTS refund_last_error TEXT;
          ALTER TABLE payment_ledger ADD COLUMN IF NOT EXISTS refund_next_attempt_at BIGINT;
          CREATE INDEX IF NOT EXISTS payment_ledger_nonce ON payment_ledger(settlement_nonce);
          ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS requirements_json TEXT;
          CREATE INDEX IF NOT EXISTS sessions_client_key ON sessions(client_public_key, client_nonce);`,
  },
  {
    from: 16,
    sql: "ALTER TABLE exec_requests ADD COLUMN IF NOT EXISTS payload_hash TEXT;",
  },
];

interface MigrationResult {
  from: number;
  to: number;
}

/**
 * Apply the ladder. Requires the writer lock: a standby must never migrate.
 */
export async function migratePostgres(
  tx: Tx,
  nonTerminalStateSql: string,
): Promise<MigrationResult> {
  await tx.serialise(MIGRATION_LOCK_KEY);
  await tx.query("CREATE TABLE IF NOT EXISTS sandbox_schema (version INTEGER NOT NULL)");
  const current = await tx.query<{ version: number }>("SELECT version FROM sandbox_schema LIMIT 1");
  const from = current.rows[0]?.version ?? 0;

  if (from > SCHEMA_VERSION) {
    throw new Error(
      `postgres schema v${from} is newer than this build (v${SCHEMA_VERSION}); refusing to downgrade`,
    );
  }
  if (from === SCHEMA_VERSION) return { from, to: from };

  if (from === 0) {
    await tx.query(BASE_SCHEMA);
    await tx.query(dueIndexSql(nonTerminalStateSql));
  } else {
    for (const step of LADDER) {
      if (from < step.from) await tx.query(step.sql);
    }
    await tx.query(dueIndexSql(nonTerminalStateSql));
  }

  if (from === 0) {
    await tx.query("INSERT INTO sandbox_schema (version) VALUES ($1)", [SCHEMA_VERSION]);
  } else {
    await tx.query("UPDATE sandbox_schema SET version = $1", [SCHEMA_VERSION]);
  }
  return { from, to: SCHEMA_VERSION };
}
