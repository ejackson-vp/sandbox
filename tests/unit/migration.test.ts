/**
 * Schema migrations must never destroy money. These tests build a v7 database
 * with settled payments, ledger rows and sessions, then migrate it.
 */
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, SCHEMA_VERSION } from "../../controller/src/store/schema.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "x402-schema-"));
  dirs.push(dir);
  return join(dir, "controller.db");
}

/** The v7 shape: everything current except `sessions.client_signer`. */
const V7 = `
  CREATE TABLE payments (
    payment_key TEXT PRIMARY KEY, network TEXT NOT NULL, scheme TEXT NOT NULL,
    asset TEXT NOT NULL, amount TEXT NOT NULL, pay_to TEXT NOT NULL, payer TEXT,
    tx TEXT, mode TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE payment_intents (
    payment_key TEXT PRIMARY KEY, status TEXT NOT NULL, session_id TEXT,
    spec_hash TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE payment_ledger (
    payment_key TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, payer TEXT,
    amount TEXT NOT NULL, asset TEXT NOT NULL, network TEXT NOT NULL, mode TEXT NOT NULL,
    status TEXT NOT NULL, reason TEXT, refund_tx TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, capability_hash TEXT NOT NULL, capability_expires_at INTEGER NOT NULL,
    client_public_key TEXT NOT NULL, client_nonce TEXT NOT NULL, tier TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL, cpu_millis INTEGER NOT NULL, memory_mib INTEGER NOT NULL,
    disk_mib INTEGER NOT NULL, max_output_bytes INTEGER NOT NULL, max_file_bytes INTEGER NOT NULL,
    max_command_seconds INTEGER NOT NULL, max_processes INTEGER NOT NULL, state TEXT NOT NULL,
    created_at INTEGER NOT NULL, paid_at INTEGER, ready_at INTEGER, lease_expires_at INTEGER,
    terminating_at INTEGER, destroyed_at INTEGER, termination_reason TEXT, failure_code TEXT,
    failure_message TEXT, attestation_json TEXT, guest_public_key TEXT,
    payment_key TEXT NOT NULL UNIQUE REFERENCES payments(payment_key), pod_name TEXT,
    runtime_class TEXT, execution_mode TEXT, relay_token_hash TEXT, active_request_id TEXT,
    relay_purged_at INTEGER, destroy_requested INTEGER NOT NULL DEFAULT 0, timings_json TEXT,
    idle_policy_json TEXT, max_lifetime_seconds INTEGER, suspended_at INTEGER,
    resume_count INTEGER NOT NULL DEFAULT 0, last_activity_at INTEGER, workspace_pvc TEXT,
    baseline_cpu_millis INTEGER, baseline_memory_mib INTEGER, node_name TEXT, updated_at INTEGER NOT NULL
  );
  CREATE TABLE reservations (
    id TEXT PRIMARY KEY, payment_key TEXT UNIQUE, session_id TEXT UNIQUE, warm_id TEXT UNIQUE,
    spec_hash TEXT, node_id TEXT NOT NULL, pod_name TEXT, state TEXT NOT NULL,
    baseline_cpu_millis INTEGER NOT NULL, baseline_memory_bytes INTEGER NOT NULL,
    baseline_storage_bytes INTEGER NOT NULL, peak_cpu_millis INTEGER NOT NULL,
    peak_memory_bytes INTEGER NOT NULL, peak_storage_bytes INTEGER NOT NULL, expires_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE exec_requests (
    id TEXT NOT NULL, session_id TEXT NOT NULL, op TEXT NOT NULL, state TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (session_id, id)
  );
  PRAGMA user_version = 7;
`;

function seedV7(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(V7);
  db.prepare(
    `INSERT INTO payments VALUES ('${"k".repeat(64)}','mock:local','exact','mock:usdc','50000',
       '0x0000000000000000000000000000000000000402','0xabc','mock:tx','mock',1)`,
  ).run();
  db.prepare(
    `INSERT INTO payment_intents VALUES ('${"k".repeat(64)}','settled','sbx_old','${"s".repeat(64)}',NULL,1,2)`,
  ).run();
  db.prepare(
    `INSERT INTO payment_ledger VALUES ('${"k".repeat(64)}','sbx_old','0xabc','50000','mock:usdc',
       'mock:local','mock','SETTLED',NULL,NULL,1,2)`,
  ).run();
  db.prepare(
    `INSERT INTO sessions (id, capability_hash, capability_expires_at, client_public_key,
       client_nonce, tier, duration_seconds, cpu_millis, memory_mib, disk_mib, max_output_bytes,
       max_file_bytes, max_command_seconds, max_processes, state, created_at, payment_key, updated_at)
     VALUES ('sbx_old','${"c".repeat(64)}',9999999999,'pk','nonce','short',60,500,512,256,262144,
       8388608,60,256,'PAID',1,'${"k".repeat(64)}',2)`,
  ).run();
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.close();
}

