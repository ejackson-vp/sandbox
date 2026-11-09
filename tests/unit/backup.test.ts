import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import {
  BackupService,
  decryptFile,
  encryptFile,
  restoreBackup,
  verifyDatabase,
} from "../../controller/src/backup.js";
import { parseBackupKey } from "../../controller/src/backup-key.js";
import { loadControllerConfig } from "../../controller/src/config.js";
import { Store } from "../../controller/src/store.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "x402-backup-"));
  dirs.push(dir);
  return dir;
}

function seedDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE payments (payment_key TEXT PRIMARY KEY);
    CREATE TABLE payment_ledger (payment_key TEXT PRIMARY KEY);
    CREATE TABLE payment_intents (payment_key TEXT PRIMARY KEY);
  `);
  db.prepare("INSERT INTO sessions (id) VALUES (?)").run("sbx_backup");
  db.prepare("INSERT INTO payments (payment_key) VALUES (?)").run("pay_backup");
  db.prepare("INSERT INTO payment_ledger (payment_key) VALUES (?)").run("pay_backup");
  db.prepare("INSERT INTO payment_intents (payment_key) VALUES (?)").run("pay_backup");
  return db;
}

describe("backup key parsing", () => {
  it("accepts 32 bytes as hex and base64", () => {
    const raw = randomBytes(32);
    expect(parseBackupKey(raw.toString("hex"))).toEqual(raw);
    expect(parseBackupKey(raw.toString("base64"))).toEqual(raw);
  });

  it("rejects the wrong length and empty keys", () => {
    expect(() => parseBackupKey("short")).toThrow(/32 bytes/);
    expect(() => parseBackupKey("   ")).toThrow(/empty/);
  });
});

describe("backup configuration", () => {
  const base: NodeJS.ProcessEnv = {
    ADMIN_TOKEN: "a".repeat(24),
    RELAY_ADMIN_TOKEN: "r".repeat(24),
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "p".repeat(24),
    EXECUTION_MODE: "dev",
    ALLOW_INSECURE_DEV: "true",
  };

  it("is disabled by default", () => {
    const cfg = loadControllerConfig(base);
    expect(cfg.backupDir).toBe("");
    expect(cfg.backupKey).toBeNull();
  });

  it("requires an encryption key when a backup directory is set", () => {
    expect(() => loadControllerConfig({ ...base, BACKUP_DIR: "/backups" })).toThrow(
      /BACKUP_ENCRYPTION_KEY/,
    );
  });

  it("parses the key and interval when enabled", () => {
    const cfg = loadControllerConfig({
      ...base,
      BACKUP_DIR: "/backups",
      BACKUP_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      BACKUP_INTERVAL_MS: "3600000",
      BACKUP_RETENTION: "7",
    });
    expect(cfg.backupDir).toBe("/backups");
    expect(cfg.backupKey).toHaveLength(32);
    expect(cfg.backupIntervalMs).toBe(3_600_000);
    expect(cfg.backupRetention).toBe(7);
  });

  it("ignores backup settings outside the controller role", () => {
    const cfg = loadControllerConfig({ ...base, ROLE: "relay", BACKUP_DIR: "/backups" });
    expect(cfg.backupDir).toBe("");
    expect(cfg.backupKey).toBeNull();
  });
});

describe("backup encryption", () => {
  it("round-trips a file and rejects a wrong key", async () => {
    const dir = tempDir();
    const src = join(dir, "source.bin");
    const enc = join(dir, "source.enc");
    const out = join(dir, "out.bin");
    const plain = randomBytes(256 * 1024);
    writeFileSync(src, plain);
    const key = randomBytes(32);

    await encryptFile(src, enc, key);
    await decryptFile(enc, out, key);
    expect(readFileSync(out)).toEqual(plain);

    const wrong = join(dir, "wrong.bin");
    await expect(decryptFile(enc, wrong, randomBytes(32))).rejects.toThrow();
    expect(existsSync(wrong)).toBe(false);
  });

  it("rejects a truncated backup", async () => {
    const dir = tempDir();
    const src = join(dir, "source.bin");
    const enc = join(dir, "source.enc");
    const truncated = join(dir, "truncated.enc");
    writeFileSync(src, randomBytes(1024));
    const key = randomBytes(32);

    await encryptFile(src, enc, key);
    writeFileSync(truncated, readFileSync(enc).subarray(0, 20));
    await expect(decryptFile(truncated, join(dir, "out.bin"), key)).rejects.toThrow(/truncated/);
  });
});

describe("BackupService", () => {
  it("writes a verified encrypted backup and prunes to retention", async () => {
    const dir = tempDir();
    const source = join(dir, "source.db");
    const db = seedDatabase(source);
    const key = randomBytes(32);
    let now = 1_700_000_000_000;
    const service = new BackupService({
      store: {
        async backupTo(path: string) {
          copyFileSync(source, path);
        },
      },
      dir: join(dir, "backups"),
      key,
      intervalMs: 1_000,
      retention: 2,
      now: () => now,
    });

    await service.run(now);
    now += 1_000;
    await service.run(now);
    now += 1_000;
    await service.run(now);

    const files = readdirSync(join(dir, "backups")).filter((f) => f.endsWith(".db.enc")).sort();
    expect(files).toHaveLength(2);

    const restored = join(dir, "restored.db");
    await decryptFile(join(dir, "backups", files[1]!), restored, key);
    expect(verifyDatabase(restored, { paymentKey: "pay_backup" })).toEqual({
      sessions: 1,
      payments: 1,
      paymentLedger: 1,
      paymentIntents: 1,
    });
    db.close();
  });

  it("is a no-op when backups are disabled", async () => {
    const dir = tempDir();
    const service = new BackupService({
      store: {
        async backupTo() {
          throw new Error("should not be called");
        },
      },
      dir: "",
      key: null,
      intervalMs: 1_000,
      retention: 1,
    });
    await service.maybeRun();
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

describe("restore", () => {
  it("restores an encrypted backup and checks a known payment", async () => {
    const dir = tempDir();
    const source = join(dir, "source.db");
    const db = seedDatabase(source);
    const key = randomBytes(32);
    const plain = join(dir, "copy.db");
    const enc = join(dir, "copy.db.enc");
    await sqliteBackup(db, plain);
    await encryptFile(plain, enc, key);

    const target = join(dir, "target.db");
    const counts = await restoreBackup(enc, target, key, { paymentKey: "pay_backup" });
    expect(counts).toEqual({
      sessions: 1,
      payments: 1,
      paymentLedger: 1,
      paymentIntents: 1,
    });
    expect(existsSync(target)).toBe(true);

    await expect(restoreBackup(enc, target, key)).rejects.toThrow(/without --force/);
    db.close();
  });

  it("keeps the previous database when forced", async () => {
    const dir = tempDir();
    const source = join(dir, "source.db");
    const db = seedDatabase(source);
    const key = randomBytes(32);
    const plain = join(dir, "copy.db");
    const enc = join(dir, "copy.db.enc");
    await sqliteBackup(db, plain);
    await encryptFile(plain, enc, key);

    const target = join(dir, "target.db");
    await restoreBackup(enc, target, key);
    const counts = await restoreBackup(enc, target, key, { force: true });
    expect(counts.payments).toBe(1);
    expect(readdirSync(dir).some((name) => name.startsWith("target.db.pre-restore-"))).toBe(true);
    db.close();
  });

  it("refuses to restore over a WAL sidecar", async () => {
    const dir = tempDir();
    const enc = join(dir, "copy.db.enc");
    const source = join(dir, "source.db");
    const db = seedDatabase(source);
    const key = randomBytes(32);
    const plain = join(dir, "copy.db");
    await sqliteBackup(db, plain);
    await encryptFile(plain, enc, key);
    writeFileSync(`${join(dir, "target.db")}-wal`, "not a wal");
    await expect(restoreBackup(enc, join(dir, "target.db"), key)).rejects.toThrow(/wal/);
    db.close();
  });
});

describe("Store online backup", () => {
  it("produces a readable copy while the store is open", async () => {
    const dir = tempDir();
    const store = new Store(join(dir, "controller.db"));
    const copy = join(dir, "copy.db");
    await store.backupTo(copy);
    expect(verifyDatabase(copy)).toEqual({
      sessions: 0,
      payments: 0,
      paymentLedger: 0,
      paymentIntents: 0,
    });
    store.close();
  });
});
