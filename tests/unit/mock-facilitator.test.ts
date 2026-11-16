/**
 * The mock facilitator's settlement record.
 *
 * A record is the only source recovery has after a crash, so it has to describe
 * the transfer that settled, not the terms its caller asked for. `POST /settle`
 * takes the requirements from the caller and the authorisation from the payer;
 * `GET /settlements/:key` must report the authorisation's own recipient and
 * value, or the API cannot tell a payment to `PAY_TO` from a payment to the
 * payer (F-21).
 *
 * The app is started on a loopback port for this file. No chain, no funds: the
 * mock facilitator has neither.
 */
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { paymentKey } from "../../shared/src/entries/payment.js";
import { createMockFacilitator, type MockFacilitatorHandle } from "../../api/src/mock-facilitator.js";
import { REQUIREMENT } from "../helpers/create-route.js";
import { ACCOUNT, payloadFor } from "../helpers/payment-attacks.js";

let facilitator: MockFacilitatorHandle | undefined;
let server: ReturnType<MockFacilitatorHandle["app"]["listen"]> | undefined;

async function start(): Promise<string> {
  facilitator = await createMockFacilitator({ allowControl: false });
  server = facilitator.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server!.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve));
  server = undefined;
  facilitator?.close();
  facilitator = undefined;
});

describe("mock facilitator settlement record", () => {
  it("reports the recipient and amount of the authorisation, not the caller's ask", async () => {
    const baseUrl = await start();
    const payer = ACCOUNT();
    // A payment to the payer: the same amount, a recipient that is not PAY_TO.
    const terms = { ...REQUIREMENT, payTo: payer.address };
    const payload = await payloadFor(payer, { to: payer.address }, terms);

    const settle = await fetch(`${baseUrl}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: terms }),
    });
    expect(((await settle.json()) as { success: boolean }).success).toBe(true);

    const record = await fetch(`${baseUrl}/settlements/${paymentKey(payload)}`);
    expect(record.status).toBe(200);
    await expect(record.json()).resolves.toMatchObject({
      settled: true,
      recipient: payer.address.toLowerCase(),
      amount: "50000",
    });
  });

  it("reports PAY_TO for a payment the server priced", async () => {
    const baseUrl = await start();
    const payer = ACCOUNT();
    const payload = await payloadFor(payer);

    const settle = await fetch(`${baseUrl}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: payload,
        paymentRequirements: REQUIREMENT,
      }),
    });
    expect(((await settle.json()) as { success: boolean }).success).toBe(true);

    const record = await fetch(`${baseUrl}/settlements/${paymentKey(payload)}`);
    await expect(record.json()).resolves.toMatchObject({
      settled: true,
      recipient: REQUIREMENT.payTo.toLowerCase(),
      amount: REQUIREMENT.amount,
      payer: payer.address,
    });
  });

  it("answers 404 for a key it never settled, so a retry is not a refusal", async () => {
    const baseUrl = await start();

    const unknown = await fetch(`${baseUrl}/settlements/${"a".repeat(64)}`);
    expect(unknown.status).toBe(404);

    const malformed = await fetch(`${baseUrl}/settlements/not-a-key`);
    expect(malformed.status).toBe(400);
  });

  it("never stores a key it refused to settle", async () => {
    const baseUrl = await start();
    const payer = ACCOUNT();
    // The caller asks for PAY_TO, the authorisation pays the payer: validate
    // refuses, so no record may exist for the key.
    const payload = await payloadFor(payer, { to: payer.address });

    const settle = await fetch(`${baseUrl}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: payload,
        paymentRequirements: REQUIREMENT,
      }),
    });
    expect(((await settle.json()) as { success: boolean }).success).toBe(false);

    const record = await fetch(`${baseUrl}/settlements/${paymentKey(payload)}`);
    expect(record.status).toBe(404);
  });
});
