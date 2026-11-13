/**
 * Property tests against the real control API payment routes.
 *
 * The payment routes are the controller's money surface: the API calls them
 * with untrusted-ish JSON on the create path, and an operator calls them with
 * whatever a runbook says. Three things must hold for every input. Nothing is
 * served without the admin token. No parsed body, path segment or query value
 * reaches a 5xx: the route answers with a named status instead of throwing out
 * of the express handler. And an intent the store has never seen is a 404/409
 * answer, never an error.
 *
 * The router is the real `createControlApi`, so the auth middleware, body
 * parser and error backstop are the production ones. The store is the real
 * Postgres adapter; only capacity refuses, which is what lets a fully valid
 * completion stop at a controlled 409 without a cluster.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fuzzSeed } from "./seeds.js";
import { resolveSessionSpec, specHash } from "@x402s/shared/payment";
import { createControlApi } from "../../controller/src/control-api.js";
import { loadControllerConfig } from "../../controller/src/config.js";
import type { CapacityService } from "../../controller/src/capacity/service.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import { freshStore, sqlExec, testDatabaseUrl } from "../helpers/test-store.js";

const ADMIN = "fuzz-admin-token-0123456789";
const RELAY_ADMIN = "r".repeat(24);
const CLIENT_KEY = "p".repeat(44);
const CLIENT_NONCE = "n".repeat(44);

const SEEDED_KEY = "a".repeat(64);
const MISMATCH_KEY = "b".repeat(64);
const CAPACITY_KEY = "d".repeat(64);
const FAILED_KEY = "e".repeat(64);
const REFUND_KEY = "f".repeat(64);
const ADMIT_KEY = "7".repeat(64);
const DUPLICATE_KEY = "5".repeat(64);
const SETTLED_LEDGER_KEY = "6".repeat(64);
const SEEDED_KEYS = new Set([
  SEEDED_KEY,
  MISMATCH_KEY,
  CAPACITY_KEY,
  FAILED_KEY,
  REFUND_KEY,
  ADMIT_KEY,
  DUPLICATE_KEY,
  SETTLED_LEDGER_KEY,
]);
const WRONG_HASH = "c".repeat(64);
const UNKNOWN_KEY = "9".repeat(64);

const cfg = loadControllerConfig({
  ADMIN_TOKEN: ADMIN,
  ROLE: "controller",
  KUBERNETES_ENABLED: "false",
  RELAY_ADMIN_TOKEN: RELAY_ADMIN,
  WAKE_TOKEN: "w".repeat(24),
  PROXY_TOKEN_SECRET: "p".repeat(24),
  DATABASE_URL: testDatabaseUrl("fuzz"),
});

/** The spec a standard create resolves to, built by the same code the route uses. */
const resolution = resolveSessionSpec(
  { tier: "standard", clientPublicKey: CLIENT_KEY, clientNonce: CLIENT_NONCE },
  cfg.tiers,
  cfg.platformLimits,
);
if (!resolution.ok) throw new Error(`standard spec did not resolve: ${resolution.code}`);
const STANDARD_SPEC = resolution.spec;
const STANDARD_HASH = specHash(STANDARD_SPEC);

/** Every completion body that passes the schema, so a test varies one fence. */
function completeBody(
  paymentKey: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    claimToken: "0".repeat(32),
    sessionId: `sbx_${"1".repeat(24)}`,
    capabilityHash: "f".repeat(64),
    capabilityExpiresAt: Date.now() + 600_000,
    spec: STANDARD_SPEC,
    clientPublicKey: CLIENT_KEY,
    clientNonce: CLIENT_NONCE,
    payment: {
      paymentKey,
      network: "mock:local",
      scheme: "exact",
      asset: "mock:usdc",
      amount: "50000",
      payTo: "0x0000000000000000000000000000000000000402",
      mode: "mock",
    },
    ...overrides,
  };
}

/**
 * Capacity refuses every payment except the two that are meant to reach the
 * store. The refusal is what lets a fully valid completion stop at a controlled
 * 409; the exceptions are what let a completion and a duplicate run the real
 * settle path.
 */
const ADMITTED = new Set([ADMIT_KEY, DUPLICATE_KEY]);
const capacity = {
  attach: async (paymentKey: string) =>
    ADMITTED.has(paymentKey)
      ? { admitted: true as const, nodeId: "node-fuzz", reservation: { nodeId: "node-fuzz" } }
      : {
          admitted: false as const,
          reason: "no_capacity",
          retryable: true,
          requested: { cpuMillicores: 1, memoryBytes: 1, storageBytes: 1 },
        },
} as unknown as CapacityService;

