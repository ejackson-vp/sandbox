/**
 * The internal money routes, at the seams where a wrong answer is expensive.
 *
 * Each assertion here exists because the obvious version of the suite passes
 * while the route is broken:
 *
 *  - `/fail` returning `409 ledger_settled` for any store error turns every
 *    database hiccup into the loudest money alert in the system, so a store
 *    failure that is not a settled ledger must not be reported as one;
 *  - the completion row is the record settlement recovery reconciles against,
 *    keyed by the EIP-3009 nonce, so a `null` written where the payer's nonce
 *    or signer was sent is a refund that can never be matched;
 *  - a stale claim that still spends capacity or validates a spec holds a
 *    reservation for an intent another worker now owns;
 *  - a truncated payment key in the log is the only safe thing to log, because
 *    the key is the handle an operator would use to move money.
 *
 * The store is the real Postgres adapter wherever the assertion is about what
 * was written, and a stub only where the test needs the store to fail. The
 * router is `registerPaymentRoutes` itself, mounted the way `fail-intent-guard`
 * mounts it.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSessionSpec, specHash } from "@x402s/shared/payment";
import { DEFAULT_RUNTIME } from "@x402s/shared/runtimes";
import { log } from "@x402s/shared/runtime";
import { registerPaymentRoutes } from "../../controller/src/control-api/payments.js";
import type { ControlApiDeps } from "../../controller/src/control-api/types.js";
import type { CapacityService } from "../../controller/src/capacity/service.js";
import { LedgerSettledError } from "../../controller/src/store/models.js";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import { controllerConfig } from "../helpers/controller-config.js";
import { freshStore } from "../helpers/test-store.js";

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

/** A capacity service that admits everything, so a test can assert whether it
 * was asked at all. */
function admittingCapacity() {
  const attach = vi.fn(async () => ({
    admitted: true as const,
    nodeId: "node-payments-guards",
    reservation: { nodeId: "node-payments-guards" },
  }));
  return { attach, service: { attach } as unknown as CapacityService };
}

/**
 * The payment routes on their own app, with a JSON 500 handler.
 *
 * The real router has an error backstop that turns an unhandled throw into a
 * 500; this handler is the test's version of it, so a route that rethrows is
 * observable as "server error carrying that error" instead of an HTML page.
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

function completionBody(paymentKey: string, claimToken: string, overrides: Record<string, unknown> = {}) {
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
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as Record<string, unknown> };
}

/** Claim an intent, which is the state every completion test starts from. */
async function claim(store: PostgresStore, paymentKey: string): Promise<string> {
  const result = await store.claimPaymentIntent(paymentKey, SPEC_HASH, 30_000);
  if (result.status !== "claimed") throw new Error(`expected a claim, got ${result.status}`);
  return result.token;
}

describe("completion keeps the settlement identifiers on the stored rows", () => {
  it("stores the payer nonce and signer, and the lifetime the spec asked for", async () => {
    const store = await freshStore();
    const paymentKey = "1".repeat(64);
    const sessionId = `sbx_${"1".repeat(24)}`;
    const token = await claim(store, paymentKey);
    const capacity = admittingCapacity();
    const base = await listen({ store, capacity: capacity.service });

    const res = await post(
      base,
      `/internal/payment-intents/${paymentKey}/complete`,
      completionBody(paymentKey, token, { sessionId }),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ state: "PAID", created: true });

    // Settlement recovery keys a refund by the EIP-3009 nonce, so the value the
    // API sent has to survive the write rather than land as null.
    expect(await store.getLedgerByPayment(paymentKey)).toMatchObject({
      settlementNonce: SETTLEMENT_NONCE,
      paymentKey,
    });
    // Same for the wallet that signed the client commitment, and the lifetime
    // the controller priced: a null here is a reconciliation defect, not a
    // formatting one.
    expect(await store.getSession(sessionId)).toMatchObject({
      clientSigner: CLIENT_SIGNER,
      maxLifetimeSeconds: 900,
      runtime: DEFAULT_RUNTIME,
    });
  });

  it("logs twelve characters of the payment key, never the key", async () => {
    const store = await freshStore();
    const paymentKey = "2".repeat(64);
    const token = await claim(store, paymentKey);
    const capacity = admittingCapacity();
    const base = await listen({ store, capacity: capacity.service });

    const info = vi.spyOn(log, "info");
    try {
      const res = await post(
        base,
        `/internal/payment-intents/${paymentKey}/complete`,
        completionBody(paymentKey, token),
      );
      expect(res.status).toBe(201);

      const line = info.mock.calls.find((call) => call[0] === "entitlement_created");
      expect(line).toBeDefined();
      const fields = line![1] as Record<string, unknown>;
      expect(fields.paymentKeyPrefix).toBe(paymentKey.slice(0, 12));
      expect(String(fields.paymentKeyPrefix)).toHaveLength(12);
      // The whole key is a handle an operator can use to move money; it must
      // not be in the line under any field name.
      expect(JSON.stringify(fields)).not.toContain(paymentKey);
    } finally {
      info.mockRestore();
    }
  });
});

