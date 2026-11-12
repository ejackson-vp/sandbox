/**
 * SQLite schema and migrations.
 *
 * Payment identity, the ledger and refund obligations are money: a version
 * bump must never recreate those tables. Migrations are additive and run in a
 * transaction, and a database from a newer build is refused rather than
 * silently downgraded.
 */
import type { DatabaseSync } from "node:sqlite";
import { NON_TERMINAL_STATE_SQL } from "./models.js";

export const SCHEMA_VERSION = 17;

/**
 * Due-time index. The due query filters on exactly the states in
 * `NON_TERMINAL_STATE_SQL` and orders by `next_due_ms`; a partial index over
 * those rows lets SQLite walk live sessions in due order and stop at `LIMIT`
 * without indexing (or visiting) terminal rows. The predicate is generated
 * from the same constant as the query so the two cannot drift.
 */
const DUE_INDEX = `
    CREATE INDEX IF NOT EXISTS sessions_due ON sessions(next_due_ms)
      WHERE state IN (${NON_TERMINAL_STATE_SQL});
`;

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
    requirements_json TEXT,
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
    settlement_nonce TEXT,
    refund_attempts INTEGER NOT NULL DEFAULT 0,
    refund_last_error TEXT,
    refund_next_attempt_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS payment_ledger_status ON payment_ledger(status);
    CREATE INDEX IF NOT EXISTS payment_ledger_session ON payment_ledger(session_id);
    CREATE INDEX IF NOT EXISTS payment_ledger_nonce ON payment_ledger(settlement_nonce);
    CREATE TABLE IF NOT EXISTS challenge_nonces (
    nonce TEXT PRIMARY KEY,
    payment_key TEXT,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    burned_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS challenge_nonces_expires ON challenge_nonces(expires_at);
    CREATE TABLE IF NOT EXISTS payer_budgets (
    budget_key TEXT PRIMARY KEY,
    window_start_ms INTEGER NOT NULL,
    creates INTEGER NOT NULL DEFAULT 0,
    spend TEXT NOT NULL DEFAULT '0',
    updated_at INTEGER NOT NULL
    );
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
    runtime TEXT NOT NULL DEFAULT 'base',
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
    next_due_ms INTEGER,
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
    payload_hash TEXT,
    result_envelope TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, id)
    );
    CREATE INDEX IF NOT EXISTS sessions_state ON sessions(state);
    -- Concurrency is counted from live sessions per verified payer. The ledger
    -- keeps the checksummed address, so the lookup is on the lowercased form.
    CREATE INDEX IF NOT EXISTS payment_ledger_payer ON payment_ledger(lower(payer));
    -- Double-charge guard: a client key pair may own at most one session (#31).
    CREATE INDEX IF NOT EXISTS sessions_client_key ON sessions(client_public_key, client_nonce);
    CREATE INDEX IF NOT EXISTS exec_requests_session ON exec_requests(session_id);
${DUE_INDEX}`;

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

/**
 * v10 -> v11: the reconcile loop becomes due-time driven. `next_due_ms` is the
 * earliest time a session needs another pass; NULL (pre-v11 rows and fresh
 * inserts) means "due immediately". Additive only: no session data is rewritten
 * and the existing sweep keeps working through `listNonTerminal`.
 */
function migrateV10toV11(db: DatabaseSync): void {
  db.exec("ALTER TABLE sessions ADD COLUMN next_due_ms INTEGER;");
  db.exec(DUE_INDEX);
}

/**
 * v11 -> v12: record the guest runtime profile on the session. Existing rows
 * were all base sessions, so the column defaults to `base`; no backfill is
 * needed and no money table is touched.
 */
function migrateV11toV12(db: DatabaseSync): void {
  db.exec("ALTER TABLE sessions ADD COLUMN runtime TEXT NOT NULL DEFAULT 'base';");
}

/**
 * v12 -> v13: single-use challenge nonces for the client commitment. A new
 * table only; no existing row is read or rewritten, so the money tables are
 * untouched. Pre-v13 clients have no nonce and must re-challenge (see
 * docs/security-guarantees.md and F-07).
 */
function migrateV12toV13(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS challenge_nonces (
    nonce TEXT PRIMARY KEY,
    payment_key TEXT,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    burned_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS challenge_nonces_expires ON challenge_nonces(expires_at);
  `);
}

