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
import { NON_TERMINAL_STATE_SQL } from "../../controller/src/store/models.js";
import {
  DEFAULT_REDUE_INTERVAL_MS,
  Store,
  type PaymentRecord,
  type SessionRecord,
} from "../../controller/src/store.js";
import type { SessionLimits } from "../../shared/src/entries/protocol.js";

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
  runtime: string | null;
  columns: string[];
  requestColumns: string[];
  intentColumns: string[];
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
    const intentColumns = (db.prepare("PRAGMA table_info(payment_intents)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    const signer = columns.includes("client_signer")
      ? ((db.prepare("SELECT client_signer FROM sessions WHERE id='sbx_old'").get() as
          | { client_signer: string | null }
          | undefined)?.client_signer ?? null)
      : null;
    const runtime = columns.includes("runtime")
      ? ((db.prepare("SELECT runtime FROM sessions WHERE id='sbx_old'").get() as
          | { runtime: string | null }
          | undefined)?.runtime ?? null)
      : null;
    return {
      version: (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      payments: count("payments"),
      ledger: count("payment_ledger"),
      sessions: count("sessions"),
      intents: count("payment_intents"),
      signer,
      runtime,
      columns,
      requestColumns,
      intentColumns,
    };
  } finally {
    db.close();
  }
}

const limits: SessionLimits = {
  cpuMillis: 1000,
  memoryMiB: 1024,
  diskMiB: 1024,
  maxOutputBytes: 262144,
  maxFileBytes: 8 * 1024 * 1024,
  maxCommandSeconds: 300,
  maxProcesses: 256,
};

const NOW = Date.now();

function paymentRecord(key: string): PaymentRecord {
  return {
    paymentKey: key,
    network: "mock:local",
    scheme: "exact",
    asset: "mock:usdc",
    amount: "50000",
    payTo: "0x0000000000000000000000000000000000000402",
    payer: "0x0000000000000000000000000000000000000001",
    transaction: "mock:tx",
    mode: "mock",
  };
}

function sessionRecord(id: string, key: string): SessionRecord {
  return {
    id,
    capabilityHash: "a".repeat(64),
    capabilityExpiresAt: NOW + 3_600_000,
    // One client key pair per session: a repeated pair is a duplicate charge
    // and is refused by completeEntitlement (#31).
    clientPublicKey: `pk-${id}`,
    clientNonce: `nonce-${id}`,
    tier: "standard",
    durationSeconds: 300,
    limits,
    state: "PAID",
    createdAt: NOW,
    paidAt: NOW,
    readyAt: null,
    leaseExpiresAt: null,
    terminatingAt: null,
    destroyedAt: null,
    terminationReason: null,
    failureCode: null,
    failureMessage: null,
    attestationJson: null,
    guestPublicKey: null,
    paymentKey: key,
    podName: null,
    runtimeClass: "x402-sandbox",
    executionMode: "dev",
    relayTokenHash: "relay-token-hash",
    activeRequestId: null,
    execEpoch: 1,
    relayPurgedAt: null,
    destroyRequested: 0,
    timingsJson: null,
    idlePolicyJson: "{}",
    maxLifetimeSeconds: 28_800,
    suspendedAt: null,
    resumeCount: 0,
    lastActivityAt: null,
    workspacePvc: "pvc-1",
    baselineCpuMillis: null,
    baselineMemoryMib: null,
    nodeName: "node-1",
    updatedAt: NOW,
  };
}

function freshStore(): { store: Store; path: string } {
  const path = tempDb();
  return { store: new Store(path), path };
}

/** Claim then complete, as the API does. */
function seedPaid(store: Store, id: string, keyChar: string): void {
  const key = keyChar.repeat(64);
  const claim = store.claimPaymentIntent(key, "a".repeat(64), 30_000);
  if (claim.status !== "claimed") throw new Error("expected claim");
  store.completeEntitlement(key, claim.token, paymentRecord(key), sessionRecord(id, key));
}

/**
 * Read the schedule column directly. It is deliberately not part of
 * SessionRecord: the due-time mechanism is storage-level and the reconciler
 * task owns how it is consumed.
 */
function readNextDue(path: string, id: string): number | null {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare("SELECT next_due_ms FROM sessions WHERE id = ?").get(id) as
      | { next_due_ms: number | null }
      | undefined;
    return row ? row.next_due_ms : null;
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
    expect(after.columns).toContain("next_due_ms");
    expect(after.requestColumns).toContain("epoch");
    expect(after.intentColumns).toEqual(expect.arrayContaining(["claim_token", "claim_expires_at"]));

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
    expect(after.columns).toContain("next_due_ms");
    expect(after.requestColumns).toContain("epoch");
    expect(after.intentColumns).toEqual(expect.arrayContaining(["claim_token", "claim_expires_at"]));
  });
});

