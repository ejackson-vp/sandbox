/**
 * The x402 wire literals, as bytes a client and a facilitator agree on.
 *
 * `MOCK_SCHEME` and `MOCK_ASSET` are module-level constants, and every other
 * test in the suite builds its payload from those same constants. So a mutant
 * that changes "exact" to "" or "mock:usdc" to "" travels through the whole
 * suite unnoticed: both sides move together and every assertion still holds.
 * Only a test that restates the literal can fail.
 *
 * The import is dynamic on purpose. Stryker activates a static mutant around
 * the test that covers it, but a top-level `const` is evaluated when the module
 * is first imported, which for a static import happens before that activation.
 * Importing inside the test means the module is evaluated while the mutant is
 * the active one, so this file can actually kill the mutant it exists for.
 * That is also why this file imports nothing else from the payment module: a
 * static import here would load it early and quietly undo the point.
 */
import { describe, expect, it } from "vitest";

describe("the mock payment wire contract", () => {
  it("pins the scheme, asset and network a client signs for", async () => {
    const payment = await import("../../shared/src/payment.js");

    expect(payment.PAYMENT_VERSION).toBe(2);
    expect(payment.MOCK_NETWORK).toBe("mock:local");
    expect(payment.MOCK_SCHEME).toBe("exact");
    expect(payment.MOCK_ASSET).toBe("mock:usdc");
    expect(payment.MOCK_ASSET_DECIMALS).toBe(6);
    // Mainnet is not a supported target; the only real network is Base
    // Sepolia, and a wrong CAIP-2 string would point a client at the wrong
    // chain rather than fail loudly.
    expect(payment.TESTNET_NETWORK).toBe("eip155:84532");
  });

  it("pins the EIP-712 domain a signature is bound to", async () => {
    const { MOCK_EIP712_DOMAIN, MOCK_AUTHORIZATION_TYPES } = await import(
      "../../shared/src/payment.js"
    );

    // A client signs this domain and the facilitator verifies against it. If
    // the name or version moved, every signature would verify against a
    // different domain than the one advertised, which is a silent
    // interoperability break rather than a crash.
    expect(MOCK_EIP712_DOMAIN).toMatchObject({
      name: "x402 Mock USD",
      version: "1",
      chainId: 0,
      verifyingContract: "0x0000000000000000000000000000000000000402",
    });
    expect(MOCK_AUTHORIZATION_TYPES.TransferWithAuthorization.map((field) => field.name)).toEqual([
      "from",
      "to",
      "value",
      "validAfter",
      "validBefore",
      "nonce",
    ]);
  });
});