function readBack(path: string): {
  version: number;
  payments: number;
  ledger: number;
  sessions: number;
  intents: number;
  signer: string | null;
  columns: string[];
  requestColumns: string[];
} {
  const db = new DatabaseSync(path);
  try {
    const count = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const columns = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    const requestColumns = (db.prepare("PRAGMA table_info(exec_requests)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    const signer = columns.includes("client_signer")
      ? ((db.prepare("SELECT client_signer FROM sessions WHERE id='sbx_old'").get() as
          | { client_signer: string | null }
          | undefined)?.client_signer ?? null)
      : null;
    return {
      version: (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      payments: count("payments"),
      ledger: count("payment_ledger"),
      sessions: count("sessions"),
      intents: count("payment_intents"),
      signer,
      columns,
      requestColumns,
    };
  } finally {
    db.close();
  }
}

describe("schema migration", () => {
  it("upgrades v7 additively and preserves payments, ledger and sessions", () => {
    const path = tempDb();
    seedV7(path);
    const db = new DatabaseSync(path);
    migrate(db);
    db.close();

    const after = readBack(path);
    expect(after.version).toBe(SCHEMA_VERSION);
    expect(after.payments).toBe(1);
    expect(after.ledger).toBe(1);
    expect(after.sessions).toBe(1);
    expect(after.intents).toBe(1);
    expect(after.signer).toBeNull();
    expect(after.columns).toContain("client_signer");
    expect(after.columns).toContain("exec_epoch");
    expect(after.requestColumns).toContain("epoch");

    // Replay prevention survives the upgrade: the payment key is still unique.
    const again = new DatabaseSync(path);
    expect(() =>
      again
        .prepare(
          `INSERT INTO payments VALUES ('${"k".repeat(64)}','mock:local','exact','mock:usdc','50000',
             '0x0000000000000000000000000000000000000402','0xabc','mock:tx','mock',1)`,
        )
        .run(),
    ).toThrow(/UNIQUE|PRIMARY KEY/);
    again.close();
  });

  it("survives a backup/restore round trip", () => {
    const path = tempDb();
    seedV7(path);
    const backup = `${path}.bak`;
    copyFileSync(path, backup);

    const db = new DatabaseSync(path);
    migrate(db);
    db.close();

    const restored = readBack(backup);
    expect(restored.version).toBe(7);
    const db2 = new DatabaseSync(backup);
    migrate(db2);
    db2.close();
    const after = readBack(backup);
    expect(after.version).toBe(SCHEMA_VERSION);
    expect(after.payments).toBe(1);
    expect(after.ledger).toBe(1);
  });

  it("refuses to open a database from a newer build", () => {
    const path = tempDb();
    seedV7(path);
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version = 999;");
    expect(() => migrate(db)).toThrow(/refusing to downgrade/);
    db.close();

    // The data is untouched.
    expect(readBack(path).payments).toBe(1);
    expect(readBack(path).version).toBe(999);
  });

  it("rolls back a partially applied migration", () => {
    const path = tempDb();
    seedV7(path);
    const db = new DatabaseSync(path);
    // Simulate a previous attempt that added the column but crashed before
    // bumping the version: the ALTER now fails and the transaction rolls back.
    db.exec("ALTER TABLE sessions ADD COLUMN client_signer TEXT;");
    expect(() => migrate(db)).toThrow(/duplicate column/i);
    db.close();

    const after = readBack(path);
    expect(after.version).toBe(7);
    expect(after.payments).toBe(1);
    expect(after.ledger).toBe(1);
    expect(after.sessions).toBe(1);
  });

  it("creates the current schema on a fresh database", () => {
    const path = tempDb();
    const db = new DatabaseSync(path);
    migrate(db);
    db.close();
    const after = readBack(path);
    expect(after.version).toBe(SCHEMA_VERSION);
    expect(after.columns).toContain("client_signer");
    expect(after.columns).toContain("exec_epoch");
    expect(after.requestColumns).toContain("epoch");
  });
});
