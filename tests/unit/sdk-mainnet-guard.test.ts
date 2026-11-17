/**
 * The mainnet payer is the same client and the same exchange as testnet; the
 * only difference is which chain the money moves on.
 *
 * That makes it one forgotten flag away from spending a customer's balance, so
 * the behaviour pinned here is the guard: an unset acknowledgement is a refusal
 * rather than a default.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createPayer } from "../../sdk/src/payment.js";

// A well-formed key: the guard must fire on the acknowledgement, not on the key.
const KEY = "0x" + "11".repeat(32);

const saved = { pk: process.env.EVM_PRIVATE_KEY, ack: process.env.CONFIRM_REAL_MONEY };
afterEach(() => {
  if (saved.pk === undefined) delete process.env.EVM_PRIVATE_KEY;
  else process.env.EVM_PRIVATE_KEY = saved.pk;
  if (saved.ack === undefined) delete process.env.CONFIRM_REAL_MONEY;
  else process.env.CONFIRM_REAL_MONEY = saved.ack;
});

describe("mainnet payer", () => {
  it("refuses without an explicit acknowledgement", () => {
    process.env.EVM_PRIVATE_KEY = KEY;
    delete process.env.CONFIRM_REAL_MONEY;
    // Nothing has been spent and nothing has been signed: a missing
    // acknowledgement cannot be read as consent.
    expect(() => createPayer("mainnet")).toThrow(/CONFIRM_REAL_MONEY=yes/);
  });

  it("refuses an acknowledgement that is not exactly yes", () => {
    process.env.EVM_PRIVATE_KEY = KEY;
    process.env.CONFIRM_REAL_MONEY = "true";
    expect(() => createPayer("mainnet")).toThrow(/CONFIRM_REAL_MONEY=yes/);
  });

  it("builds once acknowledged, and reports the mode it will spend in", () => {
    process.env.EVM_PRIVATE_KEY = KEY;
    process.env.CONFIRM_REAL_MONEY = "yes";
    const payer = createPayer("mainnet");
    // The mode is what the CLI prints to the operator before any request.
    expect(payer.mode).toBe("mainnet");
  });

  it("still needs a key, even acknowledged", () => {
    delete process.env.EVM_PRIVATE_KEY;
    process.env.CONFIRM_REAL_MONEY = "yes";
    expect(() => createPayer("mainnet")).toThrow(/EVM_PRIVATE_KEY/);
  });
});