describe("due-time schedule", () => {
  it("adds next_due_ms to an existing database and keeps every row", () => {
    const path = tempDb();
    seedV7(path);

    const db = new DatabaseSync(path);
    migrate(db);
    db.close();

    const after = readBack(path);
    expect(after.version).toBe(SCHEMA_VERSION);
    expect(after.columns).toContain("next_due_ms");
    expect(after.payments).toBe(1);
    expect(after.ledger).toBe(1);
    expect(after.sessions).toBe(1);
    // A pre-v11 row is due immediately rather than rewritten by the migration.
    expect(readNextDue(path, "sbx_old")).toBeNull();
  });

  it("listDue returns only due live sessions, earliest first, bounded by the limit", () => {
    const { store, path } = freshStore();
    try {
      seedPaid(store, "sbx_due_a", "a");
      seedPaid(store, "sbx_due_b", "b");
      seedPaid(store, "sbx_due_c", "c");
      seedPaid(store, "sbx_due_d", "d");
      seedPaid(store, "sbx_due_terminal", "e");

      expect(store.bumpDue("sbx_due_a", 100)).toBe(true);
      expect(store.bumpDue("sbx_due_b", 50)).toBe(true);
      expect(store.bumpDue("sbx_due_d", 10_000)).toBe(true);
      // sbx_due_c is never scheduled: NULL is due immediately.

      expect(store.requestTermination("sbx_due_terminal", "client_destroy")).toBe(true);
      expect(store.finalizeTermination("sbx_due_terminal")).toBe("DESTROYED");
      // Even with the earliest deadline, a terminal row is never due.
      store.bumpDue("sbx_due_terminal", 0);

      expect(store.listDue(1_000, 10).map((session) => session.id)).toEqual([
        "sbx_due_c",
        "sbx_due_b",
        "sbx_due_a",
      ]);
      expect(store.listDue(1_000, 2).map((session) => session.id)).toEqual([
        "sbx_due_c",
        "sbx_due_b",
      ]);
      // NULL is always due; timestamped rows in the future are not.
      expect(store.listDue(-1, 10).map((session) => session.id)).toEqual(["sbx_due_c"]);
      expect(readNextDue(path, "sbx_due_c")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("refreshes next_due_ms on every state change", () => {
    const { store, path } = freshStore();
    try {
      const id = "sbx_walk";
      seedPaid(store, id, "f");
      // A freshly created session is due immediately.
      expect(readNextDue(path, id)).toBeNull();
      expect(store.listDue(Date.now(), 10).map((session) => session.id)).toContain(id);

      const refreshedBy = (label: string, step: () => void): void => {
        // Park the schedule in the past, then prove the transition moved it.
        expect(store.bumpDue(id, 1), label).toBe(true);
        step();
        const due = readNextDue(path, id);
        expect(due, label).not.toBeNull();
        expect(due!, label).toBeGreaterThan(1);
      };

      const before = Date.now();
      refreshedBy("provisioning", () => expect(store.setProvisioning(id, "pod-1")).toBe(true));
      expect(readNextDue(path, id)!).toBeGreaterThanOrEqual(before + DEFAULT_REDUE_INTERVAL_MS);

      store.setRelayToken(id, "relay-hash");
      const readyAt = Date.now();
      refreshedBy("ready", () =>
        expect(store.setReady(id, readyAt, readyAt + 60_000, "{}", "guest-pk")).toBe(true),
      );
      refreshedBy("operation started", () => {
        expect(store.claimOperation(id, "req-1", "exec").ok).toBe(true);
      });
      refreshedBy("operation finished", () => store.finishOperation(id, "req-1", "done"));
      refreshedBy("suspending", () => expect(store.markSuspending(id)).toBe(true));
      refreshedBy("suspended", () => expect(store.markSuspended(id, Date.now())).toBe(true));
      refreshedBy("resuming", () => expect(store.markResuming(id, "pod-2")).toBe(true));

      store.setRelayToken(id, "relay-hash-2");
      const resumedAt = Date.now();
      refreshedBy("resumed ready", () =>
        expect(store.setReady(id, resumedAt, resumedAt + 60_000, "{}", "guest-pk-2")).toBe(true),
      );
      refreshedBy("terminating", () =>
        expect(store.requestTermination(id, "client_destroy")).toBe(true),
      );
      refreshedBy("terminated", () => expect(store.finalizeTermination(id)).toBe("DESTROYED"));

      expect(store.listDue(Number.MAX_SAFE_INTEGER, 10).map((session) => session.id)).not.toContain(
        id,
      );
    } finally {
      store.close();
    }
  });

  it("serves the due query from the sessions_due partial index", () => {
    const path = tempDb();
    const db = new DatabaseSync(path);
    migrate(db);
    try {
      const indexSql = (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'sessions_due'")
          .get() as { sql: string } | undefined
      )?.sql;
      expect(indexSql).toContain(NON_TERMINAL_STATE_SQL);

      const plan = (
        db
          .prepare(
            `EXPLAIN QUERY PLAN SELECT id FROM sessions INDEXED BY sessions_due
             WHERE state IN (${NON_TERMINAL_STATE_SQL})
               AND (next_due_ms IS NULL OR next_due_ms <= ?)
             ORDER BY next_due_ms LIMIT ?`,
          )
          .all(1_000, 10) as Array<{ detail: string }>
      )
        .map((row) => row.detail)
        .join("\n");
      // The partial index serves both the state filter and the due order; if
      // the index and the query's state list drift, the hint stops resolving.
      expect(plan).toContain("sessions_due");
      expect(plan).not.toContain("TEMP B-TREE");
    } finally {
      db.close();
    }
  });
});
