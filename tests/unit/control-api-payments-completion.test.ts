/**
 * The completion path: create, duplicate, a lost claim, and a rollback.
 *
 * The fuzz suite stops a valid completion at the capacity decision unless the
 * payment key is one it seeded, and the guard suite only reads the settlement
 * identifiers back. Neither pins what the biggest handler in the control API
 * actually does with the row, so a refactor of `/complete` could change the
 * initial session state, answer a duplicate as a 500, drop the winning session
 * on a lost claim, or leave a half-written entitlement and every existing test
 * would still pass.
 *
 * Each test below names the failure it prevents:
 *
 *  - the PAID row is the record the reconciler schedules from, so `execEpoch`,
 *    `destroyRequested`, `resumeCount` and the null columns are pinned;
 *  - a second payment for the same client key pair is a refund, not an error,
 *    and the ledger says so;
 *  - a claim lost to the worker that settled it hands back that worker's
 *    session instead of a 409;
 *  - a failure after the session insert rolls the transaction back and releases
 *    the capacity reservation the route took before it.
 *
 * The store is the real Postgres adapter wherever the assertion is about what
 * was written, and a stub only where the test needs to produce a race the real
 * adapter cannot be made to lose on demand. The router is `registerPaymentRoutes`
 * itself, mounted the way the guard and fail-intent suites mount it.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSessionSpec, specHash } from "@x402s/shared/payment";
import { DEFAULT_RUNTIME } from "@x402s/shared/runtimes";
import { registerPaymentRoutes } from "../../controller/src/control-api/payments.js";
import type { ControlApiDeps } from "../../controller/src/control-api/types.js";
import type { CapacityService } from "../../controller/src/capacity/service.js";
import { PaymentClaimLostError } from "../../controller/src/store/models.js";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import { controllerConfig } from "../helpers/controller-config.js";
import { limitsFor, paymentFixture, sessionFixture } from "../helpers/store-fixtures.js";
import { freshStore, sqlExec, sqlRows } from "../helpers/test-store.js";

const SERVERS: Server[] = [];

afterEach(async () => {
  await Promise.all(
    SERVERS.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const cfg = controllerConfig();
const PAY_TO = "0x0000000000000000000000000000000000000402";
const CLIENT_KEY = "p".repeat(44);
const CLIENT_NONCE = "n".repeat(44);
const SETTLEMENT_NONCE = `0x${"a".repeat(64)}`;
const CLIENT_SIGNER = `0x${"b".repeat(40)}`;

const resolution = resolveSessionSpec(
  {
    tier: "standard",
    clientPublicKey: CLIENT_KEY,
    clientNonce: CLIENT_NONCE,
    maxLifetimeSeconds: 900,
  },
  cfg.tiers,
  cfg.platformLimits,
);
if (!resolution.ok) throw new Error(`standard spec did not resolve: ${resolution.code}`);
const SPEC = resolution.spec;
const SPEC_HASH = specHash(SPEC);

/** A capacity service that admits, and records both the attach and the release. */
function capacityStub() {
  const attach = vi.fn(async () => ({
    admitted: true as const,
    nodeId: "node-completion",
    reservation: { nodeId: "node-completion" },
  }));
  const releaseSession = vi.fn(async () => true);
  return {
    attach,
    releaseSession,
    service: { attach, releaseSession } as unknown as CapacityService,
  };
}

/**
 * The payment routes on their own app, with a JSON 500 handler.
 *
 * The real router has an error backstop that turns an unhandled throw into a
 * 500; this is the test's version of it, so a route that rethrows is observable
 * as "server error carrying that error" rather than an HTML page.
 */
async function listen(deps: {
  store: ControlApiDeps["store"];
  capacity: CapacityService;
}): Promise<string> {
  const app = express();
  app.use(express.json());
  registerPaymentRoutes(app, {
    cfg,
    store: deps.store,
    capacity: deps.capacity,
  } as unknown as ControlApiDeps);
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(500).json({ error: "internal_error", message: err.message });
    },
  );
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  SERVERS.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function completionBody(
  paymentKey: string,
  claimToken: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    claimToken,
    sessionId: `sbx_${"1".repeat(24)}`,
    capabilityHash: "f".repeat(64),
    capabilityExpiresAt: Date.now() + 600_000,
    spec: SPEC,
    clientPublicKey: CLIENT_KEY,
    clientNonce: CLIENT_NONCE,
    clientSigner: CLIENT_SIGNER,
    payment: {
      paymentKey,
      network: "mock:local",
      scheme: "exact",
      asset: "mock:usdc",
      amount: "50000",
      payTo: PAY_TO,
      payer: `0x${"c".repeat(40)}`,
      mode: "mock",
      settlementNonce: SETTLEMENT_NONCE,
    },
    ...overrides,
  };
}

async function post(base: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : undefined) as Record<string, unknown>,
  };
}

