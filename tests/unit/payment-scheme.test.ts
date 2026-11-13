/**
 * What a price becomes on the wire, and the window a client signs for it.
 *
 * `shared/src/payment.ts` decides whether an authorization is spendable, so a
 * mutant here is a security defect rather than a style opinion. The two blocks
 * below exist because a specific wrong answer would still pass a suite that
 * only calls the happy path:
 *
 *  - a price that silently coerces (`"abc"` to 0, or a float rounded to the
 *    nearest atomic unit) is a free or mis-charged session;
 *  - an authorization that starts in the future, or one with no expiry, is a
 *    captured payment the attacker can replay whenever they like.
 *
 * What the facilitator accepts is in `payment-authorization.test.ts`. The wire
 * literals are in `payment-wire-contract.test.ts`, which imports the module
 * dynamically so Stryker's static mutants can be killed.
 *
 * The price property test calls fast-check from this directory on purpose:
 * Stryker runs `tests/unit`, `tests/fuzz` and `tests/transfers` per mutant, so a
 * property that lived only in `tests/property` would not defend the mutant it
 * is written for.
 */
import fc from "fast-check";
import type { PaymentPayload } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";
import { verifyTypedData } from "viem";
import {
  MOCK_ASSET,
  MOCK_ASSET_DECIMALS,
  MockExactClientScheme,
  MockExactFacilitatorScheme,
  MockExactServerScheme,
  PAYMENT_VERSION,
  type MockAuthorization,
} from "../../shared/src/entries/payment.js";
import {
  NETWORK,
  NOW_MS,
  NOW_SEC,
  RecordingNonceStore,
  clientAccount,
  facilitator,
  requirements,
} from "../helpers/mock-scheme.js";

describe("the mock scheme's declared capabilities", () => {
  it("declares the flow and asset metadata the challenge advertises", async () => {
    const server = new MockExactServerScheme();
    expect(server.scheme).toBe("exact");
    expect(server.defaultAssetTransferMethod).toBe("mock");
    expect(server.paymentFlows.mock).toEqual({
      supported: ["authorization"],
      default: "authorization",
    });

    const scheme = new MockExactFacilitatorScheme(
      { store: new RecordingNonceStore(), network: NETWORK },
      verifyTypedData as never,
    );
    expect(scheme.caipFamily).toBe("mock:*");
    expect(scheme.getExtra(NETWORK)).toEqual({
      assetDecimals: 6,
      settlement: "mock-offchain",
    });
    // No on-chain signer exists in mock mode, and claiming one would make a
    // client look for a settlement that never happens.
    expect(scheme.getSigners(String(NETWORK))).toEqual([]);

    // Requirements are handed through unchanged: the 402 challenge the API
    // builds is the object the facilitator verifies.
    const req = requirements();
    expect(await server.enhancePaymentRequirements(req)).toBe(req);
  });
});

