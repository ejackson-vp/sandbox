#!/usr/bin/env node
/**
 * Restore a backup artifact and run the store contract against it.
 *
 *   node scripts/restore-dump.mjs postgres-20261112T032300Z.dump.enc
 *   make test-restore-dump DUMP=postgres-20261112T032300Z.dump.enc
 *
 * The homelab CronJob (`homelab/apps/sandbox/postgres-backup.yaml`) writes
 * `pg_dump -Fc | openssl enc -aes-256-cbc -pbkdf2` and then counts rows from
 * `sessions` in a scratch database. That proves the artifact decompresses; it
 * does not prove the payment, session, operation or reservation invariants
 * survived. This restores the artifact into a database it creates, fingerprints
 * every money and session table against the database the dump came from, and
 * runs the same suite `npm run test:store-contract` runs, against that copy.
 * The data check runs before the contract, never after: the contract truncates
 * every table, so afterwards there are no rows left to compare.
 *
 * `DATABASE_URL` is the admin connection. The database it names is never
 * written to: this creates its own `sbx_restore_<stamp>_<pid>_<random>`,
 * which cannot collide with a real database or a parallel run, drops it on
 * success, on failure and on SIGINT/SIGTERM, and needs `pg_restore` (and
 * `openssl` when the dump is encrypted) on PATH. That database is also the
 * default comparison source, read only, in a read-only session.
 *
 * The contract suite truncates every table, which is why it must never see the
 * database an operator pointed this at. `scripts/restore-verify.mjs` holds the
 * comparison.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { usableSource, verifyData } from "./restore-verify.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRATCH_PREFIX = "sbx_restore_";
const DEFAULT_KEY_ENV = "BACKUP_ENCRYPTION_KEY";
const OPENSSL_MAGIC = "Salted__";

const USAGE = `usage: node scripts/restore-dump.mjs <dump> [options]

Restore a pg_dump -Fc artifact (optionally openssl-encrypted) into a scratch
database, check that its rows match the database the dump came from, and run
the store contract against that copy.

options:
  --key-env NAME        environment variable holding the openssl passphrase
                        (default: ${DEFAULT_KEY_ENV})
  --database-url URL    admin connection (default: DATABASE_URL)
  --compare-url URL     database to compare the restored rows with
                        (default: the database in --database-url, read only)
  --no-compare          skip the row comparison; the artifact is then only
                        proved to restore a schema
  --keep                leave the scratch database in place for inspection
  -h, --help            print this text

environment:
  DATABASE_URL          admin connection; its database is never written to
  ${DEFAULT_KEY_ENV}    passphrase; the key is read here, never from argv

exit codes: 0 contract passed, 1 restore, comparison or contract failed, 2 usage error.`;

/** An argument problem, which exits 2 rather than reporting a failed restore. */
export class UsageError extends Error {}

export function parseArgs(argv) {
  const options = {
    dump: null,
    keyEnv: DEFAULT_KEY_ENV,
    databaseUrl: null,
    compareUrl: null,
    compare: true,
    keep: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--keep") {
      options.keep = true;
    } else if (arg === "--no-compare") {
      options.compare = false;
    } else if (arg === "--key-env" || arg === "--database-url" || arg === "--compare-url") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new UsageError(`${arg} needs a value`);
      }
      if (arg === "--key-env") options.keyEnv = value;
      else if (arg === "--compare-url") options.compareUrl = value;
      else options.databaseUrl = value;
      index += 1;
    } else if (arg.startsWith("-") && arg !== "-") {
      throw new UsageError(`unknown option ${arg}`);
    } else if (options.dump !== null) {
      throw new UsageError(`expected one dump path, got '${arg}' too`);
    } else {
      options.dump = arg;
    }
  }

  return options;
}

/**
 * A scratch name no real database can have.
 *
 * Postgres identifiers stop at 63 bytes; this is 43 at its longest. Lower case
 * only, so an unquoted reference cannot fold into a different name.
 */
export function scratchDatabaseName(
  now = new Date(),
  pid = process.pid,
  random = randomBytes(4).toString("hex"),
) {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "t");
  return `${SCRATCH_PREFIX}${stamp}_${pid}_${random}`;
}

/** `pg_dump -Fc` starts with `PGDMP`; openssl writes a `Salted__` header. */
export function dumpLooksEncrypted(head) {
  return head.length >= 8 && head.subarray(0, 8).toString("latin1") === OPENSSL_MAGIC;
}

