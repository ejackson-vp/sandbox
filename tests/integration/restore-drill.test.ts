/**
 * The restore drill.
 *
 * `docs/backup-restore.md` says a restore is verified by running the store
 * contract suite against the restored database. Until this file existed, no test
 * in `tests/` had ever restored anything, so the documented RPO was a sentence
 * rather than evidence.
 *
 * The drill seeds a source database with the rows that decide whether a restore
 * is usable, copies it the way a restore produces a copy, and asserts the
 * invariants against the copy:
 *
 *   1. the settled payment is still there and its key still trips the UNIQUE
 *      constraint, so a replay cannot charge twice;
 *   2. the ledger rows match column for column, refund bookkeeping included;
 *   3. a session interrupted mid-operation finishes that operation, while the
 *      spent request id and the state guards still refuse a stale write;
 *   4. the copy accepts a new settlement, so it is a primary and not a read-only
 *      curiosity.
 *
 * The copy is `CREATE DATABASE … TEMPLATE …`, taken after the source store is
 * closed. It is a server-side copy: no `pg_dump`/`pg_restore` binary, no client
 * version skew, and it works against the CI Postgres service container. What it
 * is not is a backup. WAL archiving, PITR and the object store belong to the
 * database layer (ADR 0010); this file proves the restore target behaves.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  DuplicateEntitlementError,
  type PaymentRecord,
  type SessionRecord,
} from "../../controller/src/store/models.js";
import { PostgresStore } from "../../controller/src/store/postgres/store.js";
import { limitsFor, paymentFixture, sessionFixture } from "../helpers/store-fixtures.js";
import { runId } from "../helpers/test-store.js";

/**
 * The suite harness fails the run when `DATABASE_URL` is missing. This guard is
 * belt and braces: under a config without that harness the drill skips at import
 * rather than throwing while the file is collected.
 */
const ADMIN_URL = process.env.DATABASE_URL?.trim() ?? "";

/**
 * Both names carry the run id and the pid, so two CI jobs cannot collide, and
 * both start with `sbx_test_` so the harness teardown drops a leaked one.
 */
const SUFFIX = `${runId()}_${process.pid}_${randomBytes(4).toString("hex")}`;
const SOURCE_DB = `sbx_test_restore_src_${SUFFIX}`;
const TARGET_DB = `sbx_test_restore_dst_${SUFFIX}`;

const PAYER = `0x${"a".repeat(40)}`;
const SPEC_HASH = "f".repeat(64);
const PAYLOAD_HASH = "b".repeat(64);
const CLIENT_PUBLIC_KEY = "restore-client-public-key";
const OP_REQUEST = "restore-op-1";

const KEY = {
  settled: `0x${"1".repeat(64)}`,
  running: `0x${"2".repeat(64)}`,
  duplicate: `0x${"3".repeat(64)}`,
  unclaimed: `0x${"4".repeat(64)}`,
  fresh: `0x${"5".repeat(64)}`,
} as const;

const SETTLED_SESSION = `sbx_${"1".repeat(24)}`;
const RUNNING_SESSION = `sbx_${"2".repeat(24)}`;
const DUPLICATE_SESSION = `sbx_${"3".repeat(24)}`;
const FRESH_SESSION = `sbx_${"4".repeat(24)}`;

const TABLES = [
  "payments",
  "payment_intents",
  "payment_ledger",
  "sessions",
  "exec_requests",
] as const;
type Table = (typeof TABLES)[number];

interface Snapshot {
  schemaVersion: number;
  rows: Record<Table, pg.QueryResultRow[]>;
}

