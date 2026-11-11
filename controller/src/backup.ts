/**
 * Online, encrypted SQLite backups.
 *
 * SQLite's native backup API copies a consistent database while the controller
 * keeps writing. The copy is verified (integrity + table counts), encrypted with
 * AES-256-GCM in a streaming pass, and written to a separate volume. Backups are
 * bounded by count, not by disk pressure; the retention policy is deliberate.
 *
 * This is not point-in-time recovery: the RPO is the backup interval. The
 * restore path is a separate CLI so it can run after the controller is stopped.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { log, metrics } from "@x402s/shared/runtime";

const MAGIC = Buffer.from("X402BK1\n");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + IV_BYTES;
const CHUNK_BYTES = 64 * 1024;

export interface BackupCounts {
  sessions: number;
  payments: number;
  paymentLedger: number;
  paymentIntents: number;
}

export interface VerifyOptions {
  /** Assert that this payment and its ledger row survived the backup. */
  paymentKey?: string;
}

export interface BackupStore {
  backupTo(path: string): Promise<void>;
}

export interface BackupServiceOptions {
  store: BackupStore;
  dir: string;
  key: Buffer | null;
  intervalMs: number;
  retention: number;
  now?: () => number;
}

async function writeAll(handle: FileHandle, buf: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buf.length) {
    const { bytesWritten } = await handle.write(buf, offset, buf.length - offset);
    if (bytesWritten === 0) throw new Error("short write");
    offset += bytesWritten;
  }
}

/** Encrypt a file; on failure no partial destination is left behind. */
export async function encryptFile(src: string, dest: string, key: Buffer): Promise<void> {
  const input = await open(src, "r");
  let output: FileHandle | null = null;
  try {
    output = await open(dest, "w", 0o600);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    await writeAll(output, MAGIC);
    await writeAll(output, iv);

    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = 0;
    for (;;) {
      const { bytesRead } = await input.read(buf, 0, buf.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const chunk = cipher.update(buf.subarray(0, bytesRead));
      if (chunk.length > 0) await writeAll(output, chunk);
    }
    const final = cipher.final();
    if (final.length > 0) await writeAll(output, final);
    await writeAll(output, cipher.getAuthTag());
  } catch (err) {
    await output?.close().catch(() => undefined);
    await input.close().catch(() => undefined);
    rmSync(dest, { force: true });
    throw err;
  } finally {
    await output?.close().catch(() => undefined);
    await input.close().catch(() => undefined);
  }
}

/** Decrypt and authenticate a backup. A bad key or tag throws. */
export async function decryptFile(src: string, dest: string, key: Buffer): Promise<void> {
  const size = statSync(src).size;
  if (size < HEADER_BYTES + TAG_BYTES) {
    throw new Error("backup file is truncated");
  }
  const input = await open(src, "r");
  let output: FileHandle | null = null;
  try {
    output = await open(dest, "w", 0o600);
    const header = Buffer.alloc(HEADER_BYTES);
    if ((await input.read(header, 0, HEADER_BYTES, 0)).bytesRead !== HEADER_BYTES) {
      throw new Error("backup file is truncated");
    }
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error("not an x402 backup");
    }
    const tag = Buffer.alloc(TAG_BYTES);
    if ((await input.read(tag, 0, TAG_BYTES, size - TAG_BYTES)).bytesRead !== TAG_BYTES) {
      throw new Error("backup file is truncated");
    }

    const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(MAGIC.length));
    decipher.setAuthTag(tag);
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    const end = size - TAG_BYTES;
    let position = HEADER_BYTES;
    while (position < end) {
      const length = Math.min(CHUNK_BYTES, end - position);
      const { bytesRead } = await input.read(buf, 0, length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const chunk = decipher.update(buf.subarray(0, bytesRead));
      if (chunk.length > 0) await writeAll(output, chunk);
    }
    const final = decipher.final();
    if (final.length > 0) await writeAll(output, final);
  } catch (err) {
    await output?.close().catch(() => undefined);
    await input.close().catch(() => undefined);
    rmSync(dest, { force: true });
    throw err;
  } finally {
    await output?.close().catch(() => undefined);
    await input.close().catch(() => undefined);
  }
}

/** Integrity and row-count check used before publishing and before restoring. */
export function verifyDatabase(path: string, opts: VerifyOptions = {}): BackupCounts {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get() as
      | { integrity_check?: string }
      | undefined;
    if (integrity?.integrity_check !== "ok") {
      throw new Error(`backup integrity_check failed: ${integrity?.integrity_check ?? "unknown"}`);
    }
    const count = (table: string): number => {
      const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as
        | { n?: number }
        | undefined;
      return Number(row?.n ?? 0);
    };
    if (opts.paymentKey) {
      const payment = db.prepare("SELECT 1 AS present FROM payments WHERE payment_key = ?").get(
        opts.paymentKey,
      );
      const ledger = db.prepare(
        "SELECT 1 AS present FROM payment_ledger WHERE payment_key = ?",
      ).get(opts.paymentKey);
      if (!payment || !ledger) {
        throw new Error(`expected payment ${opts.paymentKey} is missing from the backup`);
      }
    }
    return {
      sessions: count("sessions"),
      payments: count("payments"),
      paymentLedger: count("payment_ledger"),
      paymentIntents: count("payment_intents"),
    };
  } finally {
    db.close();
  }
}

