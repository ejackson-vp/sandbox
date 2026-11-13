/**
 * The fingerprint the restore drill compares with, pinned without a server.
 *
 * `scripts/restore-verify.mjs` runs in front of a real artifact and a real
 * database, so the parts that decide what is hashed are tested here: the
 * identifier quoting, the ordering (composite keys, text collation, no key), the
 * statement shape, the cross-table total, and the message that names a
 * mismatch. The scan itself is proved by running the command (docs/backup-restore.md).
 */
import { describe, expect, it } from "vitest";
import {
  VERIFIED_TABLES,
  describeUrl,
  differenceOf,
  fingerprintQuery,
  orderExpression,
  quoteIdent,
  rowExpression,
  totalFingerprint,
} from "../../scripts/restore-verify.mjs";

describe("restore-verify", () => {
  it("fingerprints every table that carries money or sessions", () => {
    const required = VERIFIED_TABLES.filter((entry) => entry.required).map((entry) => entry.table);
    expect(required).toEqual([
      "payments",
      "payment_intents",
      "payment_ledger",
      "sessions",
      "exec_requests",
      "reservations",
    ]);
    // The exact truncate list the contract uses, so nothing it wipes is skipped
    // silently. challenge_nonces and payer_budgets are optional: they arrive at
    // v13 and v14, and an older dump is still restorable.
    const all = VERIFIED_TABLES.map((entry) => entry.table);
    expect(all).toContain("challenge_nonces");
    expect(all).toContain("payer_budgets");
  });

  it("quotes identifiers so a name cannot change the statement", () => {
    expect(quoteIdent("exec_requests")).toBe('"exec_requests"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    // A table name from the catalog is never a value, but quoting is what makes
    // that true even if one ever is.
    expect(quoteIdent("x; DROP TABLE payments")).toBe('"x; DROP TABLE payments"');
  });

  it("hashes the row as Postgres renders it, with NULL distinguishable from empty", () => {
    expect(rowExpression(["id", "state"])).toBe('ROW("id", "state")::text');
    // ROW(...)::text writes NULL as an empty field and quotes an empty string,
    // so (a,,b) and (a,"",b) do not collide.
    expect(rowExpression(["id"])).toBe('ROW("id")::text');
  });

  it("orders by the whole primary key, with a C collation on text keys", () => {
    // exec_requests is (session_id, id): ordering on the first column alone
    // would leave rows interchangeable between two databases.
    expect(
      orderExpression(["session_id", "id"], ["id", "session_id"], {
        session_id: "text",
        id: "text",
      }),
    ).toBe('t."session_id" COLLATE "C", t."id" COLLATE "C"');

    // A non-text key must not get a collation clause.
    expect(orderExpression(["created_at"], ["created_at"], { created_at: "int8" })).toBe(
      't."created_at"',
    );

    // No primary key: order by the rendered row, which is still deterministic.
    expect(orderExpression([], ["id", "state"], {})).toBe('ROW("id", "state")::text COLLATE "C"');
  });

  it("builds one statement that returns the count and the hash", () => {
    const sql = fingerprintQuery("exec_requests", {
      columns: ["id", "session_id"],
      primaryKey: ["session_id", "id"],
      types: { id: "text", session_id: "text" },
    });
    expect(sql).toContain('count(*)::bigint AS n');
    expect(sql).toContain('string_agg(md5(ROW("id", "session_id")::text)');
    expect(sql).toContain('ORDER BY t."session_id" COLLATE "C", t."id" COLLATE "C"');
    expect(sql).toContain('FROM "exec_requests" AS t');
    // A zero-row table must still produce a hash, not NULL.
    expect(sql).toContain("coalesce(");
  });

  it("folds the tables into a total that does not depend on iteration order", () => {
    const sessions = { table: "sessions", rows: 2, fp: "bbbb" };
    const payments = { table: "payments", rows: 3, fp: "aaaa" };
    const entries = [sessions, payments];
    const total = totalFingerprint(entries);
    expect(total).toEqual(totalFingerprint([payments, sessions]));
    expect(total.rows).toBe(5);
    expect(total.fp).toMatch(/^[0-9a-f]{32}$/);

    // Any row, any hash, any table: the total moves.
    expect(totalFingerprint([{ ...sessions, rows: 1 }, payments]).fp).not.toBe(total.fp);
    expect(totalFingerprint([sessions, { ...payments, fp: "aaab" }]).fp).not.toBe(total.fp);
    expect(totalFingerprint([{ ...sessions, rows: 0 }]).fp).not.toBe(total.fp);
  });

  it("names the table and both values when they differ", () => {
    const source = { rows: 4, fp: "5f4dcc3b" };
    const copy = { rows: 3, fp: "d41d8cd9" };
    expect(differenceOf("payments", source, source)).toBeNull();

    const message = differenceOf("payments", source, copy);
    expect(message).toContain("payments");
    expect(message).toContain("rows=4");
    expect(message).toContain("rows=3");
    expect(message).toContain("5f4dcc3b");
    expect(message).toContain("d41d8cd9");

    // Same count, different content: the hash is what catches it.
    expect(differenceOf("sessions", { rows: 1, fp: "aa" }, { rows: 1, fp: "bb" })).toContain("bb");
  });

  it("describes a connection without leaking the password", () => {
    const url = "postgres://postgres:s3cret@127.0.0.1:5453/sandbox";
    expect(describeUrl(url)).toBe("127.0.0.1:5453/sandbox");
    expect(describeUrl(url)).not.toContain("s3cret");
  });
});
