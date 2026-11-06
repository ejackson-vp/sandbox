/**
 * SQLite schema. Destructive migration is deliberate: session state is
 * disposable in this prototype, so a version bump recreates the database.
 */
import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 6;

export function migrate(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");
  db.exec("PRAGMA busy_timeout = 5000;");

  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined)
    ?.user_version ?? 0;
  if (version !== SCHEMA_VERSION) {
    db.exec(`
    DROP TABLE IF EXISTS exec_requests;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS payment_intents;
    DROP TABLE IF EXISTS payments;
    `);
  }

  db.exec(`
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
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    capability_hash TEXT NOT NULL,
    capability_expires_at INTEGER NOT NULL,
    client_public_key TEXT NOT NULL,
    client_nonce TEXT NOT NULL,
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
    CREATE TABLE IF NOT EXISTS exec_requests (
    id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    op TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, id)
    );
    CREATE INDEX IF NOT EXISTS sessions_state ON sessions(state);
    CREATE INDEX IF NOT EXISTS exec_requests_session ON exec_requests(session_id);
  `);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
