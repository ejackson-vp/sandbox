/**
 * Prove the rows came back, not just the schema.
 *
 * `restore-dump.mjs` restores an artifact and runs the store contract against
 * the copy. The contract truncates every table before each test, so it can only
 * ever prove the schema and the invariants: an empty `sessions` table passes.
 * This module takes a fingerprint of the copy and of the database the dump came
 * from, table by table, and compares them. It runs after the restore and before
 * the contract, because the contract destroys the rows it would be checking.
 *
 * The fingerprint is deliberately blunt and deterministic:
 *
 *   rows = count(*)
 *   fp   = md5 of the concatenation, in primary-key order, of md5(row_text)
 *
 * where `row_text` is `ROW(<columns sorted by name>)::text`, rendered by
 * Postgres' own output functions. Missing, duplicated or altered rows change at
 * least one of the two values. The column list is the intersection of both
 * sides, sorted by name so the two queries are byte-identical; columns that
 * exist on only one side are named in the output rather than hidden.
 *
 * Cost: one sequential scan of each table on each side, plus a sort by primary
 * key when the planner cannot use the key's index, and 32 bytes of aggregate
 * state per row while the hash is built. Nothing is sampled; every row is
 * hashed. The report prints the rows and the time per table so an operator can
 * see what it cost before running it against a real database.
 *
 * Both connections run `default_transaction_read_only = on`. The check reads
 * and nothing else.
 */
import { createHash } from "node:crypto";
import pg from "pg";

/**
 * The tables that carry money and sessions. A mismatch in any of these fails
 * the run. `challenge_nonces` and `payer_budgets` are fingerprinted too (the
 * contract truncates them as well) but are not required to exist, because they
 * arrived in v13 and v14 and a dump older than that is still restorable.
 */
export const VERIFIED_TABLES = [
  { table: "payments", required: true },
  { table: "payment_intents", required: true },
  { table: "payment_ledger", required: true },
  { table: "sessions", required: true },
  { table: "exec_requests", required: true },
  { table: "reservations", required: true },
  { table: "challenge_nonces", required: false },
  { table: "payer_budgets", required: false },
];

/** A table with at least this many rows gets a note about what the scan costs. */
const LARGE_TABLE_ROWS = 1_000_000;

/** Types that sort differently under different collations, so pin the C collation. */
const TEXT_TYPES = new Set(["text", "varchar", "bpchar", "citext", "name"]);

/**
 * Session settings that make `::text` reproducible across two databases.
 *
 * `timestamptz` renders in the session time zone, floats honour
 * `extra_float_digits` and `bytea` honours `bytea_output`. None of the columns
 * here are those types today; pinning them means a future column cannot make
 * the two sides render the same value differently.
 */
const DETERMINISTIC_SESSION = [
  "SET TIME ZONE 'UTC'",
  "SET DateStyle = 'ISO, YMD'",
  "SET IntervalStyle = 'iso_8601'",
  "SET extra_float_digits = 3",
  "SET bytea_output = 'hex'",
];

/** @param {string} name */
export function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

/**
 * One row as Postgres renders it: quoted where needed, NULL as an empty field.
 * @param {string[]} columns
 */
export function rowExpression(columns) {
  return `ROW(${columns.map(quoteIdent).join(", ")})::text`;
}

/**
 * The aggregation order. Primary key when there is one, so both sides walk the
 * rows in the same sequence; the rendered row when there is not, which is still
 * deterministic. Text keys get `COLLATE "C"` because a database restored onto a
 * cluster with a different locale would otherwise order them differently.
 *
 * @param {string[]} primaryKey
 * @param {string[]} columns
 * @param {Record<string, string>} [types]
 */
export function orderExpression(primaryKey, columns, types = {}) {
  if (primaryKey.length === 0) return `${rowExpression(columns)} COLLATE "C"`;
  return primaryKey
    .map((name) => {
      const ident = `t.${quoteIdent(name)}`;
      return TEXT_TYPES.has(types[name]) ? `${ident} COLLATE "C"` : ident;
    })
    .join(", ");
}