/**
 * v13 -> v14: durable per-payer and global create budgets (#48). A new table and
 * one expression index; no money row is read or rewritten. An existing payer
 * starts with an empty window, which is the same state as a first create.
 */
function migrateV13toV14(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payer_budgets (
    budget_key TEXT PRIMARY KEY,
    window_start_ms INTEGER NOT NULL,
    creates INTEGER NOT NULL DEFAULT 0,
    spend TEXT NOT NULL DEFAULT '0',
    updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS payment_ledger_payer ON payment_ledger(lower(payer));
  `);
}

/**
 * v14 -> v15: settlement reconciliation and refund execution (#31).
 *
 * Additive columns only. `settlement_nonce` is the EIP-3009 authorisation nonce,
 * so a facilitator webhook or an operator can key a refund by it as well as by
 * the payment key. The `refund_*` columns are the retry state of the refund
 * worker. `payment_intents.requirements_json` records the payment requirements
 * at claim time, which is what lets settlement recovery write a correct ledger
 * row after the API has forgotten the request.
 */
function migrateV14toV15(db: DatabaseSync): void {
  db.exec("ALTER TABLE payment_ledger ADD COLUMN settlement_nonce TEXT;");
  db.exec("ALTER TABLE payment_ledger ADD COLUMN refund_attempts INTEGER NOT NULL DEFAULT 0;");
  db.exec("ALTER TABLE payment_ledger ADD COLUMN refund_last_error TEXT;");
  db.exec("ALTER TABLE payment_ledger ADD COLUMN refund_next_attempt_at INTEGER;");
  db.exec("CREATE INDEX IF NOT EXISTS payment_ledger_nonce ON payment_ledger(settlement_nonce);");
  db.exec("ALTER TABLE payment_intents ADD COLUMN requirements_json TEXT;");
  // The double-charge guard looks a session up by client key pair on the create
  // path, so it must not be a table scan.
  db.exec("CREATE INDEX IF NOT EXISTS sessions_client_key ON sessions(client_public_key, client_nonce);");
}

/**
 * v15 -> v16: bind the operation idempotency key to the request payload.
 *
 * `exec_requests.payload_hash` is the client's hash of the canonical operation,
 * or the SHA-256 of the sealed envelope when the client does not send one. A
 * retry of the same `requestId` with a different payload is refused instead of
 * returning the first operation's cached result. The column is nullable and
 * existing rows keep NULL, which means "written before this check existed" and
 * accepts any duplicate: the migration cannot verify a payload it never stored,
 * and refusing those retries would break in-flight requests across the upgrade.
 */
function migrateV15toV16(db: DatabaseSync): void {
  db.exec("ALTER TABLE exec_requests ADD COLUMN payload_hash TEXT;");
}

/**
 * v16 -> v17: keep the sealed result with its request row.
 *
 * The relay cache is 5 minutes and 64 entries per session, so a retry after
 * eviction used to find a completed request and no result. `result_envelope` is
 * the client-sealed ciphertext the guest produced: the controller stores it
 * without a key for it and cannot open it, and `finalizeTermination` clears it
 * when the session reaches a terminal state (the request row itself stays for
 * audit). Additive and nullable: existing rows keep NULL, which means "written
 * before results were persisted" and serves exactly what v16 served, a relay
 * lookup or `410 result_expired`.
 */
function migrateV16toV17(db: DatabaseSync): void {
  db.exec("ALTER TABLE exec_requests ADD COLUMN result_envelope TEXT;");
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
      if (version < 11) migrateV10toV11(db);
      if (version < 12) migrateV11toV12(db);
      if (version < 13) migrateV12toV13(db);
      if (version < 14) migrateV13toV14(db);
      if (version < 15) migrateV14toV15(db);
      if (version < 16) migrateV15toV16(db);
      if (version < 17) migrateV16toV17(db);
      // Future versions append `if (version < N) migrateV(N-1)toV(N)(db);`.
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
