/**
 * SDK create path with the server-issued challenge nonce (#47, F-07).
 *
 * The commitment is a wallet signature over (paymentKey, clientPublicKey,
 * clientNonce, challengeNonce). That makes a cached challenge unusable after one
 * use, so the SDK always takes the 402 round trip. The two behaviours pinned
 * here are the ones a refactor would break silently:
 *
 *  - the nonce from *this* challenge is what gets signed and sent, never a
 *    cached one;
 *  - a burned/expired challenge is retried once with the same payment payload,
 *    so the payment key does not change and a settled payment is recovered
 *    rather than charged twice.
 */
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

function paymentRequired(nonce?: string) {
  return {
    x402Version: 2,
    resource: { url: "https://sandbox.test/v1/sessions", description: "create a sandbox" },
    accepts: [{ ...requirement, extra: { ...requirement.extra, ...(nonce ? { challengeNonce: nonce } : {}) } }],
  };
}

function challenge(nonce?: string, error = "payment_required"): Response {
  return new Response(JSON.stringify({ error }), {
    status: 402,
    headers: {
      "content-type": "application/json",
      "payment-required": encodePaymentRequiredHeader(paymentRequired(nonce)),
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
const NONCE_A = "cn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NONCE_B = "cn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

interface Call {
  body: Record<string, unknown>;
  payment: string | undefined;
}

/** Record every request the SDK makes: JSON body and the payment header. */
function recorder(responses: Array<() => Response>): { calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body?: string; headers?: Record<string, string> }) => {
      const headers = init.headers ?? {};
      const paymentHeader = Object.entries(headers).find(([key]) =>
        key.toLowerCase() === "payment-signature",
      )?.[1];
      calls.push({
        body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {},
        payment: paymentHeader,
      });
      const respond = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      return respond();
    }),
  );
  return { calls };
}

describe("SDK create with a challenge nonce", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("always takes the challenge round trip and signs that challenge's nonce", async () => {
    const { calls } = recorder([
      () => challenge(NONCE_A),
      () => created(),
      () => challenge(NONCE_B),
      () => created(),
    ]);

    const payer = createPayer("mock");
    const first = await payer.createSession("https://sandbox.test", body);
    expect(first.response.status).toBe(201);
    // No cache: two creates, two probes.
    expect(calls).toHaveLength(2);

    const second = await payer.createSession("https://sandbox.test", { ...body, clientNonce: "nonce2" });
    expect(second.response.status).toBe(201);
    expect(calls).toHaveLength(4);

    expect(calls[1]!.body.challengeNonce).toBe(NONCE_A);
    expect(calls[3]!.body.challengeNonce).toBe(NONCE_B);
    expect(typeof calls[1]!.body.clientSignature).toBe("string");
    expect(calls[1]!.payment).toBeTruthy();
    // The probe is unpaid.
    expect(calls[0]!.payment).toBeUndefined();
  });

  it("retries a burned challenge with the same payment payload", async () => {
    const { calls } = recorder([
      () => challenge(NONCE_A),
      () => challenge(NONCE_B, "challenge_nonce_reused"),
      () => created(),
    ]);

    const payer = createPayer("mock");
    const result = await payer.createSession("https://sandbox.test", body);

    expect(result.response.status).toBe(201);
    expect(calls).toHaveLength(3);
    expect(calls[1]!.body.challengeNonce).toBe(NONCE_A);
    expect(calls[2]!.body.challengeNonce).toBe(NONCE_B);
    // Same payload => same payment key => a settled payment is recovered, not
    // charged again.
    expect(calls[2]!.payment).toBe(calls[1]!.payment);
  });

  it("does not retry a rejected payment", async () => {
    const { calls } = recorder([
      () => challenge(NONCE_A),
      () => challenge(NONCE_B, "payment_invalid:insufficient_funds"),
    ]);

    const payer = createPayer("mock");
    const result = await payer.createSession("https://sandbox.test", body);

    expect(result.response.status).toBe(402);
    expect(result.paymentError).toBe("payment_invalid:insufficient_funds");
    expect(calls).toHaveLength(2);
  });

  it("refuses a challenge with no nonce instead of signing it", async () => {
    const { calls } = recorder([() => challenge(undefined)]);

    const payer = createPayer("mock");
    const result = await payer.createSession("https://sandbox.test", body);

    expect(result.response.status).toBe(402);
    expect(result.paymentError).toContain("challenge nonce");
    expect(calls).toHaveLength(1);
  });
});
