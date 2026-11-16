/**
 * What a facilitator settlement record has to prove (F-21).
 *
 * `recoverSettlement` used to grant on `settled: true`, so a record proved that
 * a payment key was used and nothing else. A record now has to name the
 * recipient and the amount that moved: one that answers both correctly is
 * `settled`, one that contradicts the requirement is `disproven`, and one that
 * cannot answer is `unknown` and withholds. The end-to-end attack that found
 * this is in `payment-adversarial.test.ts`; the verdict table lives here.
 *
 * `PAYMENT_MODE=mock` is the only mode that wires a supported lookup, so the
 * create-path cases below are mock-mode cases. Testnet and mainnet answer
 * `unknown` before the lookup is consulted.
 */
import { describe, expect, it, vi } from "vitest";
import { MOCK_NETWORK } from "../../shared/src/entries/payment.js";
import { recoverSettlement } from "../../api/src/payments/settlement-confirmation.js";
import { REQUIREMENT, postCreate } from "../helpers/create-route.js";
import {
  ACCOUNT,
  ELSEWHERE,
  facilitator,
  headerOf,
  nonceAlreadyUsed,
  payloadFor,
  permissiveFacilitator,
  recoveredIntent,
} from "../helpers/payment-attacks.js";

/**
 * F-21, fixed: a settlement record is held to the same standard as the chain.
 *
 * `recoverSettlement` used to grant on `settled: true`, so a facilitator record
 * proved a payment key was used and nothing else. The record now has to name the
 * recipient and the amount that moved: a record that answers both correctly is
 * `settled`, one that contradicts the requirement is `disproven`, and one that
 * cannot answer is `unknown` and withholds.
 */