/**
 * The one statement that produces both numbers for one table and one side.
 * @param {string} table
 * @param {{ columns: string[], primaryKey?: string[], types?: Record<string, string> }} shape
 */
export function fingerprintQuery(table, { columns, primaryKey = [], types = {} }) {
  return (
    "SELECT count(*)::bigint AS n, " +
    `md5(coalesce(string_agg(md5(${rowExpression(columns)}), '' ORDER BY ` +
    `${orderExpression(primaryKey, columns, types)}), '')) AS fp ` +
    `FROM ${quoteIdent(table)} AS t`
  );
}

/**
 * One fingerprint over the tables that matched, so a single number says whether
 * the copies agree. Tables are folded in by name, so the total is stable across
 * runs and across a database with a different physical table order.
 */
/**
 * @param {Array<{ table: string, rows: number, fp: string }>} entries
 */
export function totalFingerprint(entries) {
  const ordered = [...entries].sort((a, b) => a.table.localeCompare(b.table));
  const text = ordered.map((entry) => `${entry.table}:${entry.rows}:${entry.fp}`).join("\n");
  return {
    rows: ordered.reduce((sum, entry) => sum + entry.rows, 0),
    fp: createHash("md5").update(text).digest("hex"),
  };
}

/**
 * What to say about one table, or null when the two sides agree.
 * @param {string} label
 * @param {{ rows: number, fp: string }} source
 * @param {{ rows: number, fp: string }} copy
 */
export function differenceOf(label, source, copy) {
  if (source.rows === copy.rows && source.fp === copy.fp) return null;
  return (
    `${label}: source rows=${source.rows} fp=${source.fp}, ` +
    `copy rows=${copy.rows} fp=${copy.fp}`
  );
}

/**
 * `host:port/database`, never the password.
 * @param {string} connectionString
 */
export function describeUrl(connectionString) {
  const url = new URL(connectionString);
  return `${url.host}${url.pathname}`;
}

async function readOnlyClient(url) {
  const client = new pg.Client({ connectionString: url, application_name: "sandbox-restore-verify" });
  await client.connect();
  try {
    await client.query("SET default_transaction_read_only = on");
    for (const statement of DETERMINISTIC_SESSION) await client.query(statement);
    return client;
  } catch (err) {
    await client.end().catch(() => {});
    throw err;
  }
}

/** Columns, their types, and the primary key, straight from the catalog. */
async function loadShape(client, table) {
  const ref = `public.${table}`;
  const found = await client.query("SELECT to_regclass($1)::text AS regclass", [ref]);
  if (found.rows[0]?.regclass === null) {
    return { table, exists: false, columns: [], types: {}, primaryKey: [] };
  }

  const columns = await client.query(
    "SELECT a.attname AS name, t.typname AS type " +
      "FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid " +
      "WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped " +
      "ORDER BY a.attname",
    [ref],
  );
  const primaryKey = await client.query(
    "SELECT a.attname AS name " +
      "FROM pg_constraint c " +
      "CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) " +
      "JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum " +
      "WHERE c.conrelid = to_regclass($1) AND c.contype = 'p' " +
      "ORDER BY k.ord",
    [ref],
  );

  return {
    table,
    exists: true,
    columns: columns.rows.map((row) => row.name),
    types: Object.fromEntries(columns.rows.map((row) => [row.name, row.type])),
    primaryKey: primaryKey.rows.map((row) => row.name),
  };
}

/** Row count and hash for one table, timed so the report can state the cost. */
async function fingerprint(client, table, shape, columns) {
  const started = Date.now();
  const result = await client.query(
    fingerprintQuery(table, { columns, primaryKey: shape.primaryKey, types: shape.types }),
  );
  const row = result.rows[0] ?? { n: 0, fp: "" };
  return { table, rows: Number(row.n ?? 0), fp: String(row.fp ?? ""), ms: Date.now() - started };
}

