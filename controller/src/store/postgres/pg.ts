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
 * Advisory-lock keys. Session-scoped locks use the writer key; transaction
 * scoped locks use the others to serialise a read-then-write that the schema
 * alone cannot make atomic. They are arbitrary but stable: changing one is a
 * behaviour change, not a rename.
 */
const WRITER_LOCK_KEY = 8_402_001;
/** Durable create budget: the concurrency caps are counted, not enforced by a row. */
export const BUDGET_LOCK_KEY = 8_402_002;
/** Capacity admission: the snapshot and the insert must agree. */
export const CAPACITY_LOCK_KEY = 8_402_003;

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
  serialise(key: number | string): Promise<void>;
}

export class PgConnection implements Querier {
  readonly pool: Pool;
  /** Dedicated connection that holds the session advisory lock. */
  private lockClient: PoolClient | null = null;
  private writable = false;
  private closed = false;

  constructor(url: string, options: { max?: number } = {}) {
    this.pool = new pg.Pool({ connectionString: url, types, max: options.max ?? 10 });
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
      serialise: async (key: number | string) => {
        await client.query("SELECT pg_advisory_xact_lock($1)", [key]);
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
        "SELECT pg_try_advisory_lock($1) AS ok",
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
      await client.query("SELECT pg_advisory_unlock($1)", [WRITER_LOCK_KEY]);
    } catch {
      // The connection died, and the session lock died with it. There is nothing
      // left to unlock, and refusing to close would only strand the pool.
    } finally {
      client.release();
    }
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
 * A stable signed 64-bit key for `pg_advisory_xact_lock`, derived from a
 * string. Used to serialise two creates that claim the same client key pair.
 */
export function advisoryKey(scope: string, value: string): string {
  const digest = createHash("sha256").update(`${scope}:${value}`).digest();
  return BigInt.asIntN(64, digest.readBigUInt64BE(0)).toString();
}