describe("parsePrice", () => {
  const scheme = new MockExactServerScheme();

  it("turns a decimal price into atomic units of the mock asset", async () => {
    expect(await scheme.parsePrice("0.05", NETWORK)).toEqual({
      amount: "50000",
      asset: "mock:usdc",
      extra: { decimals: 6 },
    });
    // The number form takes the same path: the 402 challenge is built from
    // whichever shape the caller had.
    expect(await scheme.parsePrice(0.05, NETWORK)).toEqual({
      amount: "50000",
      asset: "mock:usdc",
      extra: { decimals: 6 },
    });
    // A price object is already atomic and carries its own asset, so it must
    // not be rounded through the USD parser or relabelled as the mock asset.
    expect(
      await scheme.parsePrice({ amount: "7000000000000000000", asset: "eip155:84532/usdc" }, NETWORK),
    ).toEqual({ amount: "7000000000000000000", asset: "eip155:84532/usdc", extra: {} });
  });

  it("reports the asset's decimals alongside the amount", async () => {
    const parsed = await scheme.parsePrice("1", NETWORK);
    expect(parsed.extra.decimals).toBe(6);
    expect(parsed.extra.decimals).toBe(MOCK_ASSET_DECIMALS);
    expect(parsed.asset).toBe(MOCK_ASSET);
  });

  it("is exact where binary floating point would drift", async () => {
    // 1.005 is the classic case: as a double it is 1.00499999999999989, so a
    // price that went through Number() would be one atomic unit short.
    expect((await scheme.parsePrice("1.005", NETWORK)).amount).toBe("1005000");
    expect((await scheme.parsePrice("0.1", NETWORK)).amount).toBe("100000");
    expect((await scheme.parsePrice("0.2", NETWORK)).amount).toBe("200000");
    // Two prices that are exact in atomic units add up to the exact total.
    const tenth = await scheme.parsePrice(0.1, NETWORK);
    const fifth = await scheme.parsePrice(0.2, NETWORK);
    const third = await scheme.parsePrice("0.3", NETWORK);
    expect(BigInt(tenth.amount) + BigInt(fifth.amount)).toBe(BigInt(third.amount));

    // The edges of the six-decimal grid, and a value beyond 2^53 atomic units.
    expect((await scheme.parsePrice("0.000001", NETWORK)).amount).toBe("1");
    expect((await scheme.parsePrice("123456789.123456", NETWORK)).amount).toBe(
      "123456789123456",
    );
  });

  it("rejects a malformed or negative price instead of coercing it", async () => {
    for (const price of ["", "free", "0.1234567", "-1", "-0.05", "$-1", "1e6", "0.0.0"]) {
      await expect(scheme.parsePrice(price, NETWORK), `price ${JSON.stringify(price)}`).rejects.toThrow(
        /invalid price/,
      );
    }
    // A float that drifted past the six-decimal grid is malformed, not rounded:
    // 0.1 + 0.2 is 0.30000000000000004 in binary floating point.
    await expect(scheme.parsePrice(0.1 + 0.2, NETWORK)).rejects.toThrow(/invalid price/);
    // A null price is a caller bug, and it has to be refused as a price rather
    // than crash on `"amount" in null`.
    await expect(scheme.parsePrice(null as never, NETWORK)).rejects.toThrow(/invalid price/);
  });

  it("matches a bigint reference over every decimal string shape it accepts", async () => {
    const price = fc
      .tuple(fc.stringMatching(/^\d{1,18}$/), fc.stringMatching(/^\d{1,6}$/))
      .map(([whole, frac]) => `${whole}.${frac}`);
    const wholeOnly = fc.stringMatching(/^\d{1,18}$/);
    const dollar = fc
      .tuple(fc.stringMatching(/^\d{1,18}$/), fc.stringMatching(/^\d{1,6}$/))
      .map(([whole, frac]) => `$${whole}.${frac}`);

    await fc.assert(
      fc.asyncProperty(fc.oneof(price, wholeOnly, dollar), async (text) => {
        const trimmed = text.replace(/^\$/, "");
        const [whole = "0", frac = ""] = trimmed.split(".");
        const expected = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
        const parsed = await scheme.parsePrice(text, NETWORK);
        expect(parsed.amount).toBe(expected.toString());
        expect(parsed.asset).toBe("mock:usdc");
        expect(parsed.extra).toEqual({ decimals: 6 });
      }),
      { numRuns: 200 },
    );
  });

  it("rejects every string that is not a decimal price", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ maxLength: 12 })
          .filter((value) => !/^\$?\d+(\.\d{1,6})?$/.test(value.trim())),
        async (value) => {
          await expect(scheme.parsePrice(value, NETWORK)).rejects.toThrow(/invalid price/);
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe("the validity window a client signs", () => {
  function paymentWith(maxTimeoutSeconds: number) {
    const account = clientAccount();
    const scheme = new MockExactClientScheme(account);
    return scheme.createPaymentPayload(
      PAYMENT_VERSION,
      requirements({ maxTimeoutSeconds }),
    ) as unknown as Promise<{ payload: { authorization: MockAuthorization } }>;
  }

  async function authorizationFor(maxTimeoutSeconds: number): Promise<MockAuthorization> {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
    try {
      const partial = await paymentWith(maxTimeoutSeconds);
      return partial.payload.authorization;
    } finally {
      clock.mockRestore();
    }
  }

  it("is valid now and not sixty seconds in the future", async () => {
    const auth = await authorizationFor(300);
    const validAfter = Number(auth.validAfter);
    const validBefore = Number(auth.validBefore);
    expect(validAfter).toBe(NOW_SEC - 60);
    expect(validAfter).toBeLessThan(NOW_SEC);
    expect(validBefore).toBeGreaterThan(NOW_SEC);
    // The signed window is the payment's timeout, counted from now.
    expect(validBefore).toBe(NOW_SEC + 300);
  });

  it("uses the challenge timeout when it is longer than a minute", async () => {
    expect(Number((await authorizationFor(600)).validBefore)).toBe(NOW_SEC + 600);
    // A timeout shorter than the clock-skew floor keeps the floor, so a client
    // cannot sign an authorization that expires while it is still in flight.
    expect(Number((await authorizationFor(1)).validBefore)).toBe(NOW_SEC + 60);
    // An unset (zero) timeout falls back to the default window rather than
    // signing something already expired.
    expect(Number((await authorizationFor(0)).validBefore)).toBe(NOW_SEC + 300);
  });

  it("signs a payload the facilitator accepts as it stands", async () => {
    // The window and the signature have to agree: sign with one clock and
    // verify with the same one, or this fails for a reason unrelated to the
    // guards below.
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
    try {
      const partial = await new MockExactClientScheme(clientAccount()).createPaymentPayload(
        PAYMENT_VERSION,
        requirements(),
      );
      const payload = {
        x402Version: 2,
        accepted: requirements(),
        payload: partial.payload,
      } as unknown as PaymentPayload;
      const { scheme, store } = facilitator();
      const verify = await scheme.verify(payload, requirements());
      expect(verify.isValid).toBe(true);
      expect(verify.payer).toBeDefined();

      // A settled payment names the transaction the ledger records, and the
      // nonce store is handed the key and amount recovery reconciles against.
      const settle = await scheme.settle(payload, requirements());
      expect(settle.success).toBe(true);
      expect(settle.transaction).toMatch(/^mock:[0-9a-f]{32}$/);
      const claim = store.claims[0];
      expect(claim?.meta).toEqual({
        payer: verify.payer,
        paymentKey: expect.stringMatching(/^[0-9a-f]{64}$/),
        amount: "50000",
      });

      // A replay is refused by the nonce store and says so, without inventing
      // a transaction for the second attempt.
      const replay = await scheme.settle(payload, requirements());
      expect(replay.success).toBe(false);
      expect(replay.errorReason).toBe("nonce_already_used");
      expect(replay.errorMessage).toBe(
        "this authorization has already been settled (replay rejected)",
      );
      expect(replay.transaction).toBe("");
    } finally {
      clock.mockRestore();
    }
  });
});