/** Claim an intent, which is the state every completion test starts from. */
async function claim(store: PostgresStore, paymentKey: string): Promise<string> {
  const result = await store.claimPaymentIntent(paymentKey, SPEC_HASH, 30_000);
  if (result.status !== "claimed") throw new Error(`expected a claim, got ${result.status}`);
  return result.token;
}

describe("a claimed intent completes into one PAID session", () => {
  it("writes the initial row the reconciler expects and folds the view into the answer", async () => {
    const store = await freshStore();
    const paymentKey = "1".repeat(64);
    const sessionId = `sbx_${"1".repeat(24)}`;
    const token = await claim(store, paymentKey);
    const capacity = capacityStub();
    const base = await listen({ store, capacity: capacity.service });

    const res = await post(
      base,
      `/internal/payment-intents/${paymentKey}/complete`,
      completionBody(paymentKey, token, { sessionId }),
    );

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      sessionId,
      state: "PAID",
      created: true,
      // The view is folded in so the create path needs no second round trip.
      session: { sessionId, state: "PAID" },
    });

    // Every value here is an invariant of a fresh entitlement, not a detail of
    // this request: `execEpoch` fences relay work, and the nulls are what make
    // "not started yet" distinguishable from "started and lost".
    expect(await store.getSession(sessionId)).toMatchObject({
      id: sessionId,
      state: "PAID",
      paymentKey,
      tier: "standard",
      durationSeconds: SPEC.durationSeconds,
      runtime: DEFAULT_RUNTIME,
      execEpoch: 1,
      resumeCount: 0,
      destroyRequested: 0,
      runtimeClass: cfg.runtimeClass,
      executionMode: cfg.executionMode,
      maxLifetimeSeconds: 900,
      readyAt: null,
      leaseExpiresAt: null,
      terminatingAt: null,
      destroyedAt: null,
      terminationReason: null,
      failureCode: null,
      failureMessage: null,
      attestationJson: null,
      guestPublicKey: null,
      podName: null,
      relayTokenHash: null,
      activeRequestId: null,
      relayPurgedAt: null,
      timingsJson: null,
      suspendedAt: null,
      workspacePvc: null,
      nodeName: null,
    });
    // A PAID row is paid the instant it is created, not at the next reconcile.
    // `lastActivityAt` is not null despite the literal saying so: the adapter
    // substitutes `createdAt` for a missing activity clock, which is the
    // behaviour the idle policy reads.
    const session = await store.getSession(sessionId);
    expect(session?.paidAt).toBe(session?.createdAt);
    expect(session?.lastActivityAt).toBe(session?.createdAt);

    expect(await store.getLedgerByPayment(paymentKey)).toMatchObject({
      status: "SETTLED",
      sessionId,
      settlementNonce: SETTLEMENT_NONCE,
    });
    expect(await store.getPaymentIntent(paymentKey)).toMatchObject({
      status: "settled",
      sessionId,
      claimToken: null,
    });

    // One admission, bound to the session that became durable.
    expect(capacity.attach).toHaveBeenCalledTimes(1);
    expect(capacity.attach).toHaveBeenCalledWith(
      paymentKey,
      sessionId,
      SPEC_HASH,
      expect.objectContaining({ tier: "standard" }),
    );
  });
});

describe("a second payment for the same client commitment is refunded, not failed", () => {
  it("answers the duplicate path with the existing session and a 409, never a 500", async () => {
    const store = await freshStore();
    const firstKey = "2".repeat(64);
    const firstSession = `sbx_${"2".repeat(24)}`;
    const capacity = capacityStub();
    const base = await listen({ store, capacity: capacity.service });

    const first = await post(
      base,
      `/internal/payment-intents/${firstKey}/complete`,
      completionBody(firstKey, await claim(store, firstKey), { sessionId: firstSession }),
    );
    expect(first.status).toBe(201);

    // Same key pair, second payment, a session id that must never be written.
    const secondKey = "3".repeat(64);
    const secondSession = `sbx_${"3".repeat(24)}`;
    const duplicate = await post(
      base,
      `/internal/payment-intents/${secondKey}/complete`,
      completionBody(secondKey, await claim(store, secondKey), { sessionId: secondSession }),
    );

    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toEqual({
      error: "duplicate_session",
      sessionId: firstSession,
      message: expect.stringContaining("recorded for refund"),
    });

    // The refusal is a client answer, not a partial write: no second session,
    // and the first one is untouched.
    expect(await store.getSession(secondSession)).toBeNull();
    expect(await store.getSession(firstSession)).not.toBeNull();
    // The charge is on the books under its own key, refunded, so neither the
    // ledger nor a retry can lose it.
    expect(await store.getLedgerByPayment(secondKey)).toMatchObject({
      status: "REFUNDED",
      reason: "duplicate_client_nonce",
      sessionId: `duplicate:${secondKey}`,
    });
    // The intent is failed, not settled: it must not be replayable as a create.
    expect(await store.getPaymentIntent(secondKey)).toMatchObject({
      status: "failed",
      reason: "duplicate_client_nonce",
      claimToken: null,
    });
  });
});