describe("F-21: a lookup answer must prove the transfer", () => {
  const TERMS = { payTo: REQUIREMENT.payTo, amount: REQUIREMENT.amount };

  /** What a truthful facilitator reports for a payment of the server's price. */
  function settlementRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      settled: true,
      transaction: "mock:self",
      payer: "0xpayer",
      recipient: REQUIREMENT.payTo,
      amount: REQUIREMENT.amount,
      ...overrides,
    };
  }

  /** The verdict recovery reaches, without a create in the way. */
  async function resolutionFor(record: Record<string, unknown>) {
    const payload = await payloadFor(ACCOUNT());
    return recoverSettlement(
      { settlementLookup: { supported: true, lookup: async () => record as never } },
      "f".repeat(64),
      payload,
      TERMS,
    );
  }

  /**
   * A create whose settle says the nonce is spent, so the lookup is the only
   * source that can grant. The settle answer is a refusal, which is what makes
   * "no entitlement" an honest assertion: a permissive settle would grant
   * through the front door and hide the recovery decision.
   */
  async function recoveryAttempt(record: Record<string, unknown>) {
    const payer = ACCOUNT();
    return postCreate(() => undefined, {
      account: payer,
      paymentHeader: headerOf(await payloadFor(payer)),
      resourceServer: permissiveFacilitator(nonceAlreadyUsed()),
      settlementLookup: { supported: true, lookup: async () => record as never },
    });
  }

  it("refuses a payment the facilitator settled to the payer's own address", async () => {
    const { freshStore } = await import("../helpers/test-store.js");
    const store = await freshStore();
    const payer = ACCOUNT();
    // The right amount, the wrong recipient: `decodePayment` checks the amount
    // and the network, not the recipient.
    const accepted = { ...REQUIREMENT, payTo: payer.address };
    const payload = await payloadFor(payer, { to: payer.address }, accepted);
    const header = headerOf(payload);
    const { resourceServer } = facilitator();
    // The record the mock facilitator now returns: the recipient and the amount
    // come from the authorisation that settled, so this one names the payer.
    const lookup = {
      supported: true,
      lookup: async () => ({
        settled: true,
        transaction: "mock:self",
        payer: payer.address,
        recipient: payer.address,
        amount: accepted.amount,
      }),
    };
    // `staleMs: 0` is the stale-claim path the 30 s default takes, without the
    // wait (`claimLease`: a zero lease means "already expired").
    const claimStore = (staleMs: number) =>
      vi.fn(async (key: string, specHash: string, _staleMs: number, requirement: unknown) =>
        store.claimPaymentIntent(key, specHash, staleMs, {
          requirementsJson: JSON.stringify(requirement),
        }),
      );

    // 1. The first attempt is refused by verify, and the intent it claimed
    //    stays `claimed`: a failed verify releases capacity, not the intent.
    const first = await postCreate(
      ({ controller }) => {
        controller.claimIntent = claimStore(30_000);
      },
      { account: payer, paymentHeader: header, resourceServer, settlementLookup: lookup },
    );
    expect(first.status).toBe(402);
    expect(first.body.error).toBe("payment_invalid:payto_mismatch");
    expect((await store.getPaymentIntent(first.paymentKey))?.status).toBe("claimed");

    // 2. The payer settles its own authorisation: 50 000 units to itself.
    expect(await resourceServer.settlePayment(payload, accepted)).toMatchObject({ success: true });

    // 3. The reclaim happens, and with no chain verifier the record is the only
    //    source. A record that names the payer is a positive disproof.
    const second = await postCreate(
      ({ controller }) => {
        controller.burnChallengeNonce = vi.fn(async () => ({ status: "replay" as const }));
        controller.claimIntent = claimStore(0);
      },
      { account: payer, paymentHeader: header, resourceServer, settlementLookup: lookup },
    );

    expect(second.status).toBe(402);
    expect(second.body).not.toHaveProperty("capability");
    expect(second.controller.completeIntent).not.toHaveBeenCalled();
  });

  it("refuses a record with the right amount but the wrong recipient", async () => {
    const record = settlementRecord({ recipient: ELSEWHERE });

    await expect(resolutionFor(record)).resolves.toEqual({ status: "not-settled" });
    const result = await recoveryAttempt(record);
    expect(result.status).toBe(402);
    expect(result.body.error).toBe("payment_settlement_rejected:nonce_already_used");
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
    // A readable record that pays someone else is a refusal, not a question.
    expect(result.controller.failIntent).toHaveBeenCalledWith(
      result.paymentKey,
      "nonce_already_used",
    );
  });

  it("refuses a record with the right recipient but a short amount", async () => {
    // One atomic unit short of the $0.05 price.
    const record = settlementRecord({ amount: "49999" });

    await expect(resolutionFor(record)).resolves.toEqual({ status: "not-settled" });
    const result = await recoveryAttempt(record);
    expect(result.status).toBe(402);
    expect(result.body.error).toBe("payment_settlement_rejected:nonce_already_used");
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
    expect(result.controller.failIntent).toHaveBeenCalled();
  });

  it.each([["recipient"], ["amount"]])(
    "withholds when the record does not name the %s",
    async (field) => {
      const record = settlementRecord();
      delete record[field];

      await expect(resolutionFor(record)).resolves.toEqual({ status: "unknown" });
      const result = await recoveryAttempt(record);
      expect(result.status).toBe(503);
      expect(result.body.error).toBe("payment_unconfirmed");
      expect(result.body.retryable).toBe(true);
      // Unanswered, not refused: the debt stays visible to the recovery worker.
      expect(result.controller.failIntent).not.toHaveBeenCalled();
      expect(result.controller.completeIntent).not.toHaveBeenCalled();
    },
  );

  it("grants in mock mode when the record proves the recipient and the amount", async () => {
    // `>=` the price is enough, and the happy path must not change.
    const record = settlementRecord({ amount: "50001" });
    await expect(resolutionFor(record)).resolves.toMatchObject({ status: "settled" });

    const payer = ACCOUNT();
    const result = await postCreate(recoveredIntent(), {
      account: payer,
      paymentHeader: headerOf(await payloadFor(payer)),
      resourceServer: permissiveFacilitator(async () => ({
        success: true,
        transaction: "mock:self",
        network: MOCK_NETWORK,
      })),
      settlementLookup: { supported: true, lookup: async () => record as never },
    });

    expect(result.status).toBe(201);
    expect(result.controller.completeIntent).toHaveBeenCalledTimes(1);
  });
});