function urlFor(database: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

async function withClient<T>(
  connectionString: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Every row of every table that matters, plus the schema version. */
async function snapshot(database: string): Promise<Snapshot> {
  return withClient(urlFor(database), async (client) => {
    const version = await client.query<{ version: number }>(
      "SELECT version FROM sandbox_schema LIMIT 1",
    );
    const rows = {} as Record<Table, pg.QueryResultRow[]>;
    for (const table of TABLES) {
      // `ORDER BY 1` is a primary key on every table here, so two copies holding
      // the same rows compare equal without a per-table sort key.
      const res = await client.query(`SELECT * FROM ${table} ORDER BY 1`);
      rows[table] = res.rows;
    }
    return { schemaVersion: Number(version.rows[0]?.version ?? 0), rows };
  });
}

async function createDatabase(database: string): Promise<void> {
  await withClient(ADMIN_URL, async (client) => {
    await client.query(`CREATE DATABASE "${database}"`);
  });
}

/**
 * Server-side logical copy.
 *
 * `TEMPLATE` refuses while the template database has a session, and its one
 * failure mode here is a connection this test forgot to close. That is a bug in
 * the drill, not a reason to shell out to `pg_dump`.
 */
async function copyDatabase(source: string, target: string): Promise<void> {
  await withClient(ADMIN_URL, async (client) => {
    try {
      await client.query(`CREATE DATABASE "${target}" TEMPLATE "${source}"`);
    } catch (err) {
      throw new Error(
        `could not copy "${source}" to "${target}": ${(err as Error).message}. The drill closes ` +
          "the source store before copying, so a live connection to the template is a bug here.",
      );
    }
  });
}

async function dropDatabase(database: string): Promise<void> {
  await withClient(ADMIN_URL, async (client) => {
    // FORCE disconnects a pool this run leaked; the name is unique per run, so
    // it cannot reach another job's database.
    await client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  });
}

function paymentRecord(paymentKey: string): PaymentRecord {
  return paymentFixture({
    paymentKey,
    network: "eip155:84532",
    payer: PAYER,
    transaction: `mock:tx:${paymentKey.slice(-4)}`,
    settlementNonce: `nonce-${paymentKey.slice(-4)}`,
  });
}

function sessionRecord(id: string, paymentKey: string, clientNonce: string): SessionRecord {
  return sessionFixture({
    id,
    paymentKey,
    clientPublicKey: CLIENT_PUBLIC_KEY,
    clientNonce,
    tier: "standard",
    durationSeconds: 300,
    limits: limitsFor("integration"),
    runtime: "base",
  });
}

/** Claim then settle, exactly as the control API does. */
async function settle(
  store: PostgresStore,
  paymentKey: string,
  session: SessionRecord,
): Promise<void> {
  const claim = await store.claimPaymentIntent(paymentKey, SPEC_HASH, 30_000);
  if (claim.status !== "claimed") throw new Error(`seed claim for ${paymentKey} was ${claim.status}`);
  const settled = await store.completeEntitlement(
    paymentKey,
    claim.token,
    paymentRecord(paymentKey),
    session,
  );
  if (!settled.created) throw new Error(`seed settle for ${paymentKey} created no session`);
}

/**
 * The slice a restore has to bring back: money that settled, money that was
 * refunded, an unclaimed refund still waiting, and a session that was halfway
 * through an operation when the copy was taken.
 */
async function seedSource(): Promise<void> {
  const store = await PostgresStore.open(urlFor(SOURCE_DB), { writer: true });
  try {
    // A settled payment whose session has since run to a terminal state.
    await settle(store, KEY.settled, sessionRecord(SETTLED_SESSION, KEY.settled, "nonce-settled"));
    if (!(await store.requestTermination(SETTLED_SESSION, "client_destroy"))) {
      throw new Error("seed termination was refused");
    }
    if ((await store.finalizeTermination(SETTLED_SESSION)) !== "DESTROYED") {
      throw new Error("seed finalize was refused");
    }

    // A live session interrupted mid-operation: READY -> ACTIVE, with a pending
    // exec_request holding the single-operation gate.
    await settle(store, KEY.running, sessionRecord(RUNNING_SESSION, KEY.running, "nonce-running"));
    if (!(await store.setProvisioning(RUNNING_SESSION, `pod-${RUNNING_SESSION}`))) {
      throw new Error("seed setProvisioning was refused");
    }
    await store.setRelayToken(RUNNING_SESSION, `relay-${RUNNING_SESSION}`);
    if (
      !(await store.setReady(RUNNING_SESSION, Date.now(), Date.now() + 60_000, "{}", "guest-key"))
    ) {
      throw new Error("seed setReady was refused");
    }
    const claimed = await store.claimOperation(RUNNING_SESSION, OP_REQUEST, "exec", PAYLOAD_HASH);
    if (!claimed.ok) throw new Error(`seed operation claim was ${claimed.code}`);

    // A duplicate client key pair: charged, refunded, intent failed.
    const duplicate = await store.claimPaymentIntent(KEY.duplicate, SPEC_HASH, 30_000);
    if (duplicate.status !== "claimed") {
      throw new Error(`seed duplicate claim was ${duplicate.status}`);
    }
    await expect(
      store.completeEntitlement(
        KEY.duplicate,
        duplicate.token,
        paymentRecord(KEY.duplicate),
        // The same pair as the settled session, which is what makes it a duplicate.
        sessionRecord(DUPLICATE_SESSION, KEY.duplicate, "nonce-settled"),
      ),
    ).rejects.toThrow(DuplicateEntitlementError);

    // An unclaimed refund: the row the worker's backoff and claim columns are for.
    const unclaimed = await store.insertUnclaimedLedger({
      paymentKey: KEY.unclaimed,
      sessionId: `unsettled:${KEY.unclaimed}`,
      payer: PAYER,
      amount: "50000",
      asset: "mock:usdc",
      network: "eip155:84532",
      mode: "mock",
      status: "REFUND_PENDING",
      reason: "unsettled",
      settlementNonce: "nonce-unclaimed",
    });
    if (!unclaimed) throw new Error("seed insertUnclaimedLedger wrote no row");
  } finally {
    // Closed before the copy: TEMPLATE refuses while the source has a session.
    await store.close();
  }
}

describe.skipIf(ADMIN_URL === "")("restore drill", () => {
  let source: Snapshot;
  let restored: PostgresStore | null = null;

  function target(): PostgresStore {
    if (!restored) throw new Error("the restore drill's target store is not open");
    return restored;
  }

  beforeAll(async () => {
    await createDatabase(SOURCE_DB);
    await seedSource();
    source = await snapshot(SOURCE_DB);
    await copyDatabase(SOURCE_DB, TARGET_DB);
    // Opening as the writer is part of the drill: a restored database that
    // cannot take the writer lock and the schema ladder is not a primary.
    restored = await PostgresStore.open(urlFor(TARGET_DB), { writer: true });
  });

  afterAll(async () => {
    if (restored) await restored.close().catch(() => undefined);
    restored = null;
    await dropDatabase(TARGET_DB);
    await dropDatabase(SOURCE_DB);
  });

  it("copies every money and lifecycle row, and the copy is not empty", async () => {
    const copy = await snapshot(TARGET_DB);
    expect(copy.schemaVersion).toBe(source.schemaVersion);
    expect(copy.schemaVersion).toBeGreaterThan(0);

    // A copy that silently produced an empty database would equal an empty
    // source, so the seed's shape is asserted before the comparison.
    expect(copy.rows.payments).toHaveLength(3);
    expect(copy.rows.payment_intents).toHaveLength(3);
    expect(copy.rows.payment_ledger).toHaveLength(4);
    expect(copy.rows.sessions).toHaveLength(2);
    expect(copy.rows.exec_requests).toHaveLength(1);

    // Every column of every row, which is what "the ledger matches" means.
    for (const table of TABLES) expect(copy.rows[table]).toEqual(source.rows[table]);

    expect(await target().healthCheck()).toMatchObject({
      ok: true,
      schemaVersion: source.schemaVersion,
    });
  });

  it("keeps the settled payment and still refuses its key", async () => {
    const payment = await target().getPayment(KEY.settled);
    expect(payment).toMatchObject({
      paymentKey: KEY.settled,
      amount: "50000",
      asset: "mock:usdc",
      payer: PAYER,
      transaction: `mock:tx:${KEY.settled.slice(-4)}`,
      mode: "mock",
    });
    expect(await target().getLedgerByPayment(KEY.settled)).toMatchObject({
      status: "SETTLED",
      sessionId: SETTLED_SESSION,
    });

    // A replay of the outbox answer: settled means the session it paid for, not
    // a second charge.
    expect(await target().claimPaymentIntent(KEY.settled, SPEC_HASH, 30_000)).toEqual({
      status: "settled",
      sessionId: SETTLED_SESSION,
    });
    // The spec hash is part of the record too, so a different request for the
    // same payment key is a mismatch rather than a claim.
    expect(await target().claimPaymentIntent(KEY.settled, "0".repeat(64), 30_000)).toEqual({
      status: "mismatch",
    });

    // The constraint behind both answers survived the copy.
    await expect(
      withClient(urlFor(TARGET_DB), (client) =>
        client.query(
          `INSERT INTO payments
             (payment_key, network, scheme, asset, amount, pay_to, payer, tx, mode, created_at)
           VALUES ($1, 'eip155:84532', 'exact', 'mock:usdc', '50000', $2, NULL, 'mock:tx:replay',
                   'mock', 0)`,
          [KEY.settled, `0x${"a".repeat(40)}`],
        ),
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "payments_pkey" });
  });

  it("resumes the interrupted session and still refuses stale writes", async () => {
    expect(await target().getSession(RUNNING_SESSION)).toMatchObject({
      state: "ACTIVE",
      activeRequestId: OP_REQUEST,
      relayTokenHash: `relay-${RUNNING_SESSION}`,
    });
    expect(await target().getExecRequest(RUNNING_SESSION, OP_REQUEST)).toMatchObject({
      state: "pending",
      op: "exec",
      payloadHash: PAYLOAD_HASH,
    });

    // The conditional transition succeeds: finishing the operation releases the
    // gate and returns the session to READY.
    await target().finishOperation(RUNNING_SESSION, OP_REQUEST, "done", "c2VhbGVk");
    expect(await target().getSession(RUNNING_SESSION)).toMatchObject({
      state: "READY",
      activeRequestId: null,
    });
    expect(await target().getExecRequest(RUNNING_SESSION, OP_REQUEST)).toMatchObject({
      state: "done",
      resultEnvelope: "c2VhbGVk",
    });

    // The stale guard still refuses: the request id is spent, so a replay is a
    // duplicate and never a second execution.
    expect(
      await target().claimOperation(RUNNING_SESSION, OP_REQUEST, "exec", PAYLOAD_HASH),
    ).toMatchObject({ ok: false, code: "duplicate" });
    // And the state guards still refuse the transitions a READY row cannot take.
    expect(await target().setProvisioning(RUNNING_SESSION, "pod-after-restore")).toBe(false);
    expect(
      await target().setReady(RUNNING_SESSION, Date.now(), Date.now() + 60_000, "{}", "guest-key"),
    ).toBe(false);
    expect(await target().finalizeTermination(RUNNING_SESSION)).toBeNull();

    // The rest of the lifecycle runs on the copy.
    expect(await target().requestTermination(RUNNING_SESSION, "client_destroy")).toBe(true);
    expect(await target().finalizeTermination(RUNNING_SESSION)).toBe("DESTROYED");
  });

  it("keeps the refund ledger rows as they were", async () => {
    expect(await target().getLedgerByPayment(KEY.duplicate)).toMatchObject({
      status: "REFUNDED",
      reason: "duplicate_client_nonce",
      sessionId: `duplicate:${KEY.duplicate}`,
      refundTransaction: expect.stringMatching(/^mock:refund:/),
    });
    expect(await target().getLedgerByPayment(KEY.unclaimed)).toMatchObject({
      status: "REFUND_PENDING",
      reason: "unsettled",
      sessionId: `unsettled:${KEY.unclaimed}`,
      refundAttempts: 0,
      refundNextAttemptAt: null,
    });
    expect((await target().getLedgerBySession(RUNNING_SESSION))?.status).toBe("SETTLED");
    expect((await target().getLedgerBySession(SETTLED_SESSION))?.status).toBe("SETTLED");
  });

  it("accepts a new settlement, so the copy is a primary", async () => {
    await settle(
      target(),
      KEY.fresh,
      sessionRecord(FRESH_SESSION, KEY.fresh, "nonce-after-restore"),
    );
    expect(await target().getPayment(KEY.fresh)).not.toBeNull();
    expect((await target().getLedgerBySession(FRESH_SESSION))?.status).toBe("SETTLED");
    expect(await target().getSession(FRESH_SESSION)).toMatchObject({ state: "PAID" });
  });
});
