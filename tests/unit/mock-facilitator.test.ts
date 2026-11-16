/**
 * The mock facilitator: its settlement record and the surface around it.
 *
 * It is a stand-in for the real facilitator, but it is not free of
 * consequences: the API's settlement lookup and the whole replay defence are
 * exercised against it, so a change here can make a replayed payment settle
 * twice or make a settled one look unsettled.
 *
 * The record is the only source recovery has after a crash, so it has to
 * describe the transfer that settled, not the terms its caller asked for.
 * `POST /settle` takes the requirements from the caller and the authorisation
 * from the payer; `GET /settlements/:key` must report the authorisation's own
 * recipient and value, or the API cannot tell a payment to `PAY_TO` from a
 * payment to the payer (F-21).
 *
 * The properties pinned:
 *
 *  - the settlement record reports the recipient and amount of the
 *    authorisation, and never a key it refused to settle;
 *  - verify checks the recipient, the amount and the network against the
 *    server's own terms, not the client's;
 *  - a second settle of the same authorization is refused as a replay;
 *  - the settlement lookup answers only for a payment that settled, and only
 *    for a well-formed key;
 *  - the test control surface exists only when it is asked for, because
 *    exposing it publicly would let anyone force settlement failures.
 *
 * The app is started on a loopback port for this file. No chain, no funds: the
 * mock facilitator has neither.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { paymentKey } from "../../shared/src/entries/payment.js";
import { createMockFacilitator, type MockFacilitatorHandle } from "../../api/src/mock-facilitator.js";
import { REQUIREMENT } from "../helpers/create-route.js";
import { ACCOUNT, payloadFor } from "../helpers/payment-attacks.js";

const handles: MockFacilitatorHandle[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const handle of handles.splice(0)) handle.close();
});

/** Start the facilitator on a loopback port and return its base URL. */
async function start(opts: { allowControl?: boolean } = {}): Promise<string> {
  const handle = await createMockFacilitator(opts);
  handles.push(handle);
  const server = await new Promise<Server>((resolve) => {
    const listener = handle.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function post(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface SettleAnswer {
  success: boolean;
  transaction?: string;
  errorReason?: string;
  payer?: string;
}

/** POST /settle with the body the facilitator contract expects. */
async function settle(
  base: string,
  paymentPayload: unknown,
  paymentRequirements: unknown = REQUIREMENT,
): Promise<SettleAnswer> {
  const res = await post(base, "/settle", { x402Version: 2, paymentPayload, paymentRequirements });
  return (await res.json()) as SettleAnswer;
}

interface VerifyAnswer {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

/** POST /verify with the body the facilitator contract expects. */
async function verify(
  base: string,
  paymentPayload: unknown,
  paymentRequirements: unknown = REQUIREMENT,
): Promise<VerifyAnswer> {
  const res = await post(base, "/verify", { paymentPayload, paymentRequirements });
  return (await res.json()) as VerifyAnswer;
}

/** GET /settlements/:key. */
function record(base: string, key: string) {
  return fetch(`${base}/settlements/${key}`);
}

describe("the settlement record", () => {
  it("reports the recipient and amount of the authorisation, not the caller's ask", async () => {
    const base = await start({ allowControl: false });
    const payer = ACCOUNT();
    // A payment to the payer: the same amount, a recipient that is not PAY_TO.
    const terms = { ...REQUIREMENT, payTo: payer.address };
    const payload = await payloadFor(payer, { to: payer.address }, terms);

    expect((await settle(base, payload, terms)).success).toBe(true);

    const settled = await record(base, paymentKey(payload));
    expect(settled.status).toBe(200);
    await expect(settled.json()).resolves.toMatchObject({
      settled: true,
      recipient: payer.address.toLowerCase(),
      amount: "50000",
    });
  });

  it("reports PAY_TO for a payment the server priced", async () => {
    const base = await start({ allowControl: false });
    const payer = ACCOUNT();
    const payload = await payloadFor(payer);

    expect((await settle(base, payload)).success).toBe(true);

    await expect((await record(base, paymentKey(payload))).json()).resolves.toMatchObject({
      settled: true,
      recipient: REQUIREMENT.payTo.toLowerCase(),
      amount: REQUIREMENT.amount,
      payer: payer.address,
    });
  });

  it("never stores a key it refused to settle", async () => {
    const base = await start({ allowControl: false });
    const payer = ACCOUNT();
    // The caller asks for PAY_TO, the authorisation pays the payer: validate
    // refuses, so no record may exist for the key.
    const payload = await payloadFor(payer, { to: payer.address });

    expect((await settle(base, payload)).success).toBe(false);

    expect((await record(base, paymentKey(payload))).status).toBe(404);
  });
});

describe("the settlement lookup", () => {
  it("answers an unknown key as unsettled, so a retry is not a refusal", async () => {
    const base = await start({ allowControl: false });

    const unknown = await record(base, "a".repeat(64));
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toEqual({ settled: false });
  });

  it("refuses a key that is not one", async () => {
    const base = await start({ allowControl: false });

    const malformed = await record(base, "not-a-key");
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: "invalid_payment_key" });
  });

  it("answers a settled payment with the record the recovery path reads", async () => {
    const base = await start({ allowControl: false });
    const payer = ACCOUNT();
    const payload = await payloadFor(payer);

    const answer = await settle(base, payload);
    expect(answer.success).toBe(true);
    expect(answer.transaction).toMatch(/^mock:[0-9a-f]{32}$/);

    await expect((await record(base, paymentKey(payload))).json()).resolves.toEqual({
      settled: true,
      transaction: answer.transaction,
      payer: payer.address,
      amount: REQUIREMENT.amount,
      recipient: REQUIREMENT.payTo.toLowerCase(),
    });
  });
});

describe("advertisement", () => {
  it("reports itself healthy and v2 on every supported kind", async () => {
    const base = await start();

    expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({
      ok: true,
      network: REQUIREMENT.network,
      settlement: "mock-offchain",
    });

    const supported = (await (await fetch(`${base}/supported`)).json()) as {
      kinds: Array<{ x402Version: number }>;
    };
    expect(supported.kinds.length).toBeGreaterThan(0);
    expect(supported.kinds.every((kind) => kind.x402Version === 2)).toBe(true);
  });
});

describe("verify", () => {
  it("refuses a request that is not the facilitator contract", async () => {
    const base = await start();
    const res = await post(base, "/verify", { paymentPayload: {} });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ isValid: false, invalidReason: "bad_request" });
  });

  it("accepts a payment signed for the server's terms and names the payer", async () => {
    const base = await start();
    const payer = ACCOUNT();
    const payload = await payloadFor(payer);

    await expect(verify(base, payload)).resolves.toEqual({ isValid: true, payer: payer.address });
  });

  it("refuses a payment whose amount does not match the terms", async () => {
    const base = await start();
    const payload = await payloadFor(ACCOUNT());

    const answer = await verify(base, payload, { ...REQUIREMENT, amount: "1" });
    expect(answer.isValid).toBe(false);
    expect(answer.invalidReason).toBe("amount_mismatch");
  });

  it("refuses a payment made out to a different recipient", async () => {
    const base = await start();
    const payload = await payloadFor(ACCOUNT());

    const answer = await verify(base, payload, {
      ...REQUIREMENT,
      payTo: "0x0000000000000000000000000000000000000403",
    });
    expect(answer.isValid).toBe(false);
    expect(answer.invalidReason).toBe("payto_mismatch");
  });
});

describe("settle", () => {
  it("refuses a settle request that is not the facilitator contract", async () => {
    const base = await start();
    const res = await post(base, "/settle", {});
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ success: false, errorReason: "bad_request" });
  });

  it("refuses the same authorization a second time as a replay", async () => {
    const base = await start();
    const payload = await payloadFor(ACCOUNT());

    expect((await settle(base, payload)).success).toBe(true);

    const replay = await settle(base, payload);
    expect(replay).toMatchObject({ success: false, errorReason: "nonce_already_used" });
  });
});

