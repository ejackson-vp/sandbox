/**
 * What the mock facilitator accepts, and what it refuses.
 *
 * `shared/src/payment.ts` is the only code that decides whether an
 * authorization is spendable, so a surviving mutant here is a security defect
 * rather than a style opinion. Each block below exists because a specific
 * wrong answer would still pass a suite that only calls the happy path:
 *
 *  - a facilitator that accepts a stale or not-yet-valid authorization lets a
 *    captured payment be replayed whenever the attacker likes;
 *  - a window longer than the ceiling is an authorization the operator cannot
 *    reason about;
 *  - a malformed signature that throws becomes a 500 instead of a refusal;
 *  - `settle()` has no catch wrapper, so a payload it refuses has to be
 *    refused by `validate()` before anything touches the nonce store.
 *
 * The payloads are signed with a real wallet, so a refusal here is the guard
 * firing and not a signature that happened to be wrong.
 */
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { verifyTypedData } from "viem";
import { MockExactFacilitatorScheme, type MockAuthorization } from "../../shared/src/entries/payment.js";
import {
  NETWORK,
  NOW_SEC,
  PAY_TO,
  RecordingNonceStore,
  authorizedPayload,
  clientAccount,
  facilitator,
  requirements,
  signAuthorization,
} from "../helpers/mock-scheme.js";

describe("EIP-3009 validity guards", () => {
  it("rejects an authorization whose window has closed", async () => {
    const account = clientAccount();
    for (const [validBefore, label] of [
      [NOW_SEC - 3600, "an hour ago"],
      [NOW_SEC, "exactly now"],
    ] as const) {
      const payload = await authorizedPayload(account, { validAfter: NOW_SEC - 3660, validBefore });
      const { scheme, store } = facilitator();
      const verify = await scheme.verify(payload, requirements());
      expect(verify.isValid, label).toBe(false);
      expect(verify.invalidReason, label).toBe("expired");
      expect(verify.invalidMessage, label).toBe("authorization expired");

      // Settle refuses it with the same reason, and no nonce is spent: a stale
      // authorization must not consume the payer's nonce or reach the ledger.
      const settle = await scheme.settle(payload, requirements());
      expect(settle.success, label).toBe(false);
      expect(settle.errorReason, label).toBe("expired");
      expect(store.claims, label).toEqual([]);
    }
  });

  it("uses the wall clock when no clock is injected", async () => {
    // The controller builds the facilitator without a clock, so the default is
    // the one that guards real traffic. An authorization that expired long ago
    // must still be refused when `now` comes from Date.now().
    const realNow = Math.floor(Date.now() / 1000);
    const payload = await authorizedPayload(clientAccount(), {
      validAfter: realNow - 3660,
      validBefore: realNow - 3600,
    });
    const scheme = new MockExactFacilitatorScheme(
      { store: new RecordingNonceStore(), network: NETWORK },
      verifyTypedData as never,
    );
    const refused = await scheme.verify(payload, requirements());
    expect(refused.isValid).toBe(false);
    expect(refused.invalidReason).toBe("expired");
  });

  it("accepts the sixty-second clock-skew allowance and refuses beyond it", async () => {
    const account = clientAccount();
    // Exactly sixty seconds of skew is tolerated, because a client clock can
    // be that wrong; one second more is an authorization from the future.
    const allowed = await authorizedPayload(account, {
      validAfter: NOW_SEC + 60,
      validBefore: NOW_SEC + 300,
    });
    const accepted = await facilitator().scheme.verify(allowed, requirements());
    expect(accepted.isValid).toBe(true);

    // A start time inside the allowance is fine, which is the ordinary case
    // for a client whose clock is a few seconds behind.
    const justStarted = await authorizedPayload(account, {
      validAfter: NOW_SEC - 30,
      validBefore: NOW_SEC + 300,
    });
    expect((await facilitator().scheme.verify(justStarted, requirements())).isValid).toBe(true);

    const ahead = await authorizedPayload(account, {
      validAfter: NOW_SEC + 61,
      validBefore: NOW_SEC + 300,
    });
    const refused = await facilitator().scheme.verify(ahead, requirements());
    expect(refused.isValid).toBe(false);
    expect(refused.invalidReason).toBe("not_yet_valid");
    expect(refused.invalidMessage).toBe("authorization not yet valid");
  });

  it("refuses a window longer than the facilitator's ceiling", async () => {
    const account = clientAccount();

    // The default ceiling is 900 seconds from now. The boundary is accepted
    // and one second beyond it is not, which is what stops a client asking for
    // a week-long authorization.
    const atCeiling = await authorizedPayload(account, {
      validAfter: NOW_SEC - 60,
      validBefore: NOW_SEC + 900,
    });
    expect((await facilitator().scheme.verify(atCeiling, requirements())).isValid).toBe(true);

    const tooLong = await authorizedPayload(account, {
      validAfter: NOW_SEC - 60,
      validBefore: NOW_SEC + 901,
    });
    const refused = await facilitator().scheme.verify(tooLong, requirements());
    expect(refused.isValid).toBe(false);
    expect(refused.invalidReason).toBe("validity_too_long");
    expect(refused.invalidMessage).toBe("authorization validity window is too long");

    // A configured ceiling replaces the default rather than sitting beside it.
    const shortWindow = await authorizedPayload(account, {
      validAfter: NOW_SEC - 60,
      validBefore: NOW_SEC + 120,
    });
    const strict = await facilitator({ maxValiditySeconds: 30 }).scheme.verify(
      shortWindow,
      requirements(),
    );
    expect(strict.isValid).toBe(false);
    expect(strict.invalidReason).toBe("validity_too_long");
  });
});

