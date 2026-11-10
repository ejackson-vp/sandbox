/**
 * SQLite schema and migrations.
 *
 * Payment identity, the ledger and refund obligations are money: a version
 * bump must never recreate those tables. Migrations are additive and run in a
 * transaction, and a database from a newer build is refused rather than
 * silently downgraded.
 */
import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 10;

/** Tables created for a brand-new database (always the current shape). */
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
    created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payment_intents (
    payment_key TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    session_id TEXT,
    spec_hash TEXT NOT NULL,
    reason TEXT,
    claim_token TEXT,
    claim_expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
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
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS payment_ledger_status ON payment_ledger(status);
    CREATE INDEX IF NOT EXISTS payment_ledger_session ON payment_ledger(session_id);
    CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    capability_hash TEXT NOT NULL,
    capability_expires_at INTEGER NOT NULL,
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
    created_at INTEGER NOT NULL,
    paid_at INTEGER,
    ready_at INTEGER,
    lease_expires_at INTEGER,
    terminating_at INTEGER,
    destroyed_at INTEGER,
    termination_reason TEXT,
    failure_code TEXT,
    failure_message TEXT,
    attestation_json TEXT,
    guest_public_key TEXT,
    payment_key TEXT NOT NULL UNIQUE REFERENCES payments(payment_key),
    pod_name TEXT,
    runtime_class TEXT,
    execution_mode TEXT,
    relay_token_hash TEXT,
    active_request_id TEXT,
    exec_epoch INTEGER NOT NULL DEFAULT 1,
    relay_purged_at INTEGER,
    destroy_requested INTEGER NOT NULL DEFAULT 0,
    timings_json TEXT,
    idle_policy_json TEXT,
    max_lifetime_seconds INTEGER,
    suspended_at INTEGER,
    resume_count INTEGER NOT NULL DEFAULT 0,
    last_activity_at INTEGER,
    workspace_pvc TEXT,
    baseline_cpu_millis INTEGER,
    baseline_memory_mib INTEGER,
    node_name TEXT,
    updated_at INTEGER NOT NULL
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
    baseline_memory_bytes INTEGER NOT NULL,
    baseline_storage_bytes INTEGER NOT NULL,
    peak_cpu_millis INTEGER NOT NULL,
    peak_memory_bytes INTEGER NOT NULL,
    peak_storage_bytes INTEGER NOT NULL,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reservations_state ON reservations(state);
    CREATE INDEX IF NOT EXISTS reservations_node ON reservations(node_id);
    CREATE TABLE IF NOT EXISTS exec_requests (
    id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    op TEXT NOT NULL,
    state TEXT NOT NULL,
    epoch INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, id)
    );
    CREATE INDEX IF NOT EXISTS sessions_state ON sessions(state);
    CREATE INDEX IF NOT EXISTS exec_requests_session ON exec_requests(session_id);
`;

/**
 * v7 -> v8: record the wallet that signed the client commitment. Additive only;
 * payments, ledger and sessions are untouched.
 */
function migrateV7toV8(db: DatabaseSync): void {
  db.exec("ALTER TABLE sessions ADD COLUMN client_signer TEXT;");
}

/**
 * v8 -> v9: execution epochs fence restart recovery. Existing sessions start at
 * epoch 1 and existing requests are tagged with epoch 1; a controller restart
 * bumps the session epoch so frames from the previous generation are rejected.
 */
function migrateV8toV9(db: DatabaseSync): void {
  db.exec("ALTER TABLE sessions ADD COLUMN exec_epoch INTEGER NOT NULL DEFAULT 1;");
  db.exec("ALTER TABLE exec_requests ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1;");
}

/**
 * v9 -> v10: payment-intent claims carry an owner token and a lease deadline.
 * Completion must present the current token, so a worker that stalled past its
 * lease cannot settle after another worker reclaims the intent. Additive only;
 * existing intents have no token and can only be recovered through `staleMs`.
 */
function migrateV9toV10(db: DatabaseSync): void {
  db.exec("ALTER TABLE payment_intents ADD COLUMN claim_token TEXT;");
  db.exec("ALTER TABLE payment_intents ADD COLUMN claim_expires_at INTEGER;");
}

export function migrate(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");
  db.exec("PRAGMA busy_timeout = 5000;");

  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined)
    ?.user_version ?? 0;

  if (version > SCHEMA_VERSION) {
    throw new Error(
      `database schema v${version} is newer than this build (v${SCHEMA_VERSION}); refusing to downgrade`,
    );
  }
  if (version === SCHEMA_VERSION) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    if (version === 0) {
      db.exec(BASE_SCHEMA);
    } else {
      if (version < 8) migrateV7toV8(db);
      if (version < 9) migrateV8toV9(db);
      if (version < 10) migrateV9toV10(db);
      // Future versions append `if (version < N) migrateV(N-1)toV(N)(db);`.
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
