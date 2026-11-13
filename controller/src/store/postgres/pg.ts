/**
 * Postgres connection, transaction and writer-lock plumbing.
 *
 * Three things live here and nowhere else:
 *
 *   - the pool, configured so `BIGINT` arrives as a JS number. Every int8 column
 *     in the schema is an epoch millisecond or a small count, both far inside
 *     `Number.MAX_SAFE_INTEGER`, and money is `TEXT`, so the default
 *     string-decoding of int8 would corrupt every timestamp on read;
 *   - the transaction helper. It is always `READ COMMITTED` (the server default),
 *     never `REPEATABLE READ`: ADR 0010 requires the guards to be correct under
 *     `READ COMMITTED`, and a stronger mode would hide a missing `WHERE` instead
 *     of failing the contract tests;
 *   - the writer lock. `pg_advisory_lock` on a dedicated connection is the
 *     store-level backstop behind the Kubernetes Lease (ADR 0010): the lease
 *     decides who reconciles, the lock decides who may write. A write without
 *     the lock throws rather than degrading.
 */
import { createHash } from "node:crypto";
import pg from "pg";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

const INT8 = 20;

/**
 * Scoped type parsing: int8 as a number, everything else as pg ships it.
 * Passing this to the pool rather than calling `pg.types.setTypeParser`
 * keeps the override out of every other consumer in the process.
 */
const types = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (oid === INT8) return (value: string) => Number(value);
    return pg.types.getTypeParser(oid, format);
  },
};

/**
 * Timeout for one read-only audit statement.
 *
 * The audit runs inside `/metrics`, whose scrape timeout is 10 s
 * (`deploy/monitoring/contract/prometheus-scrape.yaml`). Two statements at 2 s
 * each leave the scrape handler well inside that budget even when the database
 * is slow rather than down.
 */
export const READ_ONLY_QUERY_TIMEOUT_MS = 2_000;

/** How long the audit pool may spend establishing a connection. */
const READ_ONLY_CONNECT_TIMEOUT_MS = 1_000;

/**
 * How long the writer pool may spend establishing a connection.
 *
 * Matches the 1.5s ceiling on one leadership acquire attempt. Without it a
 * blackholed host leaves the connect waiting for the OS TCP timeout (75 to
 * 130 seconds), which outlives several lease renewals and turns one acquire
 * attempt into a multi-minute stall.
 */
const WRITER_CONNECT_TIMEOUT_MS = 1_500;

/**
 * Advisory-lock keys, scoped per database.
 *
 * Every lock is taken with the two-int form `(key, hashtext(current_database())::int)`.
 * The first int is the stable constant below; the second is derived by the server
 * from the current database name, so a store pointed at another database in the
 * same cluster does not block this one. In production there is one database, so
 * the second key is constant in practice; in tests it is what lets each database
 * keep its own writer and its own admission locks while sharing a cluster.
 *
 * They are arbitrary but stable: changing one is a behaviour change, not a
 * rename.
 */
const WRITER_LOCK_KEY = 8_402_001;
/** Durable create budget: the concurrency caps are counted, not enforced by a row. */
export const BUDGET_LOCK_KEY = 8_402_002;
/** Capacity admission: the snapshot and the insert must agree. */
export const CAPACITY_LOCK_KEY = 8_402_003;

/**
 * The second key of every advisory lock. `hashtext` is the server's own string
 * hash; two databases can collide in it, which only makes them share a lock they
 * did not need to share, never the reverse.
 */
const DATABASE_SCOPE = "hashtext(current_database())::int";

export class WriterLockUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriterLockUnavailableError";
  }
}

/** Anything that can run a statement: the pool wrapper and an open transaction. */
export interface Querier {
  query<R extends QueryResultRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

export interface Tx extends Querier {
  /** Take a transaction-scoped advisory lock; held until COMMIT/ROLLBACK. */
  serialise(key: number): Promise<void>;
}

export class PgConnection implements Querier {
  readonly pool: Pool;
  /** Dedicated to the ledger audit sampler; see `queryReadOnly`. */
  private auditPool: Pool | null = null;
  /** Dedicated connection that holds the session advisory lock. */
  private lockClient: PoolClient | null = null;
  private writable = false;
  private closed = false;

  constructor(
    private readonly url: string,
    options: { max?: number } = {},
  ) {
    this.pool = new pg.Pool({
      connectionString: url,
      types,
      max: options.max ?? 10,
      connectionTimeoutMillis: WRITER_CONNECT_TIMEOUT_MS,
    });
    // A pool-level error is a connection that died while idle. It must not take
    // the process down, but it is worth surfacing: the next write will retry on
    // a fresh connection.
    this.pool.on("error", () => {});
  }

  get writesAreBlocked(): boolean {
    return !this.writable;
  }

  async query<R extends QueryResultRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>> {
    return this.pool.query<R>(text, values);
  }

  /** A write outside a transaction. Refused unless this process holds the lock. */
  async write<R extends QueryResultRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>> {
    this.assertWritable();
    return this.pool.query<R>(text, values);
  }