describe("signature verification failures", () => {
  it("answers a throwing verifier with invalid_signature, never an exception", async () => {
    const payload = await authorizedPayload(clientAccount());
    const { scheme, store } = facilitator({
      verifier: async () => {
        // What viem does for an unparseable v/r/s: it throws before it can
        // answer. The facilitator's contract is that this is a refusal.
        throw new Error('invalid signature: could not parse "v"');
      },
    });

    const verify = await scheme.verify(payload, requirements());
    expect(verify.isValid).toBe(false);
    expect(verify.invalidReason).toBe("invalid_signature");
    expect(verify.invalidMessage).toBe("authorization signature is invalid");

    // Settle goes through the same guard, so a malformed signature is not a
    // 500 on the settlement path either.
    const settle = await scheme.settle(payload, requirements());
    expect(settle.success).toBe(false);
    expect(settle.errorReason).toBe("invalid_signature");
    expect(store.claims).toEqual([]);
  });

  it("treats a verifier that answers false as a failure", async () => {
    const payload = await authorizedPayload(clientAccount());
    // A boolean verifier returning false is the ordinary wrong-signature case.
    // If the default were anything but "not verified", this payload would be
    // accepted without a valid signature.
    const { scheme, store } = facilitator({ verifier: async () => false });

    const verify = await scheme.verify(payload, requirements());
    expect(verify.isValid).toBe(false);
    expect(verify.invalidReason).toBe("invalid_signature");
    expect(store.claims).toEqual([]);
  });

  it("treats an unparseable v/r/s value as a refusal", async () => {
    // Real viem against a signature that is the right length and the wrong
    // shape, which is what a hand-edited header looks like.
    const payload = await authorizedPayload(clientAccount());
    const broken = {
      ...payload,
      payload: { ...(payload.payload as Record<string, unknown>), signature: "0xnothex" },
    } as PaymentPayload;
    const { scheme } = facilitator();
    const verify = await scheme.verify(broken, requirements());
    expect(verify.isValid).toBe(false);
    expect(verify.invalidReason).toBe("invalid_signature");
  });
});

