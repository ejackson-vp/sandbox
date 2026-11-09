import { encodePaymentRequiredHeader } from "@x402/core/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MOCK_ASSET, MOCK_NETWORK } from "../../shared/src/payment.js";
import { createPayer } from "../../sdk/src/payment.js";

const requirement = {
  scheme: "exact",
  network: MOCK_NETWORK,
  asset: MOCK_ASSET,
  amount: "10000",
  payTo: "0x0000000000000000000000000000000000000402",
  maxTimeoutSeconds: 300,
  extra: { tier: "short", durationSeconds: 60 },
};

const paymentRequired = {
  x402Version: 2,
  resource: { url: "https://sandbox.test/v1/sessions", description: "create a sandbox" },
  accepts: [requirement],
};

function challenge(): Response {
  return new Response(JSON.stringify({ error: "payment_required" }), {
    status: 402,
    headers: {
      "content-type": "application/json",
      "payment-required": encodePaymentRequiredHeader(paymentRequired),
    },
  });
}

function created(): Response {
  return new Response(JSON.stringify({ sessionId: "sbx_test" }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}

const body = { tier: "short" as const, clientPublicKey: "pk", clientNonce: "nonce" };

describe("SDK payment challenge cache", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("skips the 402 round trip on the next create for the same spec", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return calls === 1 ? challenge() : created();
      }),
    );

    const payer = createPayer("mock");
    const first = await payer.createSession("https://sandbox.test", body);
    expect(first.response.status).toBe(201);
    expect(calls).toBe(2);

    const second = await payer.createSession("https://sandbox.test", { ...body, clientNonce: "nonce2" });
    expect(second.response.status).toBe(201);
    expect(calls).toBe(3);
  });

  it("refreshes a cached challenge the server rejects", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        // First create: challenge, then paid success.
        if (calls === 1 || calls === 4) return challenge();
        // Cached requirement rejected: drop it, fetch a fresh challenge, retry.
        if (calls === 3) return challenge();
        return created();
      }),
    );

    const payer = createPayer("mock");
    await payer.createSession("https://sandbox.test", body);
    expect(calls).toBe(2);

    const second = await payer.createSession("https://sandbox.test", body);
    expect(second.response.status).toBe(201);
    expect(calls).toBe(5);
  });

  it("does not reuse a challenge across specs", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return calls % 2 === 1 ? challenge() : created();
      }),
    );

    const payer = createPayer("mock");
    await payer.createSession("https://sandbox.test", body);
    await payer.createSession("https://sandbox.test", { ...body, tier: "long" });
    expect(calls).toBe(4);
  });
});
