/**
 * Startup configuration refusals.
 *
 * These two cases lived at the end of api-flow.test.ts but never touched the
 * stack: each is a `loadConfig` call that has to throw before anything is
 * listening. They are their own file so the guard is readable on its own and a
 * failure here cannot be confused with a broken fixture.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../api/src/config.js";

describe("configuration guards", () => {
  it("refuses mainnet", async () => {
    expect(() =>
      loadConfig({
        PAYMENT_MODE: "testnet",
        NETWORK: "eip155:8453",
        PAY_TO: "0x1111111111111111111111111111111111111111",
        CAPABILITY_SECRET: "test-only-capability-secret",
      }),
    ).toThrow(/mainnet/i);
  });

  it("refuses mock payments without the explicit dev acknowledgement", async () => {
    expect(() =>
      loadConfig({ PAYMENT_MODE: "mock", ALLOW_INSECURE_DEV: "false", CAPABILITY_SECRET: "test-only-capability-secret" }),
    ).toThrow(/insecure/i);
  });
});