describe("the test control surface", () => {
  it("injects a settlement failure on request and reports the nonce it did not store", async () => {
    const base = await start();
    const payload = await payloadFor(ACCOUNT());

    expect(await (await post(base, "/control/fail-settle", { enabled: true })).json()).toEqual({ failSettle: true });

    const failed = await settle(base, payload);
    expect(failed).toMatchObject({ success: false, errorReason: "mock_settle_failure" });

    // A forced failure must not burn the authorization: the client can retry.
    await expect((await record(base, paymentKey(payload))).json()).resolves.toEqual({ settled: false });

    expect(await (await post(base, "/control/reset", {})).json()).toEqual({ ok: true });
    const nonces = (await (await fetch(`${base}/control/nonces`)).json()) as { count: number };
    expect(nonces.count).toBe(0);

    expect((await settle(base, payload)).success).toBe(true);
  });

  it("does not exist when control was not asked for", async () => {
    const base = await start({ allowControl: false });
    for (const path of ["/control/reset", "/control/fail-settle"]) {
      const res = await post(base, path, { enabled: true });
      expect(res.status, path).toBe(404);
    }
    expect((await fetch(`${base}/control/nonces`)).status).toBe(404);

    // Settlement itself still works without the control surface.
    expect((await settle(base, await payloadFor(ACCOUNT()))).success).toBe(true);
  });
});