interface Answer {
  status: number;
  json: boolean;
  body: Record<string, unknown> | undefined;
}

const servers: Server[] = [];

let base: string;
let store: PostgresStore;
const tokens = new Map<string, string>();

beforeAll(async () => {
  store = await freshStore({ namespace: "fuzz" });

  // Seed the intent states the routes answer differently. Each claim is a real
  // store write, so the route is reading a row, not a stub.
  const seeded = await store.claimPaymentIntent(SEEDED_KEY, STANDARD_HASH, 30_000);
  if (seeded.status !== "claimed") throw new Error(`seed claim: ${seeded.status}`);
  tokens.set(SEEDED_KEY, seeded.token);

  const mismatch = await store.claimPaymentIntent(MISMATCH_KEY, WRONG_HASH, 30_000);
  if (mismatch.status !== "claimed") throw new Error(`mismatch claim: ${mismatch.status}`);
  tokens.set(MISMATCH_KEY, mismatch.token);

  const capacityClaim = await store.claimPaymentIntent(CAPACITY_KEY, STANDARD_HASH, 30_000);
  if (capacityClaim.status !== "claimed") throw new Error(`capacity claim: ${capacityClaim.status}`);
  tokens.set(CAPACITY_KEY, capacityClaim.token);

  const failed = await store.claimPaymentIntent(FAILED_KEY, STANDARD_HASH, 30_000);
  if (failed.status !== "claimed") throw new Error(`failed claim: ${failed.status}`);
  await store.failPaymentIntent(FAILED_KEY, "settlement_refused");

  const app = createControlApi({
    cfg,
    store,
    relay: {} as RelayClient,
    capacity,
  });
  const server = http.createServer(app);
  servers.push(server);
  base = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
});

