/**
 * The payment path, attacked from the outside.
 *
 * `security-review/FINDINGS.md` records what was found by reading and by
 * targeted tests. This suite is the other direction: a hostile client with a
 * real wallet, a real signature and a real facilitator, trying to obtain a
 * session without paying for it. Every test names the attack in its title and
 * asserts what an operator can see: status, error code, whether the completion
 * (the ledger write) happened, and whether money moved.
 *
 * Builders are in `tests/helpers/payment-attacks.ts`: the real facilitator
 * scheme wired as a resource server, and the real `UsdcSettlementVerifier` over
 * a fake reader, so nothing reaches a network and a refusal is the guard firing
 * rather than a stub agreeing.
 *
 * F-21 (a settlement record that proves neither recipient nor amount) started
 * here as the one attack that succeeded; it is now a fixed behaviour with its
 * own verdict table. A few rows also have a home elsewhere (F-02, F-07, F-17,
 * F-20, `api-config.test.ts`); they are here because this file is the attack
 * record.
 */
import { describe, expect, it, vi } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import { parseUsdPrice } from "../../shared/src/money.js";
import { MAX_SETTLEMENT_SCAN_QUERIES } from "../../shared/src/entries/settlement.js";
import { UnsupportedSettlementLookup } from "../../shared/src/entries/runtime.js";
import { MOCK_NETWORK } from "../../shared/src/entries/payment.js";
import { loadConfig } from "../../api/src/config.js";
import { REQUIREMENT, postCreate } from "../helpers/create-route.js";
import {
  ACCOUNT,
  ELSEWHERE,
  ZERO,
  authorizationOf,
  authUsed,
  chainAttempt,
  chainFor,
  facilitator,
  headerOf,
  nonceAlreadyUsed,
  payloadFor,
  permissiveFacilitator,
  receipt,
  recoveredIntent,
  sessionView,
} from "../helpers/payment-attacks.js";
import { STRANGER, TX_HASH, receiptWith, transfer } from "../helpers/settlement-fixtures.js";
import { sha256Hex } from "../../shared/src/entries/crypto.js";

/* ------------------------------------------------------------------ */

describe("attack 1: one atomic unit against a $0.05 requirement", () => {
  it("is refused on the first attempt, and never reaches a settle", async () => {
    const payer = ACCOUNT();
    const { resourceServer, settlePayment } = facilitator();
    const result = await postCreate(() => undefined, {
      account: payer,
      paymentHeader: headerOf(await payloadFor(payer, { value: "1" })),
      resourceServer,
    });

    expect(result.status).toBe(402);
    expect(result.body.error).toBe("payment_invalid:amount_mismatch");
    expect(settlePayment).not.toHaveBeenCalled();
    // No ledger row, and the price came from the server.
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
    expect(result.controller.reserveBudget).toHaveBeenCalledWith(result.authorizer, "50000");
  });

  it("is refused on the lost-settle branch: the chain sees a 1-unit transfer", async () => {
    const payer = ACCOUNT();
    const payload = await payloadFor(payer, { value: "1" });
    const { result } = await chainAttempt(
      payer,
      payload,
      { receipt: receipt(payer.address, REQUIREMENT.payTo, 1n) },
      async () => {
        throw new Error("socket hang up");
      },
    );

    expect(result.status).toBe(402);
    expect(result.body.error).toBe("payment_settle_failed");
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
  });

  it("is refused on the settlement_pending branch", async () => {
    const payer = ACCOUNT();
    const payload = await payloadFor(payer, { value: "1" });
    const { result } = await chainAttempt(
      payer,
      payload,
      { receipt: receipt(payer.address, REQUIREMENT.payTo, 1n) },
      async () => ({
        success: false,
        errorReason: "settlement_pending",
        transaction: "",
        network: MOCK_NETWORK,
      }),
    );

    expect(result.status).toBe(402);
    expect(result.body.error).toBe("payment_settle_failed");
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
    // Withheld, not failed: the transfer might yet land.
    expect(result.controller.failIntent).not.toHaveBeenCalled();
  });

  it("is refused on the nonce_already_used branch", async () => {
    const payer = ACCOUNT();
    const payload = await payloadFor(payer, { value: "1" });
    const { verifier } = chainFor(payload, {
      receipt: receipt(payer.address, REQUIREMENT.payTo, 1n),
    });
    const result = await postCreate(recoveredIntent(), {
      account: payer,
      paymentHeader: headerOf(payload),
      settlementLookup: new UnsupportedSettlementLookup(),
      resourceServer: permissiveFacilitator(nonceAlreadyUsed()),
      settlementVerifier: verifier,
    });

    expect(result.status).toBe(402);
    expect(result.body.error).toBe("payment_settlement_rejected:nonce_already_used");
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
    expect(result.controller.failIntent).toHaveBeenCalled();
  });
});