describe("settle refuses malformed payloads before touching the nonce store", () => {
  /** A shape-correct authorization, so a test can break exactly one field. */
  const validAuth = {
    from: `0x${"1".repeat(40)}`,
    to: PAY_TO,
    value: "50000",
    validAfter: String(NOW_SEC - 60),
    validBefore: String(NOW_SEC + 300),
    nonce: `0x${"a".repeat(64)}`,
  };
  const dummySignature = `0x${"11".repeat(65)}`;

  const MISSING = "missing authorization or signature";
  const malformed: Array<[string, unknown, string]> = [
    ["no payload body", {}, MISSING],
    ["payload body null", null, MISSING],
    ["authorization missing", { signature: dummySignature }, MISSING],
    ["authorization null", { authorization: null, signature: dummySignature }, MISSING],
    ["authorization not an object", { authorization: "0xdeadbeef", signature: dummySignature }, MISSING],
    ["signature not a string", { authorization: validAuth, signature: 7 }, MISSING],
    // The address and nonce regexes are the only shape checks between the wire
    // and the signature. An unanchored one accepts a value with a tail, and
    // the refusal would then name the signature instead of the payload.
    [
      "sender address with a trailing tail",
      { authorization: { ...validAuth, from: `${validAuth.from}zz` }, signature: dummySignature },
      "invalid address",
    ],
    [
      "sender address with a leading tail",
      { authorization: { ...validAuth, from: `junk${validAuth.from}` }, signature: dummySignature },
      "invalid address",
    ],
    [
      "recipient address with a trailing tail",
      { authorization: { ...validAuth, to: `${PAY_TO}zz` }, signature: dummySignature },
      "invalid address",
    ],
    [
      "recipient address with a leading tail",
      { authorization: { ...validAuth, to: `junk${PAY_TO}` }, signature: dummySignature },
      "invalid address",
    ],
    [
      "nonce with a trailing tail",
      { authorization: { ...validAuth, nonce: `${validAuth.nonce}zz` }, signature: dummySignature },
      "invalid nonce",
    ],
    [
      "nonce with a leading tail",
      { authorization: { ...validAuth, nonce: `junk${validAuth.nonce}` }, signature: dummySignature },
      "invalid nonce",
    ],
  ];

  for (const [label, body, message] of malformed) {
    it(`refuses ${label} without claiming a nonce`, async () => {
      const { scheme, store } = facilitator();
      const payload = {
        x402Version: 2,
        accepted: requirements(),
        payload: body,
      } as unknown as PaymentPayload;

      const verify = await scheme.verify(payload, requirements());
      expect(verify.isValid, label).toBe(false);
      expect(verify.invalidReason, label).toBe("malformed_payload");
      // The message names the check that refused it, which is how an operator
      // tells a truncated header from a wrong signature.
      expect(verify.invalidMessage, label).toBe(message);

      const settle = await scheme.settle(payload, requirements());
      expect(settle.success, label).toBe(false);
      expect(settle.errorReason, label).toBe("malformed_payload");
      // No transaction exists for a payload that never reached the ledger.
      expect(settle.transaction, label).toBe("");
      // The nonce store is the replay guard. A refused payload that reached it
      // would burn the nonce of a payment that was never settled.
      expect(store.claims, label).toEqual([]);
    });
  }

  it("refuses a non-numeric validity window as malformed, not as a signature failure", async () => {
    // A window that is not a safe integer cannot be compared with the clock.
    // The refusal has to name the payload, so an operator does not chase a
    // signature problem that is really a broken authorization.
    const payload = {
      x402Version: 2,
      accepted: requirements(),
      payload: {
        authorization: {
          from: `0x${"1".repeat(40)}`,
          to: PAY_TO,
          value: "50000",
          validAfter: "not-a-number",
          validBefore: String(NOW_SEC + 300),
          nonce: `0x${"a".repeat(64)}`,
        },
        signature: dummySignature,
      },
    } as unknown as PaymentPayload;

    const { scheme, store } = facilitator();
    const verify = await scheme.verify(payload, requirements());
    expect(verify.isValid).toBe(false);
    expect(verify.invalidReason).toBe("malformed_payload");
    expect(verify.invalidMessage).toMatch(/validity window/);

    const settle = await scheme.settle(payload, requirements());
    expect(settle.success).toBe(false);
    expect(settle.errorReason).toBe("malformed_payload");
    expect(store.claims).toEqual([]);
  });

  it("answers malformed_payload for an accepted block with a field missing", async () => {
    // `accepted.payTo` used to be read before any shape check on accepted, so a
    // decoded payload with the field missing threw inside `validate`. Verify
    // swallowed that and said "could not parse payment" while settle let it
    // escape and the facilitator's handler turned it into a 500. The shape is
    // now checked first, so both entry points refuse it by name.
    const payload = {
      x402Version: 2,
      accepted: { ...requirements(), payTo: undefined },
      payload: {},
    } as unknown as PaymentPayload;

    const verify = await facilitator().scheme.verify(payload, requirements());
    expect(verify.isValid).toBe(false);
    expect(verify.invalidReason).toBe("malformed_payload");
    expect(verify.invalidMessage).toBe("accepted requirements are incomplete");
  });
});