afterAll(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function call(
  path: string,
  init: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = init.token === undefined ? ADMIN : init.token;
  if (token !== null) headers["x-internal-token"] = token;
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "POST",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return {
    status: res.status,
    json: (res.headers.get("content-type") ?? "").includes("application/json"),
    body: parsed as Record<string, unknown> | undefined,
  };
}

/** Path-safe random identifier: a segment cannot be `.` or `..`, which fetch normalises. */
const segment = fc
  .string({ minLength: 1, maxLength: 80 })
  .filter((value) => value !== "." && value !== "..");

/**
 * JSON the parser actually hands to a route. `express.json({strict: true})`
 * refuses a top-level primitive before any handler runs, so only arrays and
 * objects can reach the code under test. (That parser refusal is answered by
 * the control API's generic backstop as a 500; the gap is reported with this
 * change rather than pinned as expected behaviour.)
 */
const parsedJson = fc.oneof(
  fc.array(fc.jsonValue(), { maxLength: 5 }),
  fc.dictionary(fc.string({ maxLength: 8 }), fc.jsonValue(), { maxKeys: 5 }),
);

const intentPath = (key: string, suffix = ""): string =>
  `/internal/payment-intents/${encodeURIComponent(key)}${suffix}`;

/** The ledger is keyed separately from the intent outbox. */
const ledgerPath = (key: string, suffix = ""): string =>
  `/internal/payments/${encodeURIComponent(key)}${suffix}`;

describe("control API payment routes", () => {
  it("serves nothing without the admin token", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 64 }), async (token) => {
        fc.pre(token !== ADMIN);
        const claim = await call("/internal/payment-intents/claim", {
          body: { paymentKey: SEEDED_KEY, specHash: STANDARD_HASH },
          token,
        });
        expect(claim.status).toBe(401);
        expect(claim.body).toMatchObject({ error: "unauthorized" });
      }),
      { numRuns: 60, ...fuzzSeed },
    );

    // Every route on the surface, with no credential at all.
    for (const path of [
      "/internal/payment-intents/claim",
      intentPath(SEEDED_KEY),
      intentPath(SEEDED_KEY, "/complete"),
      intentPath(SEEDED_KEY, "/fail"),
      "/internal/payments",
      "/internal/payments/by-nonce/0x0",
      ledgerPath(SEEDED_KEY, "/refund"),
    ]) {
      const res = await call(path, { body: {}, token: null });
      expect(res.status).toBe(401);
    }
  });

  it("answers arbitrary JSON on every write route with a 4xx, never a 5xx", async () => {
    await fc.assert(
      fc.asyncProperty(parsedJson, async (body) => {
        const answers = await Promise.all([
          call("/internal/payment-intents/claim", { body }),
          call(intentPath(SEEDED_KEY, "/complete"), { body }),
          // Fail an intent that does not exist: the route still answers, and a
          // property cannot disturb the seeded states the later tests read.
          call(intentPath(UNKNOWN_KEY, "/fail"), { body }),
          call("/internal/challenge-nonces", { body }),
          call(`/internal/challenge-nonces/cn_${"0".repeat(32)}/burn`, { body }),
          call("/internal/budgets/reserve", { body }),
        ]);
        for (const res of answers) {
          expect(res.status).toBeGreaterThanOrEqual(200);
          expect(res.status).toBeLessThan(500);
          expect(res.json).toBe(true);
        }
      }),
      { numRuns: 60, ...fuzzSeed },
    );

    // The mint route ignores its body entirely, so it always answers 201.
    const minted = await call("/internal/challenge-nonces", { body: { junk: true } });
    expect(minted.status).toBe(201);
    expect(String(minted.body?.nonce)).toMatch(/^cn_[0-9a-f]{32}$/);
  });

  it("answers a payment key it has never seen with a 404, not a throw", async () => {
    await fc.assert(
      fc.asyncProperty(segment, async (key) => {
        fc.pre(!SEEDED_KEYS.has(key));
        const res = await call(intentPath(key), { method: "GET" });
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({ error: "not_found" });
      }),
      { numRuns: 80, ...fuzzSeed },
    );
  });

  it("refuses a completion for an unclaimed intent with 409", async () => {
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[0-9a-f]{64}$/), async (key) => {
        fc.pre(!SEEDED_KEYS.has(key));
        const res = await call(intentPath(key, "/complete"), { body: completeBody(key) });
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ error: "intent_not_claimed" });
      }),
      { numRuns: 40, ...fuzzSeed },
    );
  });

  it("maps each intent state to its controlled answer instead of throwing", async () => {
    // A second claim of a fresh intent is a lease conflict, not an error.
    const inProgress = await call("/internal/payment-intents/claim", {
      body: { paymentKey: SEEDED_KEY, specHash: STANDARD_HASH },
    });
    expect(inProgress.status).toBe(409);
    expect(inProgress.body).toMatchObject({ status: "in_progress" });

    // The same key with a different spec hash is a mismatch.
    const mismatch = await call("/internal/payment-intents/claim", {
      body: { paymentKey: MISMATCH_KEY, specHash: STANDARD_HASH },
    });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body).toMatchObject({ status: "mismatch", error: "spec_hash_mismatch" });

    // A failed intent keeps its reason, and the API turns it into a new 402.
    const failed = await call("/internal/payment-intents/claim", {
      body: { paymentKey: FAILED_KEY, specHash: STANDARD_HASH },
    });
    expect(failed.status).toBe(409);
    expect(failed.body).toMatchObject({ status: "failed", reason: "settlement_refused" });

    // A claimed intent reads back as pending, which is the vocabulary the API
    // polls while a payment is in flight.
    const read = await call(intentPath(SEEDED_KEY), { method: "GET" });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ status: "pending" });
  });

  it("refuses a completion whose payment key disagrees with the path", async () => {
    const res = await call(intentPath(SEEDED_KEY, "/complete"), {
      body: completeBody(UNKNOWN_KEY, { claimToken: tokens.get(SEEDED_KEY) }),
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "payment_key_mismatch" });
  });

  it("refuses a completion whose claim token is not the live lease", async () => {
    const res = await call(intentPath(SEEDED_KEY, "/complete"), {
      body: completeBody(SEEDED_KEY, { claimToken: "1".repeat(32) }),
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "stale_claim" });
  });

  it("refuses a spec this controller would not have priced", async () => {
    const token = tokens.get(SEEDED_KEY);

    const notAllowed = await call(intentPath(SEEDED_KEY, "/complete"), {
      body: completeBody(SEEDED_KEY, {
        claimToken: token,
        // The tier fixes the limits, so a body that disagrees is not the spec
        // the payment was made for.
        spec: { ...STANDARD_SPEC, limits: { ...STANDARD_SPEC.limits, cpuMillis: 3_000 } },
      }),
    });
    expect(notAllowed.status).toBe(400);
    expect(notAllowed.body).toMatchObject({ error: "spec_not_allowed" });

    const invalid = await call(intentPath(SEEDED_KEY, "/complete"), {
      body: completeBody(SEEDED_KEY, {
        claimToken: token,
        spec: {
          ...STANDARD_SPEC,
          tier: "custom",
          durationSeconds: 60,
          limits: { ...STANDARD_SPEC.limits, cpuMillis: 999_999 },
        },
      }),
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ error: "invalid_cpu" });

    // The intent still binds to the hash it was claimed with.
    const mismatch = await call(intentPath(MISMATCH_KEY, "/complete"), {
      body: completeBody(MISMATCH_KEY, { claimToken: tokens.get(MISMATCH_KEY) }),
    });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body).toMatchObject({ error: "spec_hash_mismatch" });
  });

  it("stops a fully valid completion at the capacity decision", async () => {
    const res = await call(intentPath(CAPACITY_KEY, "/complete"), {
      body: completeBody(CAPACITY_KEY, { claimToken: tokens.get(CAPACITY_KEY) }),
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "capacity_unavailable", retryable: true });
  });

  it("creates one entitlement from a valid completion and answers a replay with it", async () => {
    const claimed = await call("/internal/payment-intents/claim", {
      body: { paymentKey: ADMIT_KEY, specHash: STANDARD_HASH },
    });
    expect(claimed.status).toBe(200);
    expect(claimed.body).toMatchObject({ status: "claimed", recovered: false });
    const claimToken = String(claimed.body?.token ?? "");
    expect(claimToken).toMatch(/^[0-9a-f]{32,64}$/);

    const body = completeBody(ADMIT_KEY, {
      claimToken,
      timings: { apiReceivedAt: Date.now() },
    });
    const created = await call(intentPath(ADMIT_KEY, "/complete"), { body });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ state: "PAID", created: true });
    // The view is folded in, so the API does not need a second round trip.
    expect(created.body?.session).toMatchObject({ sessionId: body.sessionId });

    // The intent is settled now: the same request is a replay of the first
    // session, not a second entitlement.
    const replay = await call(intentPath(ADMIT_KEY, "/complete"), { body });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      state: "PAID",
      created: false,
      sessionId: body.sessionId,
    });

    // A claim for a settled intent hands back the session that owns it.
    const settled = await call("/internal/payment-intents/claim", {
      body: { paymentKey: ADMIT_KEY, specHash: STANDARD_HASH },
    });
    expect(settled.status).toBe(200);
    expect(settled.body).toMatchObject({ status: "settled", sessionId: body.sessionId });
  });

  it("refuses a second payment for a client commitment that already owns a session", async () => {
    const claimed = await call("/internal/payment-intents/claim", {
      body: { paymentKey: DUPLICATE_KEY, specHash: STANDARD_HASH },
    });
    expect(claimed.status).toBe(200);
    expect(claimed.body).toMatchObject({ status: "claimed" });

    const res = await call(intentPath(DUPLICATE_KEY, "/complete"), {
      body: completeBody(DUPLICATE_KEY, {
        claimToken: String(claimed.body?.token ?? ""),
        sessionId: `sbx_${"2".repeat(24)}`,
      }),
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "duplicate_session",
      sessionId: `sbx_${"1".repeat(24)}`,
    });
    // The second payment is recorded and refunded in the same transaction, so
    // the client must not retry it.
    const ledger = await call(ledgerPath(DUPLICATE_KEY), { method: "GET" });
    expect(ledger.status).toBe(200);
    expect(ledger.body).toMatchObject({
      status: "REFUNDED",
      reason: "duplicate_client_nonce",
    });
  });

  it("refuses a refund once the session reached READY", async () => {
    const sessions = await sqlExec(
      "UPDATE sessions SET ready_at = $1 WHERE payment_key = $2",
      [Date.now(), ADMIT_KEY],
      "fuzz",
    );
    expect(sessions).toBe(1);

    const res = await call(ledgerPath(ADMIT_KEY, "/refund"), {
      body: { transaction: "mock:refund-after-ready" },
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "service_delivered" });
  });

  it("refuses to fail an intent whose money already settled", async () => {
    await store.insertUnclaimedLedger({
      paymentKey: SETTLED_LEDGER_KEY,
      sessionId: `unsettled:${SETTLED_LEDGER_KEY}`,
      payer: "0x0000000000000000000000000000000000000001",
      amount: "50000",
      asset: "mock:usdc",
      network: "mock:local",
      mode: "mock",
      status: "SETTLED",
      reason: "settled_without_entitlement",
      settlementNonce: null,
    });

    const res = await call(intentPath(SETTLED_LEDGER_KEY, "/fail"), {
      body: { reason: "operator_retry" },
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "ledger_settled", ledgerStatus: "SETTLED" });
  });

  it("rejects a status filter outside the ledger vocabulary", async () => {
    const allowed = new Set(["SETTLED", "REFUND_PENDING", "REFUND_SENDING", "REFUNDED"]);
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.constantFrom(...allowed), fc.string({ maxLength: 24 })),
        async (status) => {
          const res = await call(`/internal/payments?status=${encodeURIComponent(status)}`, {
            method: "GET",
          });
          if (allowed.has(status)) {
            expect(res.status).toBe(200);
            expect(Array.isArray(res.body?.payments)).toBe(true);
            return;
          }
          expect(res.status).toBe(400);
          expect(res.body).toMatchObject({ error: "invalid_status" });
        },
      ),
      { numRuns: 60, ...fuzzSeed },
    );
  });

  it("refuses a refund without a transaction before reading the ledger", async () => {
    await fc.assert(
      fc.asyncProperty(parsedJson, async (body) => {
        const hasTransaction =
          body !== null &&
          typeof body === "object" &&
          typeof (body as Record<string, unknown>).transaction === "string" &&
          ((body as Record<string, unknown>).transaction as string).length > 0;
        const res = await call(ledgerPath(UNKNOWN_KEY, "/refund"), { body });
        if (hasTransaction) {
          // The transaction gate passed, so the unknown ledger row is a 404.
          expect(res.status).toBe(404);
          expect(res.body).toMatchObject({ error: "not_found" });
          return;
        }
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ error: "transaction_required" });
      }),
      { numRuns: 60, ...fuzzSeed },
    );
  });

  it("refuses malformed settlement nonces and accepts a well-formed one as unknown", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 1, maxLength: 80 })
          .filter((value) => value !== "." && value !== ".."),
        async (nonce) => {
          const res = await call(`/internal/payments/by-nonce/${encodeURIComponent(nonce)}`, {
            method: "GET",
          });
          if (/^0x[0-9a-fA-F]{64}$/.test(nonce)) {
            expect(res.status).toBe(404);
            return;
          }
          expect(res.status).toBe(400);
          expect(res.body).toMatchObject({ error: "invalid_nonce" });
        },
      ),
      { numRuns: 60, ...fuzzSeed },
    );
  });

  it("answers the ledger routes for keys and nonces it has never seen", async () => {
    const unknownKey = await call(ledgerPath(UNKNOWN_KEY), { method: "GET" });
    expect(unknownKey.status).toBe(404);
    expect(unknownKey.body).toMatchObject({ error: "not_found" });

    const unknownRefund = await call(ledgerPath(UNKNOWN_KEY, "/refund"), {
      body: { transaction: "mock:refund-tx" },
    });
    expect(unknownRefund.status).toBe(404);
    expect(unknownRefund.body).toMatchObject({ error: "not_found" });

    // A well-formed nonce the ledger has never recorded is also a 404, not the
    // 400 the shape check answers for a malformed one.
    const unknownNonce = await call(`/internal/payments/by-nonce/0x${"b".repeat(64)}`, {
      method: "GET",
    });
    expect(unknownNonce.status).toBe(404);
    expect(unknownNonce.body).toMatchObject({ error: "not_found" });
  });

  it("records a manual refund for a settled row that never reached a session", async () => {
    await store.insertUnclaimedLedger({
      paymentKey: REFUND_KEY,
      sessionId: `unsettled:${REFUND_KEY}`,
      payer: "0x0000000000000000000000000000000000000001",
      amount: "50000",
      asset: "mock:usdc",
      network: "mock:local",
      mode: "mock",
      status: "SETTLED",
      reason: "settled_without_entitlement",
      settlementNonce: `0x${"a".repeat(64)}`,
    });

    const before = await call(ledgerPath(REFUND_KEY), { method: "GET" });
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ status: "SETTLED" });

    // The same row is reachable by the EIP-3009 authorisation nonce, which is
    // how a facilitator webhook identifies the refund.
    const byNonce = await call(`/internal/payments/by-nonce/0x${"a".repeat(64)}`, {
      method: "GET",
    });
    expect(byNonce.status).toBe(200);
    expect(byNonce.body).toMatchObject({ paymentKey: REFUND_KEY, status: "SETTLED" });

    const refund = await call(ledgerPath(`0x${"a".repeat(64)}`, "/refund"), {
      body: { transaction: "mock:refund-tx", reason: "operator_request" },
    });
    expect(refund.status).toBe(200);
    expect(refund.body).toMatchObject({ ok: true, changed: true });
    expect(refund.body?.payment).toMatchObject({
      status: "REFUNDED",
      refundTransaction: "mock:refund-tx",
    });

    // The refunded row is what the ledger read now returns.
    const ledger = await call(ledgerPath(REFUND_KEY), { method: "GET" });
    expect(ledger.status).toBe(200);
    expect(ledger.body).toMatchObject({ paymentKey: REFUND_KEY, status: "REFUNDED" });

    // A second refund has nothing left to change, which is an answer too.
    const again = await call(ledgerPath(REFUND_KEY, "/refund"), {
      body: { transaction: "mock:refund-tx-2" },
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, changed: false });
  });
});
