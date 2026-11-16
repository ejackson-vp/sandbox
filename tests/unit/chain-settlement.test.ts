/**
 * Settlement as the create path consumes it (F-10, F-17).
 *
 * The gate that matters: a facilitator answer is not authority, and a used
 * EIP-3009 nonce is not a payment. A session is granted only when the chain
 * proves the transfer, and the same check recovers a payment that settled before
 * the API crashed.
 *
 * The verifier's own mechanics (topics, receipts, window, chunking) are in
 * `settlement-verifier.test.ts`. This file pins the wiring and the verdict
 * mapping, including the F-17 ordering: a failed verify never reaches the chain.
 */
import { describe, expect, it, vi } from "vitest";
import { UnsupportedSettlementLookup } from "@x402s/shared/runtime";
import { confirmSettledOnChain } from "../../api/src/payments/settlement-confirmation.js";
import { postCreate } from "../helpers/create-route.js";
import {
  AUTHORIZER,
  NONCE,
  RECIPIENT,
  chainProof,
  disproven,
  notFound,
  proven,
} from "../helpers/settlement-fixtures.js";

function settledResourceServer(settle: () => Promise<unknown> = async () => ({
  success: true,
  transaction: "0xtx",
  network: "mock:local",
  payer: "0xpayer",
})) {
  return { verifyPayment: async () => ({ isValid: true }), settlePayment: settle };
}

/** A create request whose controller, facilitator and chain answers are stubs. */
async function create(opts: Parameters<typeof postCreate>[1]) {
  return postCreate(() => undefined, opts);
}