/**
 * The checks that bind a payment to the thing that was priced. A mutant that
 * removes one does not change a message: it makes the facilitator accept a
 * payment for a different amount, recipient, asset or network.
 */
describe("the payment binding checks", () => {
  const OTHER_ADDRESS: `0x${string}` = `0x${"2".repeat(40)}`;

  /** The same signed authorization, with the `accepted` block rewritten. */
  function withAccepted(
    payload: PaymentPayload,
    overrides: Partial<PaymentRequirements>,
  ): PaymentPayload {
    return { ...payload, accepted: { ...requirements(), ...overrides } };
  }

  async function refusal(
    payload: PaymentPayload,
    req: PaymentRequirements = requirements(),
  ): Promise<{ valid: boolean; reason: unknown; message: unknown }> {
    const result = await facilitator().scheme.verify(payload, req);
    return { valid: result.isValid, reason: result.invalidReason, message: result.invalidMessage };
  }

  it("refuses a version other than x402 v2", async () => {
    const payload = await authorizedPayload(clientAccount());
    expect(await refusal({ ...payload, x402Version: 1 } as PaymentPayload)).toEqual({
      valid: false,
      reason: "unsupported_version",
      message: "only x402 v2 is supported",
    });
  });

  it("refuses a payload with no accepted requirements", async () => {
    const payload = await authorizedPayload(clientAccount());
    expect(await refusal({ ...payload, accepted: undefined } as unknown as PaymentPayload)).toEqual({
      valid: false,
      reason: "malformed_payload",
      message: "missing accepted requirements",
    });
  });

  it("refuses a payment for another network, on either side of the check", async () => {
    const payload = await authorizedPayload(clientAccount());
    const otherNetwork = "eip155:84532" as PaymentRequirements["network"];
    // The payload's accepted block disagrees with the requirements.
    expect(await refusal(withAccepted(payload, { network: otherNetwork }))).toEqual({
      valid: false,
      reason: "network_mismatch",
      message: "payment is for a different network",
    });
    // Both agree with each other but not with this facilitator.
    expect(
      await refusal(withAccepted(payload, { network: otherNetwork }), requirements({ network: otherNetwork })),
    ).toEqual({
      valid: false,
      reason: "network_mismatch",
      message: "payment is for a different network",
    });
  });

  it("refuses a scheme other than exact, on either side of the check", async () => {
    const payload = await authorizedPayload(clientAccount());
    expect(await refusal(withAccepted(payload, { scheme: "upto" }))).toEqual({
      valid: false,
      reason: "scheme_mismatch",
      message: "unsupported scheme",
    });
    const otherScheme = { scheme: "upto" };
    expect(await refusal(withAccepted(payload, otherScheme), requirements(otherScheme))).toEqual({
      valid: false,
      reason: "scheme_mismatch",
      message: "unsupported scheme",
    });
    // The requirements side alone: a payload for `exact` against a challenge
    // that advertises another scheme.
    expect(await refusal(payload, requirements({ scheme: "upto" }))).toEqual({
      valid: false,
      reason: "scheme_mismatch",
      message: "unsupported scheme",
    });
  });

  it("refuses a payment for a different asset, recipient or amount", async () => {
    const payload = await authorizedPayload(clientAccount());
    expect(await refusal(withAccepted(payload, { asset: "eip155:84532/usdc" }))).toEqual({
      valid: false,
      reason: "asset_mismatch",
      message: "payment asset differs from requirements",
    });
    expect(await refusal(withAccepted(payload, { payTo: OTHER_ADDRESS }))).toEqual({
      valid: false,
      reason: "payto_mismatch",
      message: "payment recipient differs from requirements",
    });
    expect(await refusal(withAccepted(payload, { amount: "1" }))).toEqual({
      valid: false,
      reason: "amount_mismatch",
      message: "payment amount differs from requirements",
    });
  });

  it("refuses an authorization signed for a different recipient or amount", async () => {
    // The accepted block matches the requirements; only the signed
    // authorization disagrees, and it carries a real signature. The recipient
    // and amount checks are what stop it, not a broken signature.
    const account = clientAccount();
    const authorization: MockAuthorization = {
      from: account.address,
      to: OTHER_ADDRESS,
      value: "50000",
      validAfter: String(NOW_SEC - 60),
      validBefore: String(NOW_SEC + 300),
      nonce: `0x${"a".repeat(64)}`,
    };
    const signature = await signAuthorization(account, authorization);
    const otherRecipient = {
      x402Version: 2,
      accepted: requirements(),
      payload: { authorization, signature },
    } as unknown as PaymentPayload;
    expect(await refusal(otherRecipient)).toEqual({
      valid: false,
      reason: "payto_mismatch",
      message: "authorization recipient differs from requirements",
    });

    // A signed authorization for one atomic unit against a 50,000-unit price.
    const cheap = await authorizedPayload(account, { value: "1" });
    expect(await refusal(cheap)).toEqual({
      valid: false,
      reason: "amount_mismatch",
      message: "authorization value differs from requirements",
    });
  });
});