/**
 * What the schema ladder will do to the restored copy, from the version row
 * the dump carries.
 *
 * `controller/src/store/postgres/schema.ts` refuses a database newer than the
 * build (`from > SCHEMA_VERSION`) and replays the additive ladder for anything
 * older, including a database with no version row (`from = 0`). The contract
 * fixture opens a writer store in `reset()`, so the ladder runs on the copy
 * before the first assertion.
 */
export function schemaPlan(dumpVersion, buildVersion) {
  if (buildVersion === null) {
    return {
      action: "unknown",
      message: "could not read SCHEMA_VERSION from controller/src/store/schema-version.ts",
    };
  }
  if (dumpVersion === null) {
    return {
      action: "unversioned",
      message: `the dump has no sandbox_schema row, so the ladder treats it as v0 and builds it up to v${buildVersion}`,
    };
  }
  if (dumpVersion > buildVersion) {
    return {
      action: "refuse",
      message:
        `the dump is at schema v${dumpVersion} and this checkout is v${buildVersion}. ` +
        "The store refuses to downgrade a newer database, so the controller would not start on it either. " +
        "Restore with the build that wrote the dump, or take a newer dump.",
    };
  }
  if (dumpVersion === buildVersion) {
    return { action: "current", message: `the dump is at schema v${buildVersion}, this checkout's version` };
  }
  return {
    action: "migrate",
    message:
      `the dump is at schema v${dumpVersion} and this checkout is v${buildVersion}. ` +
      `The contract opens a writer on the copy, so the ladder migrates it to v${buildVersion} before the first test. ` +
      "The steps are additive and idempotent, so existing rows survive, but the suite sees the migrated schema, not the one the dump was written with.",
  };
}