describe("chain-proven settlement", () => {
  it("grants when the chain proves the transfer, and checks the server's terms", async () => {
    const settlementProof = vi.fn(async () => proven());
    const result = await create({
      settlementVerifier: { settlementProof },
      resourceServer: settledResourceServer(),
    });

    expect(result.status).toBe(201);
    // The check is on the address that signed the payment, the nonce in it, the
    // server's recipient and the server's price. Never on a field the client
    // merely claims.
    expect(settlementProof).toHaveBeenCalledWith({
      authorizer: result.authorizer,
      nonce: result.settlementNonce.toLowerCase(),
      recipient: result.terms.payTo,
      amount: result.terms.amount,
    });
    expect(result.controller.completeIntent).toHaveBeenCalledTimes(1);
  });

  it("ignores a recipient or amount in the request body", async () => {
    const settlementProof = vi.fn(async () => proven());
    const result = await postCreate(
      ({ body }) => {
        // A client that tries to redefine "settled" for itself.
        body.payTo = "0x9999999999999999999999999999999999999999";
        body.amount = "1";
      },
      { settlementVerifier: { settlementProof }, resourceServer: settledResourceServer() },
    );

    expect(result.status).toBe(201);
    expect(settlementProof).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: result.terms.payTo, amount: result.terms.amount }),
    );
    expect(result.terms.amount).toBeGreaterThan(1n);
  });

  it("refuses a settle the chain positively disproves", async () => {
    const result = await create({
      settlementVerifier: chainProof(disproven("transfer_below_price")),
      resourceServer: settledResourceServer(),
    });

    expect(result.status).toBe(503);
    expect(result.body.error).toBe("payment_unconfirmed");
    expect(result.body.reason).toBe("unsettled");
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
    // The money exists but is not the payment that was asked for, so the intent
    // stays claimed and the capacity hold stays until its TTL.
    expect(result.controller.failIntent).not.toHaveBeenCalled();
    expect(result.controller.releaseCapacity).not.toHaveBeenCalled();
  });

  it("withholds, rather than refusing, when the nonce is outside the window", async () => {
    const result = await create({
      settlementVerifier: chainProof(notFound()),
      resourceServer: settledResourceServer(),
    });

    expect(result.status).toBe(503);
    expect(result.body.error).toBe("payment_unconfirmed");
    // The nonce may have settled before the window opened, so this is "could not
    // place the payment", not "the payment failed". A two-hour outage must not
    // turn into a permanent refusal with no debt recorded.
    expect(result.body.reason).toBe("unavailable");
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
    expect(result.controller.failIntent).not.toHaveBeenCalled();
    expect(result.controller.releaseCapacity).not.toHaveBeenCalled();
  });

  it("refuses when the verifier errors, rather than granting", async () => {
    const result = await create({
      settlementVerifier: {
        settlementProof: async () => {
          throw new Error("rpc unavailable");
        },
      },
      resourceServer: settledResourceServer(),
    });

    expect(result.status).toBe(503);
    expect(result.body.error).toBe("payment_unconfirmed");
    expect(result.body.reason).toBe("unavailable");
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
  });

  it("never reaches the chain when the facilitator rejects the payment (F-17 ordering)", async () => {
    const settlementProof = vi.fn(async () => proven());
    const settlePayment = vi.fn(async () => ({ success: true }));
    const result = await postCreate(
      () => undefined,
      {
        settlementVerifier: { settlementProof },
        resourceServer: {
          verifyPayment: async () => ({ isValid: false, invalidReason: "invalid_signature" }),
          settlePayment,
        },
      },
    );

    expect(result.status).toBe(402);
    expect(result.body.error).toBe("payment_invalid:invalid_signature");
    expect(settlePayment).not.toHaveBeenCalled();
    // The chain answer would be "proven" here. Making it reachable without a
    // verify that proves this payer's authorisation is what F-17 was about.
    expect(settlementProof).not.toHaveBeenCalled();
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
  });

  it("never reaches the chain when the verify call throws", async () => {
    const settlementProof = vi.fn(async () => proven());
    const result = await postCreate(
      () => undefined,
      {
        settlementVerifier: { settlementProof },
        resourceServer: {
          verifyPayment: async () => {
            throw new Error("facilitator unavailable");
          },
          settlePayment: async () => ({ success: true }),
        },
      },
    );

    expect(result.status).toBe(402);
    expect(result.body.error).toBe("payment_verify_failed");
    expect(settlementProof).not.toHaveBeenCalled();
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
  });

  it("leaves the mock path unchanged when no verifier is configured", async () => {
    const result = await create({ resourceServer: settledResourceServer() });

    expect(result.status).toBe(201);
    expect(result.controller.completeIntent).toHaveBeenCalledTimes(1);
  });

  it("recovers a crash-after-settle payment from the chain", async () => {
    const result = await postCreate(
      ({ controller }) => {
        controller.claimIntent = vi.fn(async () => ({
          status: "claimed" as const,
          recovered: true,
          token: "t",
          expiresAt: 1,
        }));
      },
      {
        // The public testnet facilitator exposes no settlement lookup. Before
        // F-10 this was the dead end that answered 409 reconciliation_pending.
        settlementLookup: new UnsupportedSettlementLookup(),
        settlementVerifier: chainProof(proven()),
        resourceServer: settledResourceServer(async () => ({
          success: false,
          errorReason: "nonce_already_used",
          transaction: "",
          network: "mock:local",
        })),
      },
    );

    expect(result.status).toBe(201);
    expect(result.controller.completeIntent).toHaveBeenCalledWith(
      result.paymentKey,
      expect.objectContaining({
        payment: expect.objectContaining({ payer: result.authorizer }),
      }),
    );
  });

  it("does not recover when the chain positively disproves the payment", async () => {
    const settlementProof = vi.fn(async () => disproven("transfer_to_another_recipient"));
    const result = await postCreate(
      ({ controller }) => {
        controller.claimIntent = vi.fn(async () => ({
          status: "claimed" as const,
          recovered: true,
          token: "t",
          expiresAt: 1,
        }));
      },
      {
        settlementLookup: new UnsupportedSettlementLookup(),
        settlementVerifier: { settlementProof },
        resourceServer: settledResourceServer(async () => ({
          success: false,
          errorReason: "nonce_already_used",
          transaction: "",
          network: "mock:local",
        })),
      },
    );

    expect(result.status).toBe(402);
    expect(result.body.error).toBe("payment_settlement_rejected:nonce_already_used");
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
    // Recovery checks the recovered intent's own terms, not an empty object.
    expect(settlementProof).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: result.terms.payTo, amount: result.terms.amount }),
    );
  });

  it("completes when the settle answer is lost but the chain proves the transfer", async () => {
    const settlementProof = vi.fn(async () => proven());
    const result = await create({
      settlementVerifier: { settlementProof },
      resourceServer: settledResourceServer(async () => {
        throw new Error("socket hang up");
      }),
    });

    // No second settle: the chain answers, so the entitlement completes now
    // instead of the client retrying into payment_in_progress.
    expect(result.status).toBe(201);
    expect(result.controller.completeIntent).toHaveBeenCalledWith(
      result.paymentKey,
      expect.objectContaining({
        payment: expect.objectContaining({ payer: result.authorizer }),
      }),
    );
  });

  it("refuses a lost settle the chain positively disproves", async () => {
    const result = await create({
      settlementVerifier: chainProof(disproven("no_matching_transfer")),
      resourceServer: settledResourceServer(async () => {
        throw new Error("socket hang up");
      }),
    });

    expect(result.status).toBe(402);
    expect(result.body.error).toBe("payment_settle_failed");
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
    // Nothing can be granted, but the intent stays claimed: the transfer may
    // still land after this answer.
    expect(result.controller.failIntent).not.toHaveBeenCalled();
  });

  it("withholds a lost settle whose nonce is outside the window", async () => {
    const result = await create({
      settlementVerifier: chainProof(notFound()),
      resourceServer: settledResourceServer(async () => {
        throw new Error("socket hang up");
      }),
    });

    expect(result.status).toBe(402);
    expect(result.body.error).toBe("payment_settle_failed");
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
    expect(result.controller.failIntent).not.toHaveBeenCalled();
  });

  it("completes a settlement_pending answer the chain proves", async () => {
    const result = await create({
      settlementVerifier: chainProof(proven()),
      resourceServer: settledResourceServer(async () => ({
        success: false,
        errorReason: "settlement_pending",
        transaction: "",
        network: "mock:local",
      })),
    });

    expect(result.status).toBe(201);
    expect(result.controller.completeIntent).toHaveBeenCalledTimes(1);
  });
});