describe("attack 2: the right amount to the wrong recipient", () => {
  it.each([
    ["the zero address", ZERO, REQUIREMENT],
    ["the payer's own address", "payer", REQUIREMENT],
    ["an address that also rewrites accepted.payTo", ELSEWHERE, { ...REQUIREMENT, payTo: ELSEWHERE }],
  ])("is refused when it goes to %s", async (_label, target, accepted) => {
    const payer = ACCOUNT();
    const to = target === "payer" ? payer.address : (target as `0x${string}`);
    const { resourceServer, settlePayment } = facilitator();
    const result = await postCreate(() => undefined, {
      account: payer,
      paymentHeader: headerOf(await payloadFor(payer, { to }, accepted as PaymentRequirements)),
      resourceServer,
    });

    expect(result.status).toBe(402);
    expect(result.body.error).toBe("payment_invalid:payto_mismatch");
    expect(settlePayment).not.toHaveBeenCalled();
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
  });

  it("is refused on recovery when the chain shows the transfer went to the payer", async () => {
    const payer = ACCOUNT();
    const payload = await payloadFor(
      payer,
      { to: payer.address },
      { ...REQUIREMENT, payTo: payer.address },
    );
    const { result } = await chainAttempt(
      payer,
      payload,
      { receipt: receipt(payer.address, payer.address) },
      async () => {
        throw new Error("socket hang up");
      },
    );

    expect(result.status).toBe(402);
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
  });
});

