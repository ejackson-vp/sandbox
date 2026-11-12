/**
 * The settlement lookup both processes share (#31, F-10).
 *
 * There used to be two copies of this class, one in the API and one in the
 * controller, differing only in whether the timeout was parameterised. They
 * read the same facilitator contract, so a change to one was a silent drift
 * from the other. One module now serves both, and this suite covers it from
 * all three directions:
 *
 *  - the wire contract: path, escaping, 404 vs unsettled vs failure, timeout;
 *  - the API consumer: a recovered intent completes from the lookup record
 *    instead of settling again;
 *  - the controller consumer: the recovery worker turns a settled payment with
 *    no entitlement into a refundable ledger row.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HttpSettlementLookup, UnsupportedSettlementLookup } from "../../shared/src/entries/runtime.js";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import { RefundService } from "../../controller/src/refunds.js";
import { SettlementRecovery } from "../../controller/src/settlement-recovery.js";
import { postCreate } from "../helpers/create-route.js";
import { freshStore } from "../helpers/test-store.js";

const PAYMENT_KEY = "a".repeat(64);
const PAYER = "0x00000000000000000000000000000000000000aa";
const REQUIREMENTS = JSON.stringify({
  network: "mock:local",
  scheme: "exact",
  asset: "mock:usdc",
  amount: "50000",
  payTo: "0x0000000000000000000000000000000000000402",
});

interface Reply {
  status: number;
  body?: unknown;
  /** Hold the response so a short client timeout can fire. */
  delayMs?: number;
}

const servers: http.Server[] = [];
let requests: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  requests = [];
});

/** A stub facilitator. Every request is recorded so path assertions are exact. */
async function facilitator(respond: (paymentKey: string) => Reply): Promise<string> {
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "";
    requests.push(url);
    const key = decodeURIComponent(/^\/settlements\/([^/?]+)$/.exec(url)?.[1] ?? "");
    const reply = respond(key);
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    if (res.destroyed) return;
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body ?? {}));
  });
  server.on("clientError", (_err, socket) => socket.destroy());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A claimed intent whose owner died before completing the entitlement. */
async function seedStaleClaim(store: PostgresStore): Promise<void> {
  const claim = await store.claimPaymentIntent(PAYMENT_KEY, "b".repeat(64), 30_000, REQUIREMENTS);
  if (claim.status !== "claimed") throw new Error("expected claim");
}

describe("HTTP settlement lookup", () => {
  it("returns the record for a settled payment key", async () => {
    const record = { settled: true, transaction: "mock:tx", payer: PAYER, amount: "50000" };
    const baseUrl = await facilitator(() => ({ status: 200, body: record }));

    await expect(new HttpSettlementLookup(baseUrl).lookup(PAYMENT_KEY)).resolves.toEqual(record);
    expect(requests).toEqual([`/settlements/${PAYMENT_KEY}`]);
  });

  it("escapes the payment key and trims a trailing slash from the base URL", async () => {
    const baseUrl = await facilitator(() => ({ status: 200, body: { settled: true } }));

    await new HttpSettlementLookup(`${baseUrl}/`).lookup("a/b");

    expect(requests).toEqual(["/settlements/a%2Fb"]);
  });

  it("returns null for a key the facilitator has no record of", async () => {
    const baseUrl = await facilitator(() => ({ status: 404, body: { settled: false } }));

    await expect(new HttpSettlementLookup(baseUrl).lookup(PAYMENT_KEY)).resolves.toBeNull();
  });

  it("returns null for an unsettled payment", async () => {
    const baseUrl = await facilitator(() => ({ status: 200, body: { settled: false } }));

    await expect(new HttpSettlementLookup(baseUrl).lookup(PAYMENT_KEY)).resolves.toBeNull();
  });

  it("throws with the status when the facilitator fails", async () => {
    const baseUrl = await facilitator(() => ({ status: 503, body: { error: "unavailable" } }));

    await expect(new HttpSettlementLookup(baseUrl).lookup(PAYMENT_KEY)).rejects.toThrow(
      "settlement lookup failed (503)",
    );
  });

  it("honours the configured timeout", async () => {
    const baseUrl = await facilitator(() => ({ status: 200, body: { settled: true }, delayMs: 250 }));

    const err = await new HttpSettlementLookup(baseUrl, 25)
      .lookup(PAYMENT_KEY)
      .catch((e: unknown) => e);

    expect((err as Error).name).toBe("TimeoutError");
  });

  it("allows a slow but successful answer on the default budget", async () => {
    const baseUrl = await facilitator(() => ({ status: 200, body: { settled: true }, delayMs: 50 }));

    await expect(new HttpSettlementLookup(baseUrl).lookup(PAYMENT_KEY)).resolves.toEqual({
      settled: true,
    });
  });
});

