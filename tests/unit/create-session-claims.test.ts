/**
 * The decisions between "the payment looks fine" and "a session exists".
 *
 * Each of these branches decides whether a request is charged, whether a
 * provisional capacity hold is kept, and whether a replay creates a second
 * session. They are cheap to get wrong and expensive to notice:
 *
 *  - a replay of an already-settled payment must return *that* session and must
 *    not re-hold capacity or complete a second intent;
 *  - a claim held by another worker is a 409 the client can retry, not a 503;
 *  - a claim for a different spec is refused instead of rewriting the payment;
 *  - a failed claim releases the provisional hold, so a refused create does not
 *    squat on capacity;
 *  - an unreadable payment is refused before any controller call, and a
 *    mispriced one is refused as a requirements mismatch rather than accepted.
 */
import type { PaymentRequirements } from "@x402/core/types";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { x402Client } from "@x402/core/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { decodePayment, quoteWithoutPayment } from "../../api/src/use-cases/create-session-stages.js";
import { loadConfig } from "../../api/src/config.js";
import { MOCK_NETWORK, MockExactClientScheme } from "../../shared/src/payment.js";
import { postCreate } from "../helpers/create-route.js";

const WINNER_ID = "sbx_bbbbbbbbbbbbbbbbbbbbbbbb";
const CAPABILITY_HASH = "e".repeat(64);

const REQUIREMENT: PaymentRequirements = {
  scheme: "exact",
  network: MOCK_NETWORK,
  asset: "mock:usdc",
  amount: "50000",
  payTo: "0x0000000000000000000000000000000000000402",
  maxTimeoutSeconds: 300,
} as PaymentRequirements;

const settled = {
  verifyPayment: async () => ({ isValid: true }),
  settlePayment: async () => ({ success: true, transaction: "mock:tx", network: MOCK_NETWORK }),
};

function paid(
  patch: Parameters<typeof postCreate>[0],
  opts: Parameters<typeof postCreate>[1] = {},
) {
  return postCreate(patch, { resourceServer: settled, ...opts });
}

function existing() {
  return {
    sessionId: WINNER_ID,
    state: "PAID",
    tier: "standard",
    durationSeconds: 300,
    limits: { cpuMillis: 500, memoryMiB: 512, diskMiB: 256 },
    createdAt: Date.now(),
    remainingSeconds: 300,
    clientNonce: "b".repeat(44),
    clientPublicKey: "a".repeat(44),
    capabilityHash: CAPABILITY_HASH,
    capabilityExpiresAt: Date.now() + 60_000,
    busy: false,
    payment: {
      paymentKey: "0x" + "c".repeat(64),
      network: "mock:local",
      scheme: "exact",
      asset: "mock:usdc",
      amount: "50000",
      payTo: "0x0000000000000000000000000000000000000402",
      mode: "mock",
    },
  };
}

describe("a replayed settled payment", () => {
  it("returns the existing session and never completes a second one", async () => {
    const result = await paid(
      ({ controller }) => {
        controller.claimIntent = vi.fn(async () => ({ status: "settled", sessionId: WINNER_ID }));
        controller.getSession = vi.fn(async () => existing());
      },
      { recoverCapability: () => "replayed-capability" },
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ sessionId: WINNER_ID, capability: "replayed-capability" });
    // The replay owns no capacity and creates nothing: the first attempt does.
    expect(result.controller.releaseCapacity).toHaveBeenCalledWith(result.paymentKey);
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
    expect(result.controller.holdCapacity).toHaveBeenCalledTimes(1);
  });

  it("answers 409 with the session id when the settled session cannot be read", async () => {
    const result = await paid(({ controller }) => {
      controller.claimIntent = vi.fn(async () => ({ status: "settled", sessionId: WINNER_ID }));
      controller.getSession = vi.fn(async () => null);
    });

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: "entitlement_missing", sessionId: WINNER_ID });
  });

  it("refuses to re-issue a capability whose signing key was retired", async () => {
    const result = await paid(
      ({ controller }) => {
        controller.claimIntent = vi.fn(async () => ({ status: "settled", sessionId: WINNER_ID }));
        controller.getSession = vi.fn(async () => existing());
      },
      { recoverCapability: () => null },
    );

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: "capability_key_retired", sessionId: WINNER_ID });
  });
});