describe("chain verdict", () => {
  const payload = { payload: { authorization: { from: AUTHORIZER, nonce: NONCE } } };
  const terms = { payTo: RECIPIENT, amount: "50000" };

  it("is unavailable without a verifier, so callers fall through to the lookup", async () => {
    await expect(confirmSettledOnChain(undefined, payload, terms)).resolves.toBe("unavailable");
  });

  it("is unavailable when the payload carries no authorizer or nonce", async () => {
    const settlementProof = vi.fn(async () => proven());
    await expect(confirmSettledOnChain({ settlementProof }, { payload: {} }, terms)).resolves.toBe(
      "unavailable",
    );
    expect(settlementProof).not.toHaveBeenCalled();
  });

  it("is unavailable when the price is not a positive integer", async () => {
    const settlementProof = vi.fn(async () => proven());
    for (const amount of ["", "0", "-1", "50000.5", "1e5"]) {
      await expect(
        confirmSettledOnChain({ settlementProof }, payload, { payTo: RECIPIENT, amount }),
      ).resolves.toBe("unavailable");
    }
    expect(settlementProof).not.toHaveBeenCalled();
  });

  it("is unavailable when the recipient is not an address", async () => {
    const settlementProof = vi.fn(async () => proven());
    await expect(
      confirmSettledOnChain({ settlementProof }, payload, { payTo: "", amount: "50000" }),
    ).resolves.toBe("unavailable");
    expect(settlementProof).not.toHaveBeenCalled();
  });

  it("is settled only on a proof", async () => {
    await expect(confirmSettledOnChain(chainProof(proven()), payload, terms)).resolves.toBe(
      "settled",
    );
  });

  it("is unsettled only on a positive disproof", async () => {
    await expect(
      confirmSettledOnChain(chainProof(disproven("transfer_below_price")), payload, terms),
    ).resolves.toBe("unsettled");
  });

  it("is unavailable, not unsettled, when the nonce is not in the window", async () => {
    await expect(confirmSettledOnChain(chainProof(notFound()), payload, terms)).resolves.toBe(
      "unavailable",
    );
  });

  it("is unavailable, never settled, when the verifier throws", async () => {
    await expect(
      confirmSettledOnChain(
        {
          settlementProof: async () => {
            throw new Error("rpc unavailable");
          },
        },
        payload,
        terms,
      ),
    ).resolves.toBe("unavailable");
  });
});
