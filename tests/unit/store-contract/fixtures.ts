/**
 * Fixtures and the backend seam for the store contract suite.
 *
 * The suite is one file of assertions run twice: once over SQLite, once over
 * Postgres. Everything that differs between them (how a store is opened, how a
 * clean database is produced, whether two "stores" are two connections or one
 * pool) sits behind `ContractBackend`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { Store } from "../../../controller/src/store.js";
import { PostgresStore } from "../../../controller/src/store/postgres/store.js";
import type { StoreBackend } from "../../../controller/src/store/backend.js";
import type { PaymentRecord, SessionRecord } from "../../../controller/src/store/models.js";
import type { CapacitySnapshot, SandboxResourceRequest } from "../../../controller/src/capacity/types.js";
import { limitsFor, paymentFixture, sessionFixture } from "../../helpers/store-fixtures.js";

export interface ContractBackend {
  readonly label: string;
  /** A writable store. Repeated calls may return the same instance (Postgres). */
  open(): Promise<StoreBackend>;
  /** Remove every row so the next test starts clean. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

const MiB = 1024 * 1024;

export function paymentRecord(paymentKey: string, payer = "0xabc"): PaymentRecord {
  return paymentFixture({
    paymentKey,
    network: "eip155:84532",
    payer,
    transaction: "mock:tx",
  });
}

export function sessionRecord(
  id: string,
  payment: string,
  clientNonce = `nonce-${id}`,
): SessionRecord {
  return sessionFixture({
    id,
    paymentKey: payment,
    clientPublicKey: "pk-shared",
    clientNonce,
    tier: "standard",
    durationSeconds: 300,
    limits: limitsFor("unit"),
    runtime: "base",
  });
}

export function capacitySnapshot(now = Date.now()): CapacitySnapshot {
  return {
    nodes: [
      {
        id: "node-a",
        allocatable: {
          cpuMillicores: 1_000,
          memoryBytes: 2_048 * MiB,
          storageBytes: 10_240 * MiB,
        },
        platformOverhead: { cpuMillicores: 0, memoryBytes: 0, storageBytes: 0 },
        labels: { "x402.io/sandbox-pool": "true" },
        taints: [],
        ready: true,
        schedulable: true,
      },
    ],
    reservations: [],
    now,
    accounting: "baseline",
  };
}

export const RESOURCE_REQUEST: SandboxResourceRequest = {
  baseline: { cpuMillicores: 1_000, memoryBytes: 512 * MiB, storageBytes: 1_024 * MiB },
  peak: { cpuMillicores: 1_000, memoryBytes: 512 * MiB, storageBytes: 1_024 * MiB },
};

/** Claim then settle, exactly as the control API does. */
export async function seedSession(
  store: StoreBackend,
  id: string,
  paymentKey: string,
  clientNonce?: string,
): Promise<void> {
  const claim = await store.claimPaymentIntent(paymentKey, "a".repeat(64), 30_000);
  if (claim.status !== "claimed") throw new Error(`seed claim was ${claim.status}`);
  await store.completeEntitlement(
    paymentKey,
    claim.token,
    paymentRecord(paymentKey),
    sessionRecord(id, paymentKey, clientNonce),
  );
}

/** Drive a seeded session from PAID to READY. */
export async function seedReadySession(
  store: StoreBackend,
  id: string,
  paymentKey: string,
  clientNonce?: string,
): Promise<void> {
  await seedSession(store, id, paymentKey, clientNonce);
  if (!(await store.setProvisioning(id, `pod-${id}`))) throw new Error("setProvisioning refused");
  await store.setRelayToken(id, `relay-${id}`);
  if (!(await store.setReady(id, Date.now(), Date.now() + 60_000, "{}", "guest-key"))) {
    throw new Error("setReady refused");
  }
}

/** SQLite: a fresh database file per test, two connections when concurrency asks. */
export function sqliteBackend(): ContractBackend {
  let dir: string | null = null;
  let path: string | null = null;
  const opened: Store[] = [];

  return {
    label: "sqlite",
    async open() {
      if (!path) {
        dir = mkdtempSync(join(tmpdir(), "x402-contract-"));
        path = join(dir, "controller.db");
      }
      const store = new Store(path);
      opened.push(store);
      return store;
    },
    async reset() {
      for (const store of opened.splice(0)) store.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = null;
      path = null;
    },
    async close() {
      for (const store of opened.splice(0)) store.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = null;
      path = null;
    },
  };
}

/**
 * Postgres: one writer store per run, one pool. Two concurrent calls really are
 * two connections, which is the concurrency this suite needs; a second
 * `PostgresStore` could not be a writer (that is the advisory lock, proved
 * separately in `store-contract-postgres.test.ts`).
 */
export function postgresBackend(url: string): ContractBackend {
  let store: PostgresStore | null = null;
  let admin: pg.Client | null = null;

  const connect = async (): Promise<pg.Client> => {
    admin ??= await (async () => {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      return client;
    })();
    return admin;
  };

  return {
    label: "postgres",
    async open() {
      store ??= await PostgresStore.open(url, { writer: true, max: 10 });
      return store;
    },
    async reset() {
      // Open first so the schema exists: a run against a brand-new database must
      // not depend on a previous test having migrated it.
      store ??= await PostgresStore.open(url, { writer: true, max: 10 });
      // One statement so the sessions -> payments foreign key is satisfied.
      await (
        await connect()
      ).query(
        "TRUNCATE payments, payment_intents, payment_ledger, challenge_nonces, payer_budgets, sessions, reservations, exec_requests",
      );
    },
    async close() {
      await store?.close();
      store = null;
      if (admin) {
        await admin.end();
        admin = null;
      }
    },
  };
}
