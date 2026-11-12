/**
 * The Postgres test harness.
 *
 * Every worker process gets one throwaway database, created on first use from an
 * admin connection to `DATABASE_URL`. `freshStore()` truncates every table in
 * `public` and returns the writer store; `openStore()` opens another connection
 * to the same database without truncating, which is what a controller-restart
 * test needs.
 *
 * The database name carries the run id and the worker pid:
 *
 *   sbx_test_<namespace>_<run-id>_<pid>_<random>
 *
 * so `--fileParallelism` is safe by construction: two workers cannot share a
 * database even by accident, and tests inside one file still run serially
 * against the same database, because Vitest runs a file's tests in order.
 *
 * Truncation runs on its own connection, never through the store, so it can
 * clean a database whose store was left open by a previous test. The tables are
 * read from the catalog instead of being hard-coded: the schema ladder adds
 * tables, and a list that drifts would leave rows behind.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { PostgresStore } from "../../controller/src/store/postgres/store.js";

export interface OpenStoreOptions {
  /** Namespace in the database name: unit tests use `unit`, integration uses `integration`. */
  namespace?: string;
  budgetWindowMs?: number;
  max?: number;
  writer?: boolean;
}

const DEFAULT_NAMESPACE = "unit";

const databases = new Map<string, string>();
let admin: pg.Client | null = null;
let testClient: pg.Client | null = null;
let testClientDatabase: string | null = null;
let store: PostgresStore | null = null;

function adminUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "DATABASE_URL is required for the test suite. Point it at a throwaway Postgres database " +
        "whose user can create databases, for example " +
        "postgres://postgres:pg@127.0.0.1:55432/sandbox",
    );
  }
  return url;
}

/** The run id shared by every worker in one Vitest invocation. */
export function runId(): string {
  return process.env.SBX_TEST_RUN_ID ?? `${process.ppid}`;
}

/** A stable database name for one namespace in this worker process. */
export function testDatabaseName(namespace = DEFAULT_NAMESPACE): string {
  const cached = databases.get(namespace);
  if (cached) return cached;
  const safe = namespace.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  const random = randomBytes(4).toString("hex");
  const name = `sbx_test_${safe}_${runId()}_${process.pid}_${random}`;
  databases.set(namespace, name);
  return name;
}

/**
 * The URL for this worker's database. Synchronous, because several tests build
 * controller configuration at module scope; the database itself is created on
 * first use by `freshStore()` or `openStore()`.
 */
export function testDatabaseUrl(namespace = DEFAULT_NAMESPACE): string {
  const url = new URL(adminUrl());
  url.pathname = `/${testDatabaseName(namespace)}`;
  return url.toString();
}

async function adminClient(): Promise<pg.Client> {
  if (admin) return admin;
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  admin = client;
  return client;
}

/** Create the worker's database if it is not there yet. */
export async function ensureTestDatabase(namespace = DEFAULT_NAMESPACE): Promise<string> {
  return ensureDatabase(namespace);
}

async function ensureDatabase(namespace: string): Promise<string> {
  const name = testDatabaseName(namespace);
  const client = await adminClient();
  const found = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (found.rowCount === 0) {
    await client.query(`CREATE DATABASE "${name}"`);
  }
  return name;
}

async function databaseClient(name: string): Promise<pg.Client> {
  if (testClient && testClientDatabase === name) return testClient;
  if (testClient) {
    const stale = testClient;
    testClient = null;
    testClientDatabase = null;
    await stale.end().catch(() => undefined);
  }
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  // A leaked transaction would otherwise block TRUNCATE forever.
  await client.query("SET lock_timeout = '10s'");
  testClient = client;
  testClientDatabase = name;
  return client;
}

/**
 * Empty every table in `public`, leaving the migration table alone.
 *
 * `CASCADE` is required for the sessions -> payments foreign key, and one
 * statement keeps the order irrelevant.
 */
export async function truncateAll(namespace = DEFAULT_NAMESPACE): Promise<void> {
  const name = await ensureDatabase(namespace);
  const client = await databaseClient(name);
  const tables = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'sandbox_schema'`,
  );
  if (tables.rowCount === 0) return;
  const list = tables.rows.map((row) => `"${row.tablename.replaceAll('"', '""')}"`).join(", ");
  await client.query(`TRUNCATE TABLE ${list} CASCADE`);
}