describe("attack 3: one nonce, two sessions", () => {
  it("cannot buy a second session with a settled nonce", async () => {
    const payer = ACCOUNT();
    const { resourceServer } = facilitator();
    const first = await postCreate(() => undefined, { account: payer, resourceServer });
    const second = await postCreate(() => undefined, {
      account: payer,
      paymentHeader: first.header,
      resourceServer,
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(402);
    expect(second.body.error).toBe("payment_settlement_rejected:nonce_already_used");
    expect(first.controller.completeIntent).toHaveBeenCalledTimes(1);
    expect(second.controller.completeIntent).not.toHaveBeenCalled();
  });

  it("returns the original session when the settled payment is retried", async () => {
    const payer = ACCOUNT();
    const first = await postCreate(() => undefined, {
      account: payer,
      resourceServer: facilitator().resourceServer,
    });
    const capability = (first.body as { capability: string }).capability;

    const second = await postCreate(
      ({ controller }) => {
        controller.burnChallengeNonce = vi.fn(async () => ({ status: "replay" as const }));
        controller.claimIntent = vi.fn(async () => ({ status: "settled" as const, sessionId: "sbx_first" }));
        controller.getSession = vi.fn(async () => sessionView({ capabilityHash: sha256Hex(capability) }));
      },
      { account: payer, paymentHeader: first.header, resourceServer: facilitator().resourceServer },
    );

    expect(first.status).toBe(201);
    // The same session and capability: a replay is not a second lease.
    expect(second.status).toBe(200);
    expect(second.body.sessionId).toBe("sbx_first");
    expect(second.controller.completeIntent).not.toHaveBeenCalled();
  });

  it("will not mint a capability for a client key the payment did not sign", async () => {
    const payer = ACCOUNT();
    const first = await postCreate(() => undefined, {
      account: payer,
      resourceServer: facilitator().resourceServer,
    });
    const capability = (first.body as { capability: string }).capability;

    const second = await postCreate(
      ({ controller, body }) => {
        // Same payment, another client key. The wallet (the attacker here)
        // signs the new commitment, so the proof itself passes.
        body.clientPublicKey = "c".repeat(44);
        body.clientNonce = "d".repeat(44);
        controller.burnChallengeNonce = vi.fn(async () => ({ status: "replay" as const }));
        controller.claimIntent = vi.fn(async () => ({ status: "settled" as const, sessionId: "sbx_first" }));
        controller.getSession = vi.fn(async () => sessionView({ capabilityHash: sha256Hex(capability) }));
      },
      { account: payer, paymentHeader: first.header, resourceServer: facilitator().resourceServer },
    );

    expect(second.status).toBe(409);
    expect(second.body.error).toBe("capability_key_retired");
    expect(second.controller.completeIntent).not.toHaveBeenCalled();
  });

  it("will not replay a captured header with a fresh challenge nonce", async () => {
    const payer = ACCOUNT();
    const first = await postCreate(() => undefined, {
      account: payer,
      resourceServer: facilitator().resourceServer,
    });
    // The thief has the header from a proxy log but not the wallet, so the
    // commitment cannot be re-signed for the new challenge.
    const thief = ACCOUNT();
    const second = await postCreate(
      ({ body }) => {
        body.challengeNonce = `cn_${"b".repeat(32)}`;
      },
      {
        account: thief,
        commitmentSigner: thief,
        paymentHeader: first.header,
        resourceServer: facilitator().resourceServer,
      },
    );

    expect(second.status).toBe(401);
    expect(second.body.error).toBe("client_proof_invalid");
    expect(second.controller.burnChallengeNonce).not.toHaveBeenCalled();
    expect(second.controller.completeIntent).not.toHaveBeenCalled();
  });
});

describe("attack 4: abusing the chain window", () => {
  it("withholds when the nonce is outside the window, and stays inside it", async () => {
    const payer = ACCOUNT();
    const { result, reader } = await chainAttempt(payer, await payloadFor(payer), { logs: [] });

    expect(result.status).toBe(503);
    expect(result.body.error).toBe("payment_unconfirmed");
    expect(result.body.reason).toBe("unavailable");
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
    // A client cannot make the API scan backwards forever.
    expect(reader.calls.length).toBeLessThanOrEqual(MAX_SETTLEMENT_SCAN_QUERIES);
  });

  it("refuses a reverted transaction, whatever its logs claim", async () => {
    const payer = ACCOUNT();
    const { result } = await chainAttempt(payer, await payloadFor(payer), {
      receipt: { status: "reverted", transactionHash: TX_HASH, logs: [transfer({ from: payer.address })] },
    });

    expect(result.status).toBe(503);
    expect(result.body.reason).toBe("unsettled");
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
  });

  it("refuses a Transfer from another sender in the nonce's transaction", async () => {
    const payer = ACCOUNT();
    const { result } = await chainAttempt(payer, await payloadFor(payer), {
      receipt: receipt(STRANGER),
    });

    expect(result.status).toBe(503);
    expect(result.body.reason).toBe("unsettled");
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
  });

  it("refuses a receipt whose Transfer is on another contract", async () => {
    const payer = ACCOUNT();
    const { result } = await chainAttempt(payer, await payloadFor(payer), {
      receipt: receiptWith(transfer({ from: payer.address, address: ELSEWHERE })),
    });

    expect(result.status).toBe(503);
    expect(result.body.reason).toBe("unsettled");
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
  });

  it("withholds when the nonce log claims another contract", async () => {
    const payer = ACCOUNT();
    const payload = await payloadFor(payer);
    const auth = authorizationOf(payload);
    const { result } = await chainAttempt(payer, payload, {
      logs: [authUsed(auth.from, auth.nonce, ELSEWHERE)],
    });

    // A log for another contract is unreadable, not a refusal.
    expect(result.status).toBe(503);
    expect(result.body.reason).toBe("unavailable");
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
  });
});

describe("attack 5: the free path", () => {
  const priced = (priceUsd: string) => ({
    ...REQUIREMENT,
    amount: parseUsdPrice(priceUsd).amount.toString(),
  });
  const longTerms = priced("$0.20");

  async function freePathAttempt(reason: string) {
    const payer = ACCOUNT();
    return postCreate(
      ({ controller, body }) => {
        body.tier = "long";
        controller.authorizeAllowlistedPayer = vi.fn(async () => ({ allowed: false as const, reason }));
      },
      {
        account: payer,
        paymentHeader: headerOf(await payloadFor(payer, {}, longTerms)),
        requirementFor: (priceUsd: string) => priced(priceUsd),
        resourceServer: {
          verifyPayment: async () => ({ isValid: true }),
          settlePayment: async () => ({ success: true, transaction: "0xtx", network: MOCK_NETWORK }),
        },
      },
    );
  }

  it.each([
    ["an address that is not on the list", "not_allowlisted"],
    ["a disabled row", "disabled"],
    ["a tier above the entry ceiling", "tier_not_allowed"],
    ["a concurrency above the cap", "concurrency_exhausted"],
  ])("refuses %s and charges the paid price", async (_label, reason) => {
    const result = await freePathAttempt(reason);

    expect(result.status).toBe(201);
    const payment = result.controller.completeIntent.mock.calls[0]?.[1]?.payment as Record<string, unknown>;
    // Never a free row, and never a row priced by the request body.
    expect(payment.source).toBe("x402");
    expect(payment.amount).toBe("200000");
    expect(result.controller.reserveBudget).toHaveBeenCalledWith(result.authorizer, "200000");
    // The address checked is the one the commitment proved, at the tier the
    // request resolved to.
    expect(result.controller.authorizeAllowlistedPayer).toHaveBeenCalledWith(result.authorizer, "long");
  });

  it("refuses a free session when the claim on the list was signed by another key", async () => {
    const result = await postCreate(
      ({ controller }) => {
        controller.authorizeAllowlistedPayer = vi.fn(async () => ({
          allowed: true as const,
          label: "owner-agent",
          maxTier: "long" as const,
          maxConcurrent: 2,
        }));
      },
      { commitmentSigner: ACCOUNT() },
    );

    expect(result.status).toBe(401);
    expect(result.controller.authorizeAllowlistedPayer).not.toHaveBeenCalled();
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
  });

  it("refuses a replayed challenge nonce on the free path", async () => {
    const payer = ACCOUNT();
    const result = await postCreate(
      ({ controller }) => {
        controller.authorizeAllowlistedPayer = vi.fn(async () => ({
          allowed: true as const,
          label: "owner-agent",
          maxTier: "long" as const,
          maxConcurrent: 2,
        }));
        controller.burnChallengeNonce = vi.fn(async () => ({ status: "reused" as const }));
      },
      { account: payer, paymentHeader: headerOf(await payloadFor(payer)) },
    );

    expect(result.status).toBe(402);
    expect(result.body.error).toBe("challenge_nonce_reused");
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
    expect(result.controller.reserveBudget).not.toHaveBeenCalled();
  });

  it("ignores payTo and amount fabricated in the request body", async () => {
    const payer = ACCOUNT();
    const result = await postCreate(
      ({ body }) => {
        body.payTo = ELSEWHERE;
        body.amount = "1";
      },
      {
        account: payer,
        paymentHeader: headerOf(await payloadFor(payer)),
        resourceServer: {
          verifyPayment: async () => ({ isValid: true }),
          settlePayment: async () => ({ success: true, transaction: "0xtx", network: MOCK_NETWORK }),
        },
      },
    );

    expect(result.status).toBe(201);
    const payment = result.controller.completeIntent.mock.calls[0]?.[1]?.payment as Record<string, unknown>;
    expect(payment.amount).toBe("50000");
    expect(payment.payTo).toBe(REQUIREMENT.payTo);
    expect(result.controller.reserveBudget).toHaveBeenCalledWith(result.authorizer, "50000");
  });
});

describe("attack 6: the commitment", () => {
  it.each([
    ["a different payment key", { paymentKey: "0".repeat(64) }],
    ["a different challenge nonce", { challengeNonce: `cn_${"c".repeat(32)}` }],
    ["a different client key", { clientPublicKey: "z".repeat(44) }],
  ])("is refused when signed over %s", async (_label, overrides) => {
    const result = await postCreate(() => undefined, {
      commitmentMessage: (canonical) => ({ ...canonical, ...overrides }),
    });

    expect(result.status).toBe(401);
    expect(result.body.error).toBe("client_proof_invalid");
    expect(result.controller.burnChallengeNonce).not.toHaveBeenCalled();
    expect(result.controller.claimIntent).not.toHaveBeenCalled();
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
  });

  it("is refused when it recovers to an address other than the authorisation's from", async () => {
    const result = await postCreate(() => undefined, { commitmentSigner: ACCOUNT() });

    expect(result.status).toBe(401);
    expect(result.body.error).toBe("client_proof_invalid");
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
  });
});

describe("attack 7: the challenge nonce", () => {
  it.each([["reused"], ["expired"], ["unknown"]])(
    "refuses a %s nonce before capacity, budget or settlement",
    async (status) => {
      const { resourceServer, settlePayment } = facilitator();
      const result = await postCreate(
        ({ controller }) => {
          controller.burnChallengeNonce = vi.fn(async () => ({ status: status as "reused" }));
        },
        { resourceServer },
      );

      expect(result.status).toBe(402);
      expect(result.body.error).toBe(`challenge_nonce_${status}`);
      expect(result.controller.holdCapacity).not.toHaveBeenCalled();
      expect(result.controller.reserveBudget).not.toHaveBeenCalled();
      expect(result.controller.claimIntent).not.toHaveBeenCalled();
      expect(settlePayment).not.toHaveBeenCalled();
      expect(result.controller.completeIntent).not.toHaveBeenCalled();
    },
  );

  it("refuses a short-tier payment for a standard session", async () => {
    const payer = ACCOUNT();
    const result = await postCreate(() => undefined, {
      account: payer,
      paymentHeader: headerOf(
        await payloadFor(payer, {}, { ...REQUIREMENT, amount: parseUsdPrice("$0.02").amount.toString() }),
      ),
      resourceServer: facilitator().resourceServer,
      requirementFor: (priceUsd: string) => ({
        ...REQUIREMENT,
        amount: parseUsdPrice(priceUsd).amount.toString(),
      }),
    });

    expect(result.status).toBe(402);
    expect(result.body.error).toBe("payment_requirements_mismatch");
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
  });

  it("still charges the new tier's price when a nonce is used for another tier", async () => {
    const payer = ACCOUNT();
    const result = await postCreate(
      ({ body }) => {
        body.tier = "long";
      },
      {
        account: payer,
        // Quoted for `short`, presented for `long`: the nonce carries no price.
        paymentHeader: headerOf(await payloadFor(payer, {}, { ...REQUIREMENT, amount: "200000" })),
        requirementFor: (priceUsd: string) => ({
          ...REQUIREMENT,
          amount: parseUsdPrice(priceUsd).amount.toString(),
        }),
        resourceServer: facilitator().resourceServer,
      },
    );

    expect(result.status).toBe(201);
    const payment = result.controller.completeIntent.mock.calls[0]?.[1]?.payment as Record<string, unknown>;
    expect(payment.amount).toBe("200000");
  });
});

describe("attack 8: configuration that would enable it", () => {
  const base = {
    ALLOW_INSECURE_DEV: "true",
    CONTROLLER_ADMIN_TOKEN: "a".repeat(32),
    CAPABILITY_SECRET: "b".repeat(32),
  };
  const mainnet = {
    ...base,
    PAYMENT_MODE: "mainnet",
    // Real money and the dev switch are mutually exclusive, so a mainnet case
    // turns it off; the pair itself is the first thing below.
    ALLOW_INSECURE_DEV: "false",
    NETWORK: "eip155:8453",
    PAY_TO: "0x1111111111111111111111111111111111111111",
    FACILITATOR_URL: "https://facilitator.example.test",
    PAYMENT_RPC_URL: "https://mainnet.base.org",
  };

  it("refuses real payments while the insecure dev switch is on", () => {
    expect(() => loadConfig({ ...mainnet, ALLOW_INSECURE_DEV: "true" })).toThrow(
      /PAYMENT_MODE=mainnet requires ALLOW_INSECURE_DEV=false/,
    );
  });

  it("refuses mainnet with the mock PAY_TO", () => {
    expect(() =>
      loadConfig({ ...mainnet, PAY_TO: "0x0000000000000000000000000000000000000402" }),
    ).toThrow(/real receiving address/);
  });

  it("refuses mainnet without an on-chain verifier", () => {
    const { PAYMENT_RPC_URL, ...rest } = mainnet;
    void PAYMENT_RPC_URL;
    expect(() => loadConfig(rest)).toThrow(/PAYMENT_RPC_URL/);
  });

  it("refuses a key pair over a plain-http facilitator", () => {
    expect(() =>
      loadConfig({
        ...base,
        FACILITATOR_URL: "http://facilitator.example.test",
        FACILITATOR_API_KEY_ID: "id",
        FACILITATOR_API_KEY_SECRET: "secret",
      }),
    ).toThrow(/https/);
  });
});