describe("a malformed payload is the caller's fault on both entry points", () => {
  it("refuses a settle whose accepted requirements omit the recipient", async () => {
    // `verify` swallowed the throw from `accepted.payTo.toLowerCase()` and
    // answered malformed_payload, while `settle` let it escape and the mock
    // facilitator's handler turned a client-controlled payload into a 500.
    const payload = await authorizedPayload(clientAccount(), {});
    const incomplete = {
      ...payload,
      accepted: { ...requirements(), payTo: undefined },
    } as unknown as PaymentPayload;

    const { scheme, store } = facilitator();
    const verify = await scheme.verify(incomplete, requirements());
    expect(verify.isValid).toBe(false);
    expect(verify.invalidReason).toBe("malformed_payload");

    const settle = await scheme.settle(incomplete, requirements());
    expect(settle.success).toBe(false);
    expect(settle.errorReason).toBe("malformed_payload");
    // Nothing was reserved, so a corrected payload can still settle.
    expect(store.claims).toHaveLength(0);
  });

  it("refuses a settle whose accepted amount or asset is missing", async () => {
    const payload = await authorizedPayload(clientAccount(), {});
    for (const field of ["amount", "asset"] as const) {
      const incomplete = {
        ...payload,
        accepted: { ...requirements(), [field]: undefined },
      } as unknown as PaymentPayload;
      const { scheme } = facilitator();
      const settle = await scheme.settle(incomplete, requirements());
      expect(settle.success, field).toBe(false);
      expect(settle.errorReason, field).toBe("malformed_payload");
    }
  });
});