/** The build's schema version, read from the module the controller reads. */
export function buildSchemaVersion(root = ROOT) {
  try {
    const source = readFileSync(join(root, "controller/src/store/schema-version.ts"), "utf8");
    const match = /export const SCHEMA_VERSION\s*=\s*(\d+)/.exec(source);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** The database name in a connection string, without leaking the password. */
export function databaseNameOf(connectionString) {
  const url = new URL(connectionString);
  return decodeURIComponent(url.pathname.replace(/^\/+/, "")) || "postgres";
}

function described(connectionString) {
  const url = new URL(connectionString);
  return `${url.protocol}//${url.username ? `${url.username}@` : ""}${url.host}${url.pathname}`;
}

function scratchUrlFor(adminUrl, name) {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function firstBytes(path, count) {
  const buffer = Buffer.alloc(count);
  const descriptor = openSync(path, "r");
  try {
    const read = readSync(descriptor, buffer, 0, count, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(descriptor);
  }
}

function printable(bytes) {
  if (bytes === 0) return "0 B";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function tail(text, lines = 12) {
  return text.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
}

function log(message) {
  console.log(`[restore-dump] ${message}`);
}

/**
 * Spawn a child, forward its stderr, and keep the text for the failure message.
 * `done` settles once, on the first `error` or `close`.
 */
function streamed(command, args, options) {
  const child = spawn(command, args, options);
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });
  const done = new Promise((resolve) => {
    child.on("error", (err) => resolve({ code: 127, error: err }));
    child.on("close", (code) => resolve({ code: code ?? 1, error: null }));
  });
  return { child, done, stderr: () => stderr };
}

/**
 * Stream the dump (through openssl when it is encrypted) into pg_restore.
 *
 * `--exit-on-error` stops at the first SQL error instead of restoring a
 * half-populated database and exiting 1 at the end; the scratch database is
 * dropped either way.
 */
export async function restoreInto({ dumpPath, scratchUrl, encrypted, keyEnv, env = process.env }) {
  const restore = streamed(
    "pg_restore",
    ["--no-owner", "--no-privileges", "--exit-on-error", "-d", scratchUrl],
    { stdio: ["pipe", "inherit", "pipe"] },
  );
  // pg_restore closes stdin when it exits early; the writer's EPIPE is expected.
  restore.child.stdin.on("error", () => {});

  const source = encrypted
    ? streamed(
        "openssl",
        ["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-pass", `env:${keyEnv}`, "-in", dumpPath],
        { stdio: ["ignore", "pipe", "pipe"], env },
      )
    : null;

  const input = source ? source.child.stdout : createReadStream(dumpPath);
  input.on("error", (err) => {
    if (err.code !== "EPIPE") restore.child.stdin.destroy(err);
  });
  input.pipe(restore.child.stdin);

  const [result, sourceResult] = await Promise.all([
    restore.done,
    source ? source.done : Promise.resolve({ code: 0, error: null }),
  ]);

  if (result.code === 127 && result.error) {
    throw new Error(
      result.error.code === "ENOENT"
        ? "pg_restore is not on PATH. Install the Postgres client tools (for example `brew install libpq` or the postgresql-client package), matching or newer than the server that wrote the dump."
        : `pg_restore could not start: ${result.error.message}`,
    );
  }
  if (sourceResult.code === 127) {
    throw new Error(
      sourceResult.error?.code === "ENOENT"
        ? "openssl is not on PATH, and the dump is encrypted."
        : `openssl could not start: ${sourceResult.error?.message ?? "unknown error"}`,
    );
  }
  if (sourceResult.code !== 0) {
    const detail = tail(source.stderr(), 4);
    const hint = /wrong final block length/.test(source.stderr())
      ? "the ciphertext is truncated or corrupt (openssl reported a bad final block)"
      : `the passphrase in ${keyEnv} does not decrypt this dump: the key is wrong, or the file is truncated or corrupt`;
    throw new Error(`openssl exited ${sourceResult.code}: ${hint}` + (detail ? `\n${detail}` : ""));
  }
  if (result.code !== 0) {
    throw new Error(`pg_restore exited ${result.code}`);
  }
}

async function inspectScratch(scratchUrl) {
  const client = new pg.Client({ connectionString: scratchUrl });
  await client.connect();
  try {
    const tables = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    const names = new Set(tables.rows.map((row) => row.tablename));
    const required = ["sessions", "payments", "payment_ledger"];
    const missing = required.filter((table) => !names.has(table));
    if (missing.length > 0) {
      throw new Error(
        `the dump restored, but this is not a sandbox database (missing ${missing.join(", ")})`,
      );
    }

    let version = null;
    if (names.has("sandbox_schema")) {
      const row = await client.query("SELECT version FROM sandbox_schema LIMIT 1");
      version = row.rows[0]?.version ?? null;
      if (version !== null) version = Number(version);
    }
    return { version };
  } finally {
    await client.end().catch(() => {});
  }
}

/** The restored copy, tracked so a signal handler can still drop it. */
let activeScratch = null;

export async function dropScratch() {
  const current = activeScratch;
  activeScratch = null;
  if (!current) return;
  try {
    await current.admin.query(`DROP DATABASE IF EXISTS "${current.name}" WITH (FORCE)`);
  } finally {
    await current.admin.end().catch(() => {});
  }
}

/** Run the contract suite against the restored copy, inheriting its output. */
export function runContractSuite({ adminUrl, scratchUrl }) {
  return new Promise((done) => {
    const child = spawn("npm", ["run", "--silent", "test:store-contract-restored"], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: adminUrl, SBX_RESTORE_DATABASE_URL: scratchUrl },
    });
    child.on("error", (err) => {
      console.error(`[restore-dump] could not start npm: ${err.message}`);
      done(127);
    });
    child.on("close", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.dump === null) {
    console.error(USAGE);
    return 2;
  }

  const dumpPath = resolve(options.dump);
  let size;
  try {
    const stat = statSync(dumpPath);
    if (!stat.isFile()) throw new Error("not a regular file");
    size = stat.size;
  } catch (err) {
    console.error(`[restore-dump] cannot read ${dumpPath}: ${err.message}`);
    return 2;
  }

  const adminUrl = (options.databaseUrl ?? env.DATABASE_URL ?? "").trim();
  if (adminUrl === "") {
    console.error(
      "[restore-dump] DATABASE_URL is not set. Point it at a server whose user can create databases; " +
        "the database it names is not written to.",
    );
    return 2;
  }

  let targetDatabase;
  try {
    targetDatabase = databaseNameOf(adminUrl);
  } catch {
    console.error("[restore-dump] DATABASE_URL is not a parseable connection string");
    return 2;
  }

  const head = firstBytes(dumpPath, 8);
  const encrypted = dumpLooksEncrypted(head);
  const key = encrypted ? (env[options.keyEnv] ?? "") : "";
  if (encrypted && key === "") {
    console.error(
      `[restore-dump] this dump is openssl-encrypted (${OPENSSL_MAGIC} header) and ${options.keyEnv} is not set. ` +
        "Export the passphrase in that variable; it is never read from argv.",
    );
    return 2;
  }

  log(`${dumpPath} (${printable(size)}, ${encrypted ? "encrypted" : "plain pg_dump archive"})`);
  log(`admin connection ${described(adminUrl)}; its database '${targetDatabase}' is not written to`);

  const admin = new pg.Client({ connectionString: adminUrl, application_name: "sandbox-restore-dump" });
  try {
    await admin.connect();
  } catch (err) {
    console.error(`[restore-dump] cannot connect to ${described(adminUrl)}: ${err.message}`);
    return 1;
  }

  let name = scratchDatabaseName();
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const found = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
      if (found.rowCount === 0) break;
      name = scratchDatabaseName();
    }
    if (name === targetDatabase) {
      // Impossible with the prefix, and cheap to keep impossible.
      console.error("[restore-dump] refusing to create a scratch database with the target's name");
      await admin.end().catch(() => {});
      return 1;
    }
    await admin.query(`CREATE DATABASE "${name}"`);
  } catch (err) {
    console.error(`[restore-dump] could not create the scratch database: ${err.message}`);
    await admin.end().catch(() => {});
    return 1;
  }

  activeScratch = { admin, name };
  const scratchUrl = scratchUrlFor(adminUrl, name);
  log(`scratch database ${name}`);

  try {
    log(encrypted ? `decrypting with ${options.keyEnv} and restoring` : "restoring");
    await restoreInto({ dumpPath, scratchUrl, encrypted, keyEnv: options.keyEnv, env });

    const { version } = await inspectScratch(scratchUrl);
    log(`restored the archive into ${name}`);

    const plan = schemaPlan(version, buildSchemaVersion());
    log(`schema: ${plan.message}`);
    if (plan.action === "refuse") {
      console.error("[restore-dump] FAIL: this dump is not usable with this build");
      return 1;
    }

    // Rows first: the contract truncates every table, so after it runs there is
    // nothing left to compare.
    const sourceUrl = options.compare
      ? await usableSource({
          sourceUrl: options.compareUrl ?? adminUrl,
          explicit: options.compareUrl !== null,
          log,
        })
      : null;
    if (!options.compare) log("data: --no-compare, so the rows are not compared");

    const data = await verifyData({ scratchUrl, sourceUrl, log });
    if (!data.ok) {
      console.error(
        `[restore-dump] FAIL: the restored copy does not match the source ` +
          `(${data.mismatches.length} of ${data.tables.length} tables differ)`,
      );
      for (const difference of data.differences) console.error(`[restore-dump]   ${difference}`);
      return 1;
    }

    log("running the store contract against the restored copy");
    const code = await runContractSuite({ adminUrl, scratchUrl });
    if (code !== 0) {
      console.error(`[restore-dump] FAIL: the store contract exited ${code}`);
      return 1;
    }
    const sessions = data.tables.find((entry) => entry.table === "sessions")?.rows ?? 0;
    log(
      `PASS: ${name} survived the dump, the restore` +
        `${data.compared ? ", the row comparison" : ""} and the store contract ` +
        `(${version === null ? "no version row" : `schema v${version}`}, ${sessions} sessions, ` +
        `total fp ${data.total.fp}${data.compared ? "" : ", rows NOT compared"})`,
    );
    return 0;
  } catch (err) {
    console.error(`[restore-dump] FAIL: ${err.message}`);
    return 1;
  } finally {
    if (options.keep) {
      activeScratch = null;
      console.log(`[restore-dump] --keep: ${name} left in place at ${scratchUrl}`);
      console.log(`[restore-dump] drop it with: psql "${adminUrl}" -c 'DROP DATABASE "${name}"'`);
      await admin.end().catch(() => {});
    } else {
      await dropScratch().catch((err) => {
        console.error(`[restore-dump] could not drop ${name}: ${err.message}`);
      });
    }
  }
}

const invokedDirectly =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const stop = () => {
    void dropScratch()
      .catch(() => {})
      .finally(() => process.exit(130));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`[restore-dump] ${err instanceof UsageError ? err.message : err.stack ?? err}`);
      process.exitCode = err instanceof UsageError ? 2 : 1;
    },
  );
}
