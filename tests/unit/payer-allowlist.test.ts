/**
 * Free entitlement for a proven allowlisted address (ADR 0013).
 *
 * The gate is the signer, not a request field: the address that gets the
 * allowance is the one the commitment signature recovered. These tests pin that
 * order, the $0 ledger row, the namespaced budget and every refusal.
 */
import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sha256Hex } from "@x402s/shared/crypto";
import {
  allowlistBudgetKey,
  allowlistPaymentKey,
} from "../../api/src/use-cases/create-session-allowlist.js";
import { CHALLENGE_NONCE, postCreate } from "../helpers/create-route.js";

const LABEL = "owner-agent";

/** A working facilitator, so a refusal is the allowlist's doing, not the stub's. */
const settledResourceServer = {
  verifyPayment: async () => ({ isValid: true }),
  settlePayment: async () => ({
    success: true,
    transaction: "0xtx",
    network: "mock:local",
    payer: "0xpayer",
  }),
};

function allow(controller: {
  authorizeAllowlistedPayer: ReturnType<typeof vi.fn>;
}): void {
  controller.authorizeAllowlistedPayer = vi.fn(async () => ({
    allowed: true as const,
    label: LABEL,
    maxTier: "long" as const,
    maxConcurrent: 2,
  }));
}

function refuse(
  controller: { authorizeAllowlistedPayer: ReturnType<typeof vi.fn> },
  reason: string,
): void {
  controller.authorizeAllowlistedPayer = vi.fn(async () => ({
    allowed: false as const,
    reason,
  }));
}