describe("a claim lost to a worker that settled it hands back that session", () => {
  it("answers 200 with the winning session and does not free the live owner's capacity", async () => {
    const paymentKey = "4".repeat(64);
    const claimToken = "4".repeat(32);
    const winnerId = `sbx_${"4".repeat(24)}`;
    const intent = {
      paymentKey,
      specHash: SPEC_HASH,
      reason: null,
      claimExpiresAt: Date.now() + 30_000,
      requirementsJson: null,
      authorizer: null,
      settlementNonce: null,
      createdAt: 1,
      updatedAt: 1,
    };
    // The early fence sees the claim held; by the time the settlement
    // transaction runs, another worker owns and has settled it.
    let intentReads = 0;
    const store = {
      getPaymentIntent: vi.fn(async () =>
        intentReads++ === 0
          ? { ...intent, status: "claimed" as const, sessionId: null, claimToken }
          : { ...intent, status: "settled" as const, sessionId: winnerId, claimToken: null },
      ),
      completeEntitlement: vi.fn(async () => {
        throw new PaymentClaimLostError(paymentKey);
      }),
      getSession: vi.fn(async (id: string) =>
        id === winnerId
          ? sessionFixture({
              id: winnerId,
              paymentKey,
              clientPublicKey: CLIENT_KEY,
              clientNonce: CLIENT_NONCE,
              tier: "standard",
              durationSeconds: SPEC.durationSeconds,
              limits: limitsFor("unit"),
              runtime: DEFAULT_RUNTIME,
            })
          : null,
      ),
      getPayment: vi.fn(async () => paymentFixture({ paymentKey, network: "mock:local" })),
    } as unknown as ControlApiDeps["store"];
    const capacity = capacityStub();
    const base = await listen({ store, capacity: capacity.service });

    const res = await post(
      base,
      `/internal/payment-intents/${paymentKey}/complete`,
      completionBody(paymentKey, claimToken, { sessionId: `sbx_${"5".repeat(24)}` }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sessionId: winnerId,
      state: "PAID",
      created: false,
      session: { sessionId: winnerId },
    });
    // The live owner holds the same payment reservation, so freeing it here
    // would hand its capacity to another create while the session is live.
    expect(capacity.releaseSession).not.toHaveBeenCalled();
    expect(store.completeEntitlement).toHaveBeenCalledTimes(1);
  });
});

describe("a failure after the session insert rolls the entitlement back", () => {
  it("writes nothing, leaves the intent claimable, and releases the reservation", async () => {
    const store = await freshStore();
    const paymentKey = "6".repeat(64);
    const sessionId = `sbx_${"6".repeat(24)}`;
    const payer = `0x${"c".repeat(40)}`;
    const token = await claim(store, paymentKey);

    // `recordSpend` is the last statement in the settlement transaction, after
    // the session and intent writes. A spend row that cannot be parsed makes it
    // throw there, which is the only way to fail the transaction after the
    // session row without editing the code under test.
    await sqlExec(
      `INSERT INTO payer_budgets (budget_key, window_start_ms, creates, spend, updated_at)
       VALUES ($1, $2, 0, 'not-a-number', $2)`,
      [`payer:${payer}`, Date.now()],
    );

    const capacity = capacityStub();
    const base = await listen({ store, capacity: capacity.service });

    const res = await post(
      base,
      `/internal/payment-intents/${paymentKey}/complete`,
      completionBody(paymentKey, token, { sessionId }),
    );

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: "internal_error" });

    // The route took a reservation before settling, so the rollback has to give
    // it back or the payment keeps capacity it never used.
    expect(capacity.releaseSession).toHaveBeenCalledTimes(1);
    expect(capacity.releaseSession).toHaveBeenCalledWith(sessionId);

    // Nothing from the failed transaction survives: no session, no ledger row,
    // no payment row, and the intent is still exactly the claim it was.
    expect(await store.getSession(sessionId)).toBeNull();
    expect(await store.getLedgerByPayment(paymentKey)).toBeNull();
    expect(
      await sqlRows("SELECT 1 AS present FROM payments WHERE payment_key = $1", [paymentKey]),
    ).toEqual([]);
    expect(await store.getPaymentIntent(paymentKey)).toMatchObject({
      status: "claimed",
      claimToken: token,
      sessionId: null,
    });
    // The corrupt row is the pre-existing one, not a partially updated spend.
    expect(
      await sqlRows("SELECT spend FROM payer_budgets WHERE budget_key = $1", [`payer:${payer}`]),
    ).toMatchObject([{ spend: "not-a-number" }]);
  });
});