function pad(text, width) {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/**
 * The database to compare the copy with, or null when there is nothing to
 * compare against.
 *
 * `explicit` is true when the operator passed `--compare-url`: a URL that turns
 * out not to be a sandbox database is then their mistake and throws. The
 * default connection is only a convenience, so a server without sandbox tables
 * downgrades the run to schema-only instead of failing it.
 */
export async function usableSource({ sourceUrl, explicit = false, log = () => {} }) {
  if (sourceUrl === null) return null;
  if (await looksLikeSandboxDatabase(sourceUrl)) return sourceUrl;
  const message =
    `${describeUrl(sourceUrl)} is not a sandbox database (no payments, payment_ledger, sessions)`;
  if (explicit) throw new Error(`--compare-url ${message}`);
  log(`data: ${message}, so there is nothing to compare with`);
  return null;
}

/**
 * Fingerprint the copy, the source if there is one, and compare.
 *
 * Returns `{ ok, compared, tables, total, sourceTotal, mismatches, elapsedMs }`
 * and prints a line per table through `log`. A mismatch is never a thrown
 * error: the caller decides the exit code, so the report stays readable.
 */
export async function verifyData({
  scratchUrl,
  sourceUrl = null,
  log = () => {},
  tables = VERIFIED_TABLES,
}) {
  const started = Date.now();
  const copy = await readOnlyClient(scratchUrl);
  let source = null;
  try {
    if (sourceUrl !== null) {
      source = await readOnlyClient(sourceUrl);
      const [copyName, sourceName] = await Promise.all([
        copy.query("SELECT current_database() AS name"),
        source.query("SELECT current_database() AS name"),
      ]);
      if (copyName.rows[0].name === sourceName.rows[0].name) {
        throw new Error(
          `the source and the restored copy are the same database (${copyName.rows[0].name}); ` +
            "compare the dump with the database it came from, not with the scratch copy",
        );
      }
      log(`data: source ${describeUrl(sourceUrl)} (read-only, full scan)`);
    } else {
      log("data: fingerprinting the copy only, with nothing to compare it against");
    }

    const results = [];
    const mismatches = [];
    const notes = [];

    for (const { table, required } of tables) {
      const copyShape = await loadShape(copy, table);
      const sourceShape = source === null ? null : await loadShape(source, table);

      if (!copyShape.exists) {
        if (sourceShape?.exists !== true) {
          if (required) {
            mismatches.push(`${table}: required table is missing from the restored copy`);
            log(`data ${pad(table, 18)} MISSING and required`);
          } else {
            log(`data ${pad(table, 18)} absent from both, not compared`);
          }
        } else if (required) {
          mismatches.push(
            `${table}: present in the source (${describeUrl(sourceUrl)}) and missing from the copy`,
          );
          log(`data ${pad(table, 18)} MISSING from the restored copy`);
        } else {
          log(`data ${pad(table, 18)} absent from the copy, not compared`);
        }
        continue;
      }

      const shared =
        sourceShape === null || !sourceShape.exists
          ? [...copyShape.columns].sort()
          : copyShape.columns.filter((name) => sourceShape.columns.includes(name)).sort();
      const onlyCopy = copyShape.columns.filter((name) => !shared.includes(name));
      const onlySource =
        sourceShape === null || !sourceShape.exists
          ? []
          : sourceShape.columns.filter((name) => !shared.includes(name));

      if (shared.length === 0) {
        mismatches.push(`${table}: no columns in common between the source and the copy`);
        continue;
      }
      if (sourceShape !== null && !sourceShape.exists && required) {
        mismatches.push(
          `${table}: present in the copy and missing from ${describeUrl(sourceUrl)}`,
        );
        log(`data ${pad(table, 18)} MISSING from the source`);
      }

      const copyPrint = await fingerprint(copy, table, copyShape, shared);
      const sourcePrint =
        sourceShape?.exists === true ? await fingerprint(source, table, sourceShape, shared) : null;

      const partial = onlyCopy.length > 0 || onlySource.length > 0;
      if (partial && sourcePrint !== null) {
        const skipped = [
          ...onlySource.map((name) => `${name} (source only)`),
          ...onlyCopy.map((name) => `${name} (copy only)`),
        ];
        notes.push(
          `${table}: compared ${shared.length} of ${shared.length + skipped.length} columns, ` +
            `skipped ${skipped.join(", ")}`,
        );
      }
      if (copyPrint.rows >= LARGE_TABLE_ROWS) {
        notes.push(
          `${table}: ${copyPrint.rows} rows, so the fingerprint is a full scan of both sides ` +
            `(one sequential pass each, plus a sort by primary key when the index is not used)`,
        );
      }
      if (required && copyPrint.rows === 0 && (sourcePrint === null || sourcePrint.rows === 0)) {
        notes.push(`${table}: empty in ${sourcePrint === null ? "the copy" : "both databases"}`);
      }

      const difference =
        sourcePrint === null ? null : differenceOf(table, sourcePrint, copyPrint);
      if (difference !== null) mismatches.push(difference);

      results.push({
        table,
        rows: copyPrint.rows,
        fp: copyPrint.fp,
        sourceRows: sourcePrint?.rows ?? null,
        sourceFp: sourcePrint?.fp ?? null,
        msCopy: copyPrint.ms,
        msSource: sourcePrint?.ms ?? null,
        partial,
        pk: copyShape.primaryKey,
      });

      const detail =
        partial && sourcePrint !== null
          ? ` partial (${shared.length} columns)`
          : copyShape.primaryKey.length === 0
            ? " ordered by row text (no primary key)"
            : "";
      const verdict = sourcePrint === null ? "" : difference === null ? " match" : " MISMATCH";
      log(
        `data ${pad(table, 18)} rows=${pad(String(copyPrint.rows), 7)} fp=${copyPrint.fp}` +
          `${verdict}${detail} (${copyPrint.ms} ms copy` +
          `${sourcePrint === null ? "" : `, ${sourcePrint.ms} ms source`})`,
      );
    }

    for (const note of notes) log(`data note: ${note}`);

    const total = totalFingerprint(results);
    const sourceTotal =
      source === null
        ? null
        : totalFingerprint(results.filter((entry) => entry.sourceFp !== null).map((entry) => ({
            table: entry.table,
            rows: entry.sourceRows,
            fp: entry.sourceFp,
          })));
    const totalDifference = sourceTotal === null ? null : differenceOf("total", sourceTotal, total);
    const elapsedMs = Date.now() - started;
    log(
      `data ${pad("total", 18)} rows=${pad(String(total.rows), 7)} fp=${total.fp}` +
        `${sourceTotal === null ? "" : totalDifference === null ? " match" : " MISMATCH"} ` +
        `(${results.length} tables, full scan of ${source === null ? "the copy" : "both databases"}, ${elapsedMs} ms)`,
    );

    return {
      ok: mismatches.length === 0 && totalDifference === null,
      compared: source !== null,
      tables: results,
      total,
      sourceTotal,
      mismatches,
      differences: totalDifference === null ? mismatches : [...mismatches, totalDifference],
      elapsedMs,
    };
  } finally {
    if (source !== null) await source.end().catch(() => {});
    await copy.end().catch(() => {});
  }
}

/**
 * Is the database behind `url` a sandbox database at all?
 *
 * A restore drill on a laptop often has no source, and the admin URL then names
 * some empty `postgres` database. Pointing the check at that is a mistake, not
 * a mismatch: say so and skip the comparison instead of reporting every table
 * as missing.
 */
export async function looksLikeSandboxDatabase(url) {
  const client = await readOnlyClient(url);
  try {
    const found = await client.query(
      "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' " +
        "AND tablename IN ('payments', 'payment_ledger', 'sessions')",
    );
    return Number(found.rows[0]?.n ?? 0) === 3;
  } finally {
    await client.end().catch(() => {});
  }
}