  /**
   * Run `fn` in one transaction on one connection, then commit.
   *
   * Every transaction here writes, so the writer lock is checked at BEGIN.
   * A thrown error rolls back and is rethrown; `RolledBack` is the escape hatch
   * a caller uses to abandon a transaction while still returning a value (the
   * guarded transition lost the row and must not leave the earlier insert
   * behind).
   */
  async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    this.assertWritable();
    const client = await this.pool.connect();
    const tx: Tx = {
      query: <R extends QueryResultRow = Record<string, unknown>>(text: string, values?: unknown[]) =>
        client.query<R>(text, values),
      serialise: async (key: number) => {
        await client.query(`SELECT pg_advisory_xact_lock($1, ${DATABASE_SCOPE})`, [key]);
      },
    };
    try {
      await client.query("BEGIN");
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (err instanceof RolledBack) return err.value as T;
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Take the writer lock. Non-blocking: a second writer is a configuration or
   * lease bug, and waiting for it would turn that bug into a hang. Returns
   * false when another session holds it.
   */
  async acquireWriterLock(): Promise<boolean> {
    if (this.writable) return true;
    if (this.closed) throw new WriterLockUnavailableError("store is closed");
    const client = await this.pool.connect();
    try {
      const res = await client.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_lock($1, ${DATABASE_SCOPE}) AS ok`,
        [WRITER_LOCK_KEY],
      );
      if (res.rows[0]?.ok !== true) {
        client.release();
        return false;
      }
    } catch (err) {
      client.release();
      throw err;
    }
    // A dropped lock connection means the lock is gone while `writable` still
    // says otherwise, which is exactly the silent divergence this exists to
    // prevent. Fail closed on the socket, not on the next write.
    client.on("error", () => {
      this.writable = false;
      this.lockClient = null;
    });
    client.on("end", () => {
      this.writable = false;
      this.lockClient = null;
    });
    this.lockClient = client;
    this.writable = true;
    return true;
  }

  /** Release the writer lock. Idempotent. */
  async releaseWriterLock(): Promise<void> {
    const client = this.lockClient;
    this.writable = false;
    this.lockClient = null;
    if (!client) return;
    try {
      await client.query(`SELECT pg_advisory_unlock($1, ${DATABASE_SCOPE})`, [WRITER_LOCK_KEY]);
    } catch {
      // The connection died, and the session lock died with it. There is nothing
      // left to unlock, and refusing to close would only strand the pool.
    } finally {
      client.release();
    }
  }

  /**
   * Run one read-only statement on a pool the audit owns.
   *
   * The audit is called from `/metrics`, so it must never queue behind, or
   * starve, the ten connections the control API and the reconciler share. This
   * pool has one connection, a server-side `statement_timeout` and a client-side
   * timer, and a timed-out connection is destroyed rather than returned to the
   * pool still waiting for an answer. A slow database therefore costs one
   * audit connection and leaves the writer pool untouched.
   *
   * Read-only is structural, not a convention: the pool is opened with
   * `default_transaction_read_only=on`, so a write sent here is refused by the
   * server. There is no `write` guard to bypass.
   */
  async queryReadOnly<R extends QueryResultRow = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
    timeoutMs: number = READ_ONLY_QUERY_TIMEOUT_MS,
  ): Promise<QueryResult<R>> {
    const client = await this.readOnlyPool().connect();
    let destroyed = false;
    const timer = setTimeout(() => {
      destroyed = true;
      // release(error) closes the socket: a client that is still waiting on a
      // server answer must not be handed to the next caller.
      client.release(new Error("read-only query timed out"));
    }, timeoutMs);
    timer.unref?.();
    try {
      return await client.query<R>(text, values);
    } finally {
      clearTimeout(timer);
      if (!destroyed) client.release();
    }
  }

  private readOnlyPool(): Pool {
    this.auditPool ??= new pg.Pool({
      connectionString: this.url,
      types,
      max: 1,
      connectionTimeoutMillis: READ_ONLY_CONNECT_TIMEOUT_MS,
      statement_timeout: READ_ONLY_QUERY_TIMEOUT_MS,
      // Structural read-only: even a future caller that points a write at this
      // method is refused by the server, not just by code review.
      options: "-c default_transaction_read_only=on",
      application_name: "sandbox-ledger-audit",
    });
    // An idle audit connection dying must not take the process down; the next
    // sample opens another one.
    this.auditPool.on("error", () => {});
    return this.auditPool;
  }

  assertWritable(): void {
    if (this.writable) return;
    throw new WriterLockUnavailableError(
      "this process does not hold the store writer lock (pg_advisory_lock); refusing to write",
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.releaseWriterLock();
    await this.pool.end();
    if (this.auditPool) await this.auditPool.end();
  }
}

/**
 * Unwind a transaction while still producing a value.
 *
 * Used where a guarded write found the row already moved on: the caller has an
 * answer to return, and the writes that preceded the guard must not commit.
 */
export class RolledBack<T = unknown> extends Error {
  constructor(readonly value: T) {
    super("transaction rolled back by the store");
    this.name = "RolledBack";
  }
}

/**
 * A stable signed 32-bit key for `pg_advisory_xact_lock`, derived from a string.
 * Used to serialise two creates that claim the same client key pair.
 *
 * 32 bits because the lock is taken in the two-int form, whose first key is
 * `int4`. A collision over-serialises two unrelated creates for the length of one
 * transaction; it cannot let two creates for the same pair both through.
 */
export function advisoryKey(scope: string, value: string): number {
  const digest = createHash("sha256").update(`${scope}:${value}`).digest();
  return digest.readInt32BE(0);
}