describe("unsupported settlement lookup", () => {
  it("reports unsupported and never reaches the network", async () => {
    const baseUrl = await facilitator(() => ({ status: 200, body: { settled: true } }));
    // Prove the server is reachable, so "no request" below means the unsupported
    // implementation made none rather than that the address was wrong.
    await new HttpSettlementLookup(baseUrl).lookup(PAYMENT_KEY);
    requests = [];

    const lookup = new UnsupportedSettlementLookup();
    expect(lookup.supported).toBe(false);
    await expect(lookup.lookup()).resolves.toBeNull();
    expect(requests).toEqual([]);
  });
});

describe("API consumer", () => {
  it("completes a recovered intent from the lookup instead of settling again", async () => {
    const baseUrl = await facilitator(() => ({
      status: 200,
      body: { settled: true, transaction: "mock:tx", payer: PAYER },
    }));

    const result = await postCreate(
      ({ controller }) => {
        controller.claimIntent.mockResolvedValue({
          status: "claimed",
          recovered: true,
          token: "t",
          expiresAt: 1,
        });
      },
      { settlementLookup: new HttpSettlementLookup(baseUrl) },
    );

    expect(result.status).toBe(201);
    expect(requests).toEqual([`/settlements/${result.paymentKey}`]);
    expect(result.controller.completeIntent).toHaveBeenCalledWith(
      result.paymentKey,
      expect.objectContaining({
        payment: expect.objectContaining({ payer: PAYER, transaction: "mock:tx" }),
      }),
    );
    // A second settlement would have hit the empty resource server stub.
    expect(result.controller.failIntent).not.toHaveBeenCalled();
  });
});

describe("controller consumer", () => {
  it("records a settlement the lookup found as refundable", async () => {
    const baseUrl = await facilitator(() => ({
      status: 200,
      body: { settled: true, transaction: "mock:tx", payer: PAYER, amount: "50000" },
    }));
    const store = await freshStore();
    await seedStaleClaim(store);

    const result = await new SettlementRecovery(
      store,
      new RefundService(store),
      new HttpSettlementLookup(baseUrl),
      { graceMs: 0, limit: 10, mode: "testnet" },
    ).run();

    expect(result).toEqual({ checked: 1, recovered: 1, errors: 0 });
    expect(requests).toEqual([`/settlements/${PAYMENT_KEY}`]);
    const ledger = (await store.getLedgerByPayment(PAYMENT_KEY))!;
    expect(ledger.sessionId).toBe(`unsettled:${PAYMENT_KEY}`);
    expect(ledger.reason).toBe("settled_without_entitlement");
    expect(ledger.amount).toBe("50000");
    expect(ledger.payer).toBe(PAYER);
  });

  it("counts a lookup failure as an error without writing a ledger row", async () => {
    const baseUrl = await facilitator(() => ({ status: 500, body: { error: "boom" } }));
    const store = await freshStore();
    await seedStaleClaim(store);

    const result = await new SettlementRecovery(
      store,
      new RefundService(store),
      new HttpSettlementLookup(baseUrl),
      { graceMs: 0, limit: 10, mode: "testnet" },
    ).run();

    expect(result).toEqual({ checked: 1, recovered: 0, errors: 1 });
    expect(await store.getLedgerByPayment(PAYMENT_KEY)).toBeNull();
  });
});