export class BackupService {
  private readonly now: () => number;
  private lastAttemptAt: number;
  private lastSuccessAt: number | null;
  private running = false;

  constructor(private readonly opts: BackupServiceOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.lastSuccessAt = this.newestBackupAt();
    this.lastAttemptAt = this.lastSuccessAt ?? 0;
    this.removeTemps();
  }

  /** Call from the housekeeping loop; it is a no-op when backups are disabled. */
  async maybeRun(): Promise<void> {
    if (!this.opts.dir || !this.opts.key) return;
    const now = this.now();
    this.publishAge(now);
    if (this.running || now - this.lastAttemptAt < this.opts.intervalMs) return;
    this.lastAttemptAt = now;
    this.running = true;
    try {
      await this.run(now);
    } catch (err) {
      log.error("backup_failed", { error: (err as Error).message });
    } finally {
      this.running = false;
    }
  }

  /** One backup attempt. Exposed for tests and a future manual trigger. */
  async run(now = this.now()): Promise<void> {
    const { dir, key } = this.opts;
    if (!dir || !key) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
    const tmp = join(dir, `.tmp-${stamp}-${process.pid}.db`);
    const encryptedTmp = join(dir, `.tmp-${stamp}-${process.pid}.enc`);
    const dest = join(dir, `${stamp}.db.enc`);
    try {
      await this.opts.store.backupTo(tmp);
      const counts = verifyDatabase(tmp);
      await encryptFile(tmp, encryptedTmp, key);
      renameSync(encryptedTmp, dest);
      rmSync(tmp, { force: true });
      this.lastSuccessAt = now;
      this.prune();
      const bytes = statSync(dest).size;
      metrics.gauge("sandbox_backup_age_seconds", "Seconds since the last successful backup").set({}, 0);
      metrics
        .gauge("sandbox_backup_last_success_timestamp_seconds", "Unix time of the last successful backup")
        .set({}, Math.floor(now / 1000));
      metrics.gauge("sandbox_backup_size_bytes", "Size of the newest encrypted backup").set({}, bytes);
      log.info("backup_completed", { file: basename(dest), counts, bytes });
    } catch (err) {
      rmSync(tmp, { force: true });
      rmSync(encryptedTmp, { force: true });
      metrics
        .counter("sandbox_backup_failures_total", "Backup attempts that failed")
        .inc({ reason: "backup" });
      throw err;
    }
  }

  private publishAge(now: number): void {
    const age =
      this.lastSuccessAt === null
        ? Number.MAX_SAFE_INTEGER
        : Math.max(0, (now - this.lastSuccessAt) / 1000);
    metrics.gauge("sandbox_backup_age_seconds", "Seconds since the last successful backup").set({}, age);
  }

  private newestBackupAt(): number | null {
    if (!this.opts.dir) return null;
    try {
      const files = readdirSync(this.opts.dir)
        .filter((name) => name.endsWith(".db.enc"))
        .sort();
      const newest = files.at(-1);
      if (!newest) return null;
      return Math.min(statSync(join(this.opts.dir, newest)).mtimeMs, this.now());
    } catch {
      return null;
    }
  }

  private removeTemps(): void {
    if (!this.opts.dir) return;
    try {
      for (const name of readdirSync(this.opts.dir)) {
        if (name.startsWith(".tmp-")) rmSync(join(this.opts.dir, name), { force: true });
      }
    } catch {
      /* the directory does not exist yet */
    }
  }

  private prune(): void {
    try {
      const files = readdirSync(this.opts.dir)
        .filter((name) => name.endsWith(".db.enc"))
        .sort();
      const excess = Math.max(0, files.length - this.opts.retention);
      for (const name of files.slice(0, excess)) {
        rmSync(join(this.opts.dir, name), { force: true });
      }
    } catch (err) {
      log.warn("backup_prune_failed", { error: (err as Error).message });
    }
  }
}

export interface RestoreOptions extends VerifyOptions {
  force?: boolean;
}

/**
 * Decrypt, verify and install a backup. The controller must be stopped; a WAL
 * or SHM file next to the target database is refused rather than overwritten.
 */
export async function restoreBackup(
  backupPath: string,
  dbPath: string,
  key: Buffer,
  opts: RestoreOptions = {},
): Promise<BackupCounts> {
  if (!existsSync(backupPath)) {
    throw new Error(`backup does not exist: ${backupPath}`);
  }
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${dbPath}${suffix}`)) {
      throw new Error(
        `refusing to restore while ${dbPath}${suffix} exists; stop the controller first`,
      );
    }
  }
  if (existsSync(dbPath) && !opts.force) {
    throw new Error(`refusing to overwrite ${dbPath} without --force`);
  }

  const temp = `${dbPath}.restore-${process.pid}-${Date.now()}`;
  let previous: string | null = null;
  try {
    await decryptFile(backupPath, temp, key);
    const counts = verifyDatabase(temp, opts);
    if (existsSync(dbPath)) {
      previous = `${dbPath}.pre-restore-${Date.now()}`;
      renameSync(dbPath, previous);
    }
    renameSync(temp, dbPath);
    return counts;
  } catch (err) {
    rmSync(temp, { force: true });
    if (previous && !existsSync(dbPath) && existsSync(previous)) {
      renameSync(previous, dbPath);
    }
    throw err;
  }
}