describe("a stale claim is fenced before it can spend anything", () => {
  it("answers 409 stale_claim without asking capacity to attach", async () => {
    const store = await freshStore();
    const paymentKey = "3".repeat(64);
    // Claim it, then present a different claim token: the intent exists and is
    // claimed, but not by this caller.
    await claim(store, paymentKey);
    const capacity = admittingCapacity();
    const base = await listen({ store, capacity: capacity.service });

    const res = await post(
      base,
      `/internal/payment-intents/${paymentKey}/complete`,
      completionBody(paymentKey, "9".repeat(32)),
    );

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "stale_claim",
      message: "this intent is not held by the presented claim",
    });
    // The 409 is the same one the store would return, so the fence is only
    // proven by capacity never being consulted and no row being written.
    expect(capacity.attach).not.toHaveBeenCalled();
    expect(await store.getSession(`sbx_${"1".repeat(24)}`)).toBeNull();
    expect((await store.getPaymentIntent(paymentKey))?.status).toBe("claimed");
  });
});

describe("the fail route reports only a settled ledger as settled", () => {
  it("does not turn an unrelated store failure into ledger_settled", async () => {
    // Any 409 ledger_settled pages the on-call: it claims the customer was
    // served and the money moved. A connection error is not that.
    const store = {
      failPaymentIntent: async () => {
        throw new Error("connection terminated unexpectedly");
      },
    } as unknown as ControlApiDeps["store"];
    const base = await listen({ store, capacity: admittingCapacity().service });

    const res = await post(base, `/internal/payment-intents/${"4".repeat(64)}/fail`, {
      reason: "settlement_refused",
    });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: "internal_error", message: "connection terminated unexpectedly" });
    expect(res.body.error).not.toBe("ledger_settled");
  });

  it("still answers ledger_settled for the refusal it names", async () => {
    // The positive control for the test above: the named refusal keeps its
    // answer, so the assertion is about the type check, not about /fail never
    // answering 409.
    const store = {
      failPaymentIntent: async () => {
        throw new LedgerSettledError("5".repeat(64));
      },
    } as unknown as ControlApiDeps["store"];
    const base = await listen({ store, capacity: admittingCapacity().service });

    const res = await post(base, `/internal/payment-intents/${"5".repeat(64)}/fail`, {
      reason: "settlement_refused",
    });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "ledger_settled", ledgerStatus: "SETTLED" });
  });
});

describe("the by-nonce lookup only accepts a whole nonce", () => {
  async function lookupRoutes() {
    const store = await freshStore();
    const base = await listen({ store, capacity: admittingCapacity().service });
    return async (segment: string) => {
      const res = await fetch(`${base}/internal/payments/by-nonce/${segment}`);
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
  }

  it("rejects a nonce with a leading or trailing tail", async () => {
    const lookup = await lookupRoutes();
    const hex = "a".repeat(64);
    // Both anchors matter: the first byte of a hex nonce is not an address.
    for (const segment of [
      `0x${hex}zz`,
      `0x${hex}0`,
      `junk0x${hex}`,
      `0x${hex}%20`,
      "%20",
      "0x",
      `0x${"a".repeat(63)}`,
    ]) {
      const res = await lookup(segment);
      expect(res.status, segment).toBe(400);
      expect(res.body, segment).toMatchObject({ error: "invalid_nonce" });
    }
  });

  it("treats a well-formed nonce it has never seen as not found", async () => {
    const lookup = await lookupRoutes();
    const res = await lookup(`0x${"0".repeat(64)}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "not_found" });
  });
});