/**
 * A clean database and the process's writer store.
 *
 * The store is reused across calls while it is open: opening a second writer on
 * the same database is refused by the advisory lock, and every test here wants
 * the production shape (one writer, many pool connections). A test that closes
 * the store gets a fresh one on the next call.
 */
export async function freshStore(options: OpenStoreOptions = {}): Promise<PostgresStore> {
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  await truncateAll(namespace);
  if (store) {
    try {
      if (store.writesAreBlocked) await store.setWritesBlocked(false);
      return store;
    } catch {
      // A test closed it; the advisory lock died with the pool. Open another.
      await store.close().catch(() => undefined);
      store = null;
    }
  }
  store = await PostgresStore.open(testDatabaseUrl(namespace), {
    writer: options.writer ?? true,
    ...(options.budgetWindowMs !== undefined ? { budgetWindowMs: options.budgetWindowMs } : {}),
    ...(options.max !== undefined ? { max: options.max } : {}),
  });
  return store;
}

/**
 * Another connection to the same database, with no truncation.
 *
 * The tracked writer is closed first: Postgres allows one writer per database,
 * and every restart test closes the old store before asking for this.
 */
export async function openStore(options: OpenStoreOptions = {}): Promise<PostgresStore> {
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  await ensureDatabase(namespace);
  const previous = store;
  store = null;
  if (previous) await previous.close().catch(() => undefined);
  store = await PostgresStore.open(testDatabaseUrl(namespace), {
    writer: options.writer ?? true,
    ...(options.budgetWindowMs !== undefined ? { budgetWindowMs: options.budgetWindowMs } : {}),
    ...(options.max !== undefined ? { max: options.max } : {}),
  });
  return store;
}

/** Close the tracked store without opening another one. */
export async function closeStore(): Promise<void> {
  const current = store;
  store = null;
  if (current) await current.close().catch(() => undefined);
}

/** Rows from the worker's test database. */
export async function sqlRows<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
  namespace = DEFAULT_NAMESPACE,
): Promise<T[]> {
  const name = await ensureDatabase(namespace);
  const client = await databaseClient(name);
  const res = await client.query<T>(text, values);
  return res.rows;
}

export async function sqlExec(
  text: string,
  values: unknown[] = [],
  namespace = DEFAULT_NAMESPACE,
): Promise<number> {
  const name = await ensureDatabase(namespace);
  const client = await databaseClient(name);
  const res = await client.query(text, values);
  return res.rowCount ?? 0;
}

/** `COUNT(*)` for a table, with the name quoted as an identifier. */
export async function countRows(table: string, namespace = DEFAULT_NAMESPACE): Promise<number> {
  const rows = await sqlRows<{ n: number }>(
    `SELECT COUNT(*) AS n FROM "${table.replaceAll('"', '""')}"`,
    [],
    namespace,
  );
  return Number(rows[0]?.n ?? 0);
}

/** Write the reconciler schedule column, which is deliberately not a record field. */
export async function setNextDue(
  id: string,
  atMs: number | null,
  namespace = DEFAULT_NAMESPACE,
): Promise<boolean> {
  const changed = await sqlExec(
    "UPDATE sessions SET next_due_ms = $1 WHERE id = $2",
    [atMs, id],
    namespace,
  );
  return changed > 0;
}

export async function readNextDue(
  id: string,
  namespace = DEFAULT_NAMESPACE,
): Promise<number | null> {
  const rows = await sqlRows<{ next_due_ms: number | null }>(
    "SELECT next_due_ms FROM sessions WHERE id = $1",
    [id],
    namespace,
  );
  const value = rows[0]?.next_due_ms;
  // The harness client does not install the store pool's int8 parser.
  return value === null || value === undefined ? null : Number(value);
}

/**
 * Drop every database this run created.
 *
 * `WITH (FORCE)` disconnects a worker that leaked a pool, which is exactly the
 * case a teardown exists for. Only databases carrying this run id are touched,
 * so a concurrent run keeps its own.
 */
export async function dropTestDb(id = runId()): Promise<void> {
  const client = await adminClient();
  const found = await client.query<{ datname: string }>(
    "SELECT datname FROM pg_database WHERE datname LIKE 'sbx_test_%' AND datname LIKE $1",
    [`%\\_${id}\\_%`],
  );
  for (const row of found.rows) {
    await client.query(`DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`);
  }
  await client.end();
  admin = null;
  if (testClient) {
    await testClient.end().catch(() => undefined);
    testClient = null;
    testClientDatabase = null;
  }
}
