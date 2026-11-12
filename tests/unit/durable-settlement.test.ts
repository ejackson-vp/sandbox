/**
 * Settlement classification on the grant path (ADR 0011).
 *
 * The refund worker already treats an ambiguous provider answer as `unknown`.
 * The settlement call has the same window: the facilitator may have broadcast
 * the transfer before the answer was lost. These tests pin the consequence that
 * matters for money: an unknown settlement is not recorded as a failed intent
 * while a settlement lookup can still find and refund the payment.
 */
import { describe, expect, it, vi } from "vitest";
import { UnsupportedSettlementLookup, type SettlementLookup } from "@x402s/shared/runtime";
import { postCreate } from "../helpers/create-route.js";

const SUPPORTED_LOOKUP: SettlementLookup = {
  supported: true,
  lookup: async () => null,
};

function resourceServer(settle: (...args: unknown[]) => Promise<unknown>) {
  return {
    verifyPayment: async () => ({ isValid: true }),
    settlePayment: settle,
  };
}

describe("settlement outcome classification", () => {
  it("keeps the intent claimed when the settle call throws and recovery can resolve it", async () => {
    const result = await postCreate(
      () => undefined,
      {
        settlementLookup: SUPPORTED_LOOKUP,
        resourceServer: resourceServer(async () => {
          throw new Error("facilitator timed out");
        }),
      },
    );

    expect(result.status).toBe(402);
    expect(result.body.error).toBe("payment_settle_failed");
    // The payment may have settled. Failing the intent here would close the only
    // window SettlementRecovery has to record the debt.
    expect(result.controller.failIntent).not.toHaveBeenCalled();
  });

  it("fails the intent on a throw when no lookup exists, as the honest terminal state", async () => {
    const result = await postCreate(
      () => undefined,
      {
        settlementLookup: new UnsupportedSettlementLookup(),
        resourceServer: resourceServer(async () => {
          throw new Error("facilitator timed out");
        }),
      },
    );

    expect(result.status).toBe(402);
    expect(result.controller.failIntent).toHaveBeenCalledWith(result.paymentKey, "settle_error");
  });

  it("does not record settlement_pending as a refusal", async () => {
    const result = await postCreate(
      () => undefined,
      {
        settlementLookup: SUPPORTED_LOOKUP,
        resourceServer: resourceServer(async () => ({
          success: false,
          errorReason: "settlement_pending",
          transaction: "",
          network: "mock:local",
        })),
      },
    );

    expect(result.status).toBe(402);
    expect(result.body.error).toBe("payment_settle_failed");
    expect(result.controller.failIntent).not.toHaveBeenCalled();
    // The funds may exist, so the capacity hold stays until its TTL.
    expect(result.controller.releaseCapacity).not.toHaveBeenCalled();
  });

  it("records a definite refusal and releases the hold", async () => {
    const result = await postCreate(
      () => undefined,
      {
        settlementLookup: SUPPORTED_LOOKUP,
        resourceServer: resourceServer(async () => ({
          success: false,
          errorReason: "insufficient_funds",
          transaction: "",
          network: "mock:local",
        })),
      },
    );

    expect(result.status).toBe(402);
    expect(result.body.error).toBe("payment_settlement_rejected:insufficient_funds");
    expect(result.controller.failIntent).toHaveBeenCalledWith(result.paymentKey, "insufficient_funds");
    expect(result.controller.releaseCapacity).toHaveBeenCalled();
  });

  it("still recovers a nonce conflict through the lookup", async () => {
    const lookup = vi.fn(async () => ({ settled: true, payer: "0xpayer", transaction: "0xtx" }));
    const result = await postCreate(
      () => undefined,
      {
        settlementLookup: { supported: true, lookup },
        resourceServer: resourceServer(async () => ({
          success: false,
          errorReason: "nonce_already_used",
          transaction: "",
          network: "mock:local",
        })),
      },
    );

    expect(result.status).toBe(201);
    expect(lookup).toHaveBeenCalledWith(result.paymentKey);
    expect(result.controller.completeIntent).toHaveBeenCalledWith(
      result.paymentKey,
      expect.objectContaining({ payment: expect.objectContaining({ payer: "0xpayer" }) }),
    );
  });
});