describe("allowlisted payer", () => {
  it("gets a $0 session with the right ledger row", async () => {
    const result = await postCreate(({ controller }) => allow(controller));

    expect(result.status).toBe(201);
    const payment = result.controller.completeIntent.mock.calls[0]?.[1]?.payment as Record<
      string,
      unknown
    >;
    expect(payment).toMatchObject({
      amount: "0",
      source: "allowlist",
      label: LABEL,
      payer: result.authorizer,
      settlementNonce: null,
      budgetKey: allowlistBudgetKey(result.authorizer),
    });
    // The key is derived from the proven address and the burned challenge, and
    // is not the key of the payment header the client sent.
    expect(payment.paymentKey).toBe(allowlistPaymentKey(result.authorizer, CHALLENGE_NONCE));
    expect(payment.paymentKey).not.toBe(result.paymentKey);
    // The budget is namespaced away from the payer's own row.
    expect(result.controller.reserveBudget).toHaveBeenCalledWith(
      allowlistBudgetKey(result.authorizer),
      "0",
    );
  });

  it("never reaches a facilitator for a free session", async () => {
    const verifyPayment = vi.fn(async () => ({ isValid: true }));
    const settlePayment = vi.fn(async () => ({ success: true }));
    const result = await postCreate(({ controller }) => allow(controller), {
      resourceServer: { verifyPayment, settlePayment },
    });

    expect(result.status).toBe(201);
    expect(verifyPayment).not.toHaveBeenCalled();
    expect(settlePayment).not.toHaveBeenCalled();
  });

  it("sends a non-allowlisted payer down the normal paid path", async () => {
    const result = await postCreate(
      ({ controller }) => refuse(controller, "not_allowlisted"),
      { resourceServer: settledResourceServer },
    );

    expect(result.status).toBe(201);
    const payment = result.controller.completeIntent.mock.calls[0]?.[1]?.payment as Record<
      string,
      unknown
    >;
    expect(payment.source).toBe("x402");
    expect(payment.amount).toBe("50000");
    expect(result.controller.reserveBudget).toHaveBeenCalledWith(result.authorizer, "50000");
  });

  it("refuses a disabled entry and falls back to the 402 path", async () => {
    const result = await postCreate(
      ({ controller }) => refuse(controller, "disabled"),
      {
        resourceServer: {
          verifyPayment: async () => ({ isValid: true }),
          settlePayment: async () => ({
            success: false,
            errorReason: "insufficient_funds",
            transaction: "",
            network: "mock:local",
          }),
        },
      },
    );

    expect(result.status).toBe(402);
    expect(result.body.error).toBe("payment_settlement_rejected:insufficient_funds");
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
  });

  it("checks the proven signer, not a claimed field", async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    const result = await postCreate(
      ({ controller }) => allow(controller),
      // The payment header is signed by the harness wallet, the commitment by
      // another: the address is not proven, so the allowlist is never asked.
      { commitmentSigner: other },
    );

    expect(result.status).toBe(401);
    expect(result.body.error).toBe("client_proof_invalid");
    expect(result.controller.authorizeAllowlistedPayer).not.toHaveBeenCalled();
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
  });

  it("refuses a replayed challenge nonce before granting", async () => {
    const result = await postCreate(({ controller }) => {
      allow(controller);
      controller.burnChallengeNonce = vi.fn(async () => ({ status: "reused" as const }));
    });

    expect(result.status).toBe(402);
    expect(result.payment402).toHaveBeenCalledWith(expect.anything(), expect.anything(), "challenge_nonce_reused");
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
  });

  it("refuses when the allowlist lookup fails, rather than charging", async () => {
    const result = await postCreate(({ controller }) => {
      controller.authorizeAllowlistedPayer = vi.fn(async () => {
        throw new Error("controller unreachable");
      });
    });

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ error: "admission_unavailable", retryable: true });
    expect(result.body.message).toMatch(/no payment was taken/);
    expect(result.controller.reserveBudget).not.toHaveBeenCalled();
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
  });

  it("does nothing at all when the feature is off", async () => {
    const result = await postCreate(({ controller }) => allow(controller), {
      allowlistEnabled: false,
      resourceServer: settledResourceServer,
    });

    expect(result.status).toBe(201);
    expect(result.controller.authorizeAllowlistedPayer).not.toHaveBeenCalled();
    expect(result.controller.reserveBudget).toHaveBeenCalledWith(result.authorizer, "50000");
  });

  it("keeps the free budget separate when it is exhausted", async () => {
    const result = await postCreate(({ controller }) => {
      allow(controller);
      controller.reserveBudget = vi.fn(async () => ({
        ok: false as const,
        scope: "payer_concurrent",
        retryAfterSeconds: 5,
        remaining: {
          payerCreates: 0,
          payerSpend: "0",
          payerConcurrent: 0,
          globalCreates: 1,
          globalConcurrent: 1,
        },
        windowResetsAt: Date.now() + 60_000,
      }));
    });

    expect(result.status).toBe(429);
    expect(result.body).toMatchObject({ error: "budget_exhausted", scope: "payer_concurrent" });
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
  });
});

describe("allowlist payment key", () => {
  const ADDRESS = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";

  it("is unique per challenge and case-insensitive on the address", () => {
    const first = allowlistPaymentKey(ADDRESS, `cn_${"a".repeat(32)}`);
    const second = allowlistPaymentKey(ADDRESS, `cn_${"b".repeat(32)}`);
    expect(first).not.toBe(second);
    expect(allowlistPaymentKey(ADDRESS.toLowerCase(), `cn_${"a".repeat(32)}`)).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is domain-separated from a bare hash of address and nonce", () => {
    // The prefix is part of the preimage, so this key is a different input
    // space from any hash a client could make the server compute for a payment.
    const nonce = `cn_${"a".repeat(32)}`;
    expect(allowlistPaymentKey(ADDRESS, nonce)).toBe(
      sha256Hex(`x402-allowlist:v1|${ADDRESS.toLowerCase()}|${nonce}`),
    );
    expect(allowlistPaymentKey(ADDRESS, nonce)).not.toBe(
      sha256Hex(`${ADDRESS.toLowerCase()}|${nonce}`),
    );
  });

  it("namespaces the budget by address", () => {
    expect(allowlistBudgetKey(ADDRESS)).toBe(`allow:${ADDRESS.toLowerCase()}`);
  });
});
