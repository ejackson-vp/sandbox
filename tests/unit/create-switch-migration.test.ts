/**
 * Schema v21: the create kill switch table.
 *
 * The ladder is additive and replayed by every writer open, and the money rule
 * is that a version bump must never recreate a money table. This pins the step
 * the two ways an operator hits it:
 *
 *  - a brand-new database (v0) ends at v21 with the switch table present and no
 *    row, which is the "creates are admitted" state;
 *  - a populated v20 database gains the table without losing a settled payment,
 *    a ledger row or a live session.
 *
 * The database is this file's own namespace and is opened directly, not through
 * the tracked `freshStore`, because the point is the ladder from an empty
 * database rather than the current schema.
 */
import { afterEach, describe, expect, it } from "vitest";
import { PostgresStore } from "../../controller/src/store/postgres/store.js";
import { SCHEMA_VERSION } from "../../controller/src/store/schema-version.js";
import {
  ensureTestDatabase,
  sqlExec,
  sqlRows,
  testDatabaseUrl,
} from "../helpers/test-store.js";

const NS = "create-switch-migrate";
const SESSION_ID = `sbx_${"c".repeat(24)}`;
const PAYMENT_KEY = "f".repeat(64);
const NOW = Date.now();

/** Every table in `public`, dropped so the next open starts at v0. */
async function emptyDatabase(): Promise<void> {
  await ensureTestDatabase(NS);
  const tables = await sqlRows<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    [],
    NS,
  );
  if (tables.length === 0) return;
  const names = tables.map((row) => `"${row.tablename}"`).join(", ");
  await sqlExec(`DROP TABLE ${names} CASCADE`, [], NS);
}

async function schemaVersion(): Promise<number> {
  const rows = await sqlRows<{ version: number }>("SELECT version FROM sandbox_schema", [], NS);
  return Number(rows[0]?.version);
}

async function tableExists(name: string): Promise<boolean> {
  const rows = await sqlRows(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
    [name],
    NS,
  );
  return rows.length > 0;
}

/**
 * Throwaway tables are not kept between tests here; each one opens and closes
 * its own writer, so a leaked pool would hold the advisory lock.
 */
let open: PostgresStore | null = null;
function track(store: PostgresStore): PostgresStore {
  open = store;
  return store;
}

afterEach(async () => {
  const store = open;
  open = null;
  if (store) await store.close().catch(() => undefined);
});

/** A settled payment and a live session, the rows a bump must never lose. */
async function seedLiveRows(): Promise<void> {
  await sqlExec(
    `INSERT INTO payments (payment_key, network, scheme, asset, amount, pay_to, payer, tx, mode, created_at)
     VALUES ($1, 'mock:local', 'exact', 'mock:usdc', '50000',
             '0x0000000000000000000000000000000000000402',
             '0x0000000000000000000000000000000000000001', 'mock:tx', 'mock', $2)`,
    [PAYMENT_KEY, NOW],
    NS,
  );
  await sqlExec(
    `INSERT INTO sessions (
       id, capability_hash, capability_expires_at, client_public_key, client_nonce,
       tier, duration_seconds, cpu_millis, memory_mib, disk_mib, max_output_bytes,
       max_file_bytes, max_command_seconds, max_processes, state, created_at, paid_at,
       payment_key, lease_expires_at, updated_at)
     VALUES ($1, $2, $3, 'client-public-key', 'client-nonce',
             'short', 60, 500, 512, 256, 262144, 8388608, 300, 64, 'READY', $4, $4, $5, $6, $4)`,
    [
      SESSION_ID,
      "a".repeat(64),
      NOW + 3_600_000,
      NOW,
      PAYMENT_KEY,
      NOW + 60_000,
    ],
    NS,
  );
  await sqlExec(
    `INSERT INTO payment_ledger (payment_key, session_id, payer, amount, asset, network, mode, status, created_at, updated_at)
     VALUES ($1, $2, '0x0000000000000000000000000000000000000001', '50000',
             'mock:usdc', 'mock:local', 'mock', 'SETTLED', $3, $3)`,
    [PAYMENT_KEY, SESSION_ID, NOW],
    NS,
  );
}

describe("create switch migration (v21)", () => {
  it("migrates a fresh v0 database all the way to v21", async () => {
    await emptyDatabase();
    expect(await tableExists("sessions")).toBe(false);

    const store = track(await PostgresStore.open(testDatabaseUrl(NS)));

    expect(await schemaVersion()).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(21);
    expect(await tableExists("create_switch")).toBe(true);
    // A fresh database has no row: no operator has flipped it, creates are on.
    await expect(store.readCreateSwitch(Date.now())).resolves.toMatchObject({
      enabled: false,
      changedAt: null,
    });
    // And it is writeable: the installation can stop creates before its first
    // real one.
    await expect(
      store.writeCreateSwitch({ enabled: true, reason: "drill", actor: "eric", until: null }, Date.now()),
    ).resolves.toMatchObject({ ok: true, state: { enabled: true, reason: "drill" } });
  });

  it("upgrades a populated v20 database without losing money or sessions", async () => {
    await emptyDatabase();
    const first = track(await PostgresStore.open(testDatabaseUrl(NS)));
    await seedLiveRows();
    // Recreate the v20 shape: the switch table is gone and the version says 20.
    await first.close();
    await sqlExec("DROP TABLE create_switch", [], NS);
    await sqlExec(`UPDATE sandbox_schema SET version = 20`, [], NS);
    expect(await tableExists("create_switch")).toBe(false);

    const upgraded = track(await PostgresStore.open(testDatabaseUrl(NS)));

    expect(await schemaVersion()).toBe(21);
    expect(await tableExists("create_switch")).toBe(true);
    // The rows the ladder must never touch are still there, and still live.
    const session = await upgraded.getSession(SESSION_ID);
    expect(session).toMatchObject({ id: SESSION_ID, state: "READY", paymentKey: PAYMENT_KEY });
    const ledger = await sqlRows<{ status: string; amount: string }>(
      "SELECT status, amount FROM payment_ledger WHERE payment_key = $1",
      [PAYMENT_KEY],
      NS,
    );
    expect(ledger).toEqual([{ status: "SETTLED", amount: "50000" }]);
    // The upgrade does not invent a switch: an existing installation is open for
    // business until an operator says otherwise.
    await expect(upgraded.readCreateSwitch(Date.now())).resolves.toMatchObject({ enabled: false });
  });
});
