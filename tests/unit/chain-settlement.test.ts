/**
 * On-chain settlement verification (F-10).
 *
 * The gate that matters: a facilitator answer is not authority. A session is
 * granted only when the EIP-3009 nonce is used on chain, and the same check is
 * what recovers a payment that settled before the API crashed.
 */
import { describe, expect, it, vi } from "vitest";
import { UnsupportedSettlementLookup } from "@x402s/shared/runtime";
import {
  AUTHORIZATION_STATE_ABI,
  UsdcAuthorizationStateVerifier,
  usdcAddressFor,
} from "../../api/src/payments/settlement-verifier.js";
import { buildSettlementVerifier } from "../../api/src/payments/settlement-confirmation.js";
import { postCreate } from "../helpers/create-route.js";

function settledResourceServer(settle: () => Promise<unknown> = async () => ({
  success: true,
  transaction: "0xtx",
  network: "mock:local",
  payer: "0xpayer",
})) {
  return { verifyPayment: async () => ({ isValid: true }), settlePayment: settle };
}

describe("chain-verified settlement", () => {
  it("grants when the settled nonce is confirmed on chain", async () => {
    const isSettled = vi.fn(async () => true);
    const result = await postCreate(
      () => undefined,
      { settlementVerifier: { isSettled }, resourceServer: settledResourceServer() },
    );

    expect(result.status).toBe(201);
    // The check is on the address that signed the payment and the nonce in it,
    // never on a field the client merely claims.
    expect(isSettled).toHaveBeenCalledWith(result.authorizer, result.settlementNonce);
    expect(result.controller.completeIntent).toHaveBeenCalledTimes(1);
  });

  it("refuses a settle the chain has not seen", async () => {
    const result = await postCreate(
      () => undefined,
      {
        settlementVerifier: { isSettled: async () => false },
        resourceServer: settledResourceServer(),
      },
    );

    expect(result.status).toBe(503);
    expect(result.body.error).toBe("payment_unconfirmed");
    expect(result.body.reason).toBe("unsettled");
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
    // The money may exist, so the intent stays claimed for recovery and the
    // capacity hold stays until its TTL.
    expect(result.controller.failIntent).not.toHaveBeenCalled();
    expect(result.controller.releaseCapacity).not.toHaveBeenCalled();
  });

  it("refuses when the verifier errors, rather than granting", async () => {
    const result = await postCreate(
      () => undefined,
      {
        settlementVerifier: {
          isSettled: async () => {
            throw new Error("rpc unavailable");
          },
        },
        resourceServer: settledResourceServer(),
      },
    );

    expect(result.status).toBe(503);
    expect(result.body.error).toBe("payment_unconfirmed");
    expect(result.body.reason).toBe("unavailable");
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
  });

  it("leaves the mock path unchanged when no verifier is configured", async () => {
    const result = await postCreate(
      () => undefined,
      { resourceServer: settledResourceServer() },
    );

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
        settlementVerifier: { isSettled: async () => true },
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

  it("does not recover when the chain says the nonce is unused", async () => {
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
        settlementVerifier: { isSettled: async () => false },
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
  });
  it("completes when the settle answer is lost but the nonce is on chain", async () => {
    const isSettled = vi.fn(async () => true);
    const result = await postCreate(
      () => undefined,
      {
        settlementVerifier: { isSettled },
        resourceServer: settledResourceServer(async () => {
          throw new Error("socket hang up");
        }),
      },
    );

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

  it("refuses a lost settle the chain has not seen", async () => {
    const result = await postCreate(
      () => undefined,
      {
        settlementVerifier: { isSettled: async () => false },
        resourceServer: settledResourceServer(async () => {
          throw new Error("socket hang up");
        }),
      },
    );

    expect(result.status).toBe(402);
    expect(result.body.error).toBe("payment_settle_failed");
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
    // Nothing can be granted, but the intent stays claimed: the transfer may
    // still land after this answer.
    expect(result.controller.failIntent).not.toHaveBeenCalled();
  });

  it("completes a settlement_pending answer the chain confirms", async () => {
    const result = await postCreate(
      () => undefined,
      {
        settlementVerifier: { isSettled: async () => true },
        resourceServer: settledResourceServer(async () => ({
          success: false,
          errorReason: "settlement_pending",
          transaction: "",
          network: "mock:local",
        })),
      },
    );

    expect(result.status).toBe(201);
    expect(result.controller.completeIntent).toHaveBeenCalledTimes(1);
  });
});

describe("USDC authorizationState verifier", () => {
  const USDC = usdcAddressFor("eip155:8453")!;
  const AUTHORIZER = "0x1111111111111111111111111111111111111111" as const;
  const NONCE = `0x${"a".repeat(64)}` as `0x${string}`;

  it("reads authorizationState on the configured USDC contract", async () => {
    const readContract = vi.fn(async () => true);
    const verifier = new UsdcAuthorizationStateVerifier({
      rpcUrl: "https://rpc.invalid",
      usdcAddress: USDC,
      readContract,
    });

    await expect(verifier.isSettled(AUTHORIZER, NONCE)).resolves.toBe(true);
    expect(readContract).toHaveBeenCalledWith({
      address: USDC,
      abi: AUTHORIZATION_STATE_ABI,
      functionName: "authorizationState",
      args: [AUTHORIZER, NONCE],
    });
  });

  it("treats an unreadable answer as an error, not as settlement", async () => {
    const verifier = new UsdcAuthorizationStateVerifier({
      rpcUrl: "https://rpc.invalid",
      usdcAddress: USDC,
      readContract: async () => "0x1",
    });
    await expect(verifier.isSettled(AUTHORIZER, NONCE)).rejects.toThrow(/non-boolean/);
  });

  it("builds no verifier for the mock path and none without an RPC URL", () => {
    expect(
      buildSettlementVerifier({ paymentMode: "mock", network: "mock:local" }),
    ).toBeUndefined();
    expect(
      buildSettlementVerifier({ paymentMode: "testnet", network: "eip155:84532" }),
    ).toBeUndefined();
  });

  it("defaults the contract address per network and honours an override", () => {
    const built = buildSettlementVerifier({
      paymentMode: "testnet",
      network: "eip155:84532",
      paymentRpcUrl: "https://rpc.invalid",
    });
    expect(built).toBeInstanceOf(UsdcAuthorizationStateVerifier);
    expect(
      buildSettlementVerifier({
        paymentMode: "testnet",
        network: "eip155:84532",
        paymentRpcUrl: "https://rpc.invalid",
        paymentUsdcAddress: "0x2222222222222222222222222222222222222222",
      }),
    ).toBeInstanceOf(UsdcAuthorizationStateVerifier);
  });
});