describe("a claim another worker holds", () => {
  it("answers 409 payment_in_progress so the client retries the same payment", async () => {
    const result = await paid(({ controller }) => {
      controller.claimIntent = vi.fn(async () => ({ status: "in_progress" }));
    });

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: "payment_in_progress" });
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
  });

  it("answers 402 with the failure reason when the intent already failed", async () => {
    const result = await paid(({ controller }) => {
      controller.claimIntent = vi.fn(async () => ({ status: "failed", reason: "settle_failed" }));
    });

    expect(result.status).toBe(402);
    expect(result.body.error).toBe("payment_intent_failed:settle_failed");
    // A refused intent must not keep the provisional hold.
    expect(result.controller.releaseCapacity).toHaveBeenCalledWith(result.paymentKey);
  });

  it("refuses a payment made for a different spec instead of rewriting it", async () => {
    const result = await paid(({ controller }) => {
      controller.claimIntent = vi.fn(async () => ({ status: "mismatch" }));
    });

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: "spec_mismatch" });
    expect(result.controller.releaseCapacity).toHaveBeenCalled();
  });
});

describe("decoding a payment header", () => {
  const config = loadConfig({
    PAYMENT_MODE: "mock",
    ALLOW_INSECURE_DEV: "true",
    CONTROLLER_ADMIN_TOKEN: "a".repeat(32),
    CAPABILITY_SECRET: "s".repeat(32),
  });

  /** A real signed payload for the priced terms, so the decoder sees the real shape. */
  async function realPayload(overrides: Record<string, unknown> = {}) {
    const account = privateKeyToAccount(generatePrivateKey());
    const client = x402Client.fromConfig({
      schemes: [{ network: MOCK_NETWORK, client: new MockExactClientScheme(account) }],
      spendControls: false,
    });
    const payload = await client.createPaymentPayload({
      x402Version: 2,
      resource: { url: "https://sandbox.test/v1/sessions" },
      accepts: [REQUIREMENT],
    } as never);
    return { ...payload, ...overrides } as never;
  }

  function encode(payload: unknown): string {
    // The plain encoder returns the header value itself; the HTTP client wrapper
    // is the one that returns a headers object.
    return encodePaymentSignatureHeader(payload as never);
  }

  it("refuses a header it cannot parse", () => {
    const decoded = decodePayment("not-a-payment", REQUIREMENT, config);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.result).toMatchObject({ error: "malformed_payment_header" });
  });

  it("refuses a payment for a different price", async () => {
    const payload = await realPayload();
    const tampered = {
      ...(payload as { accepted: Record<string, unknown> }),
      accepted: { ...(payload as { accepted: Record<string, unknown> }).accepted, amount: "1" },
    };
    const decoded = decodePayment(encode(tampered), REQUIREMENT, config);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.result).toMatchObject({ error: "payment_requirements_mismatch" });
  });

  it("refuses a payment for a different network", async () => {
    const payload = await realPayload();
    const tampered = {
      ...(payload as { accepted: Record<string, unknown> }),
      accepted: { ...(payload as { accepted: Record<string, unknown> }).accepted, network: "eip155:8453" },
    };
    const decoded = decodePayment(encode(tampered), REQUIREMENT, config);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.result).toMatchObject({ error: "payment_requirements_mismatch" });
  });

  it("refuses a payment that is not x402 v2", async () => {
    const payload = await realPayload({ x402Version: 1 });
    const decoded = decodePayment(encode(payload), REQUIREMENT, config);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.result).toMatchObject({ error: "unsupported_x402_version" });
  });

  it("accepts a payment that matches the terms", async () => {
    expect(decodePayment(encode(await realPayload()), REQUIREMENT, config).ok).toBe(true);
  });
});

describe("a quote with no payment attached", () => {
  it("answers 503 rather than 500 when the capacity preflight is unreachable", async () => {
    const result = await quoteWithoutPayment(
      {
        controller: {
          preflightCapacity: async () => {
            throw new Error("connect ECONNREFUSED");
          },
        },
      } as never,
      { tier: "standard", durationSeconds: 300, limits: {} } as never,
      REQUIREMENT,
    );

    expect(result).toMatchObject({ kind: "json", status: 503 });
    expect((result as { body: { error: string; retryable: boolean } }).body).toMatchObject({
      error: "admission_unavailable",
      retryable: true,
    });
  });

  it("refuses a quote the cluster cannot fit, without asking for payment", async () => {
    const result = await quoteWithoutPayment(
      {
        controller: {
          preflightCapacity: async () => ({
            admitted: false,
            reason: "no_eligible_nodes",
            retryable: true,
            requested: { cpuMillicores: 500, memoryBytes: 1, storageBytes: 1 },
          }),
        },
      } as never,
      { tier: "standard", durationSeconds: 300, limits: {} } as never,
      REQUIREMENT,
    );

    expect(result).toMatchObject({ kind: "json", status: 503 });
    expect((result as { body: { error: string } }).body.error).toBe("capacity_unavailable");
  });
});
