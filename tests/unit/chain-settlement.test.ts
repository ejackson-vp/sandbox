/**
 * On-chain settlement verification (F-10, F-17).
 *
 * The gate that matters: a facilitator answer is not authority, and a used
 * EIP-3009 nonce is not a payment. A session is granted only when the
 * transaction that consumed the nonce also transferred at least the server's
 * price, from the authorizer, to the server's `PAY_TO`. The same check recovers a
 * payment that settled before the API crashed.
 *
 * Every verifier here is a fake. Nothing in this file reaches an RPC.
 */
import { describe, expect, it, vi } from "vitest";
import { toEventSelector } from "viem";
import { UnsupportedSettlementLookup } from "@x402s/shared/runtime";
import {
  AUTHORIZATION_USED_EVENT,
  DEFAULT_SETTLEMENT_LOOKBACK_BLOCKS,
  TRANSFER_EVENT,
  UsdcSettlementVerifier,
  usdcAddressFor,
} from "../../api/src/payments/settlement-verifier.js";
import {
  buildSettlementVerifier,
  confirmSettledOnChain,
} from "../../api/src/payments/settlement-confirmation.js";
import { postCreate } from "../helpers/create-route.js";

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
    const isSettled = vi.fn(async () => true);
    const result = await create({ settlementVerifier: { isSettled }, resourceServer: settledResourceServer() });

    expect(result.status).toBe(201);
    // The check is on the address that signed the payment, the nonce in it, the
    // server's recipient and the server's price. Never on a field the client
    // merely claims.
    expect(isSettled).toHaveBeenCalledWith({
      authorizer: result.authorizer,
      nonce: result.settlementNonce.toLowerCase(),
      recipient: result.terms.payTo,
      amount: result.terms.amount,
    });
    expect(result.controller.completeIntent).toHaveBeenCalledTimes(1);
  });

  it("ignores a recipient or amount in the request body", async () => {
    const isSettled = vi.fn(async () => true);
    const result = await postCreate(
      ({ body }) => {
        // A client that tries to redefine "settled" for itself.
        body.payTo = "0x9999999999999999999999999999999999999999";
        body.amount = "1";
      },
      { settlementVerifier: { isSettled }, resourceServer: settledResourceServer() },
    );

    expect(result.status).toBe(201);
    expect(isSettled).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: result.terms.payTo, amount: result.terms.amount }),
    );
    expect(result.terms.amount).toBeGreaterThan(1n);
  });

  it("refuses a settle the chain has not proven", async () => {
    const result = await create({
      settlementVerifier: { isSettled: async () => false },
      resourceServer: settledResourceServer(),
    });

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
    const result = await create({
      settlementVerifier: {
        isSettled: async () => {
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
    const isSettled = vi.fn(async () => true);
    const settlePayment = vi.fn(async () => ({ success: true }));
    const result = await postCreate(
      () => undefined,
      {
        settlementVerifier: { isSettled },
        resourceServer: {
          verifyPayment: async () => ({ isValid: false, invalidReason: "invalid_signature" }),
          settlePayment,
        },
      },
    );

    expect(result.status).toBe(402);
    expect(result.body.error).toBe("payment_invalid:invalid_signature");
    expect(settlePayment).not.toHaveBeenCalled();
    // The chain verdict would be "settled" here. Making it reachable without a
    // verify that proves this payer's authorisation is what F-17 was about.
    expect(isSettled).not.toHaveBeenCalled();
    expect(result.controller.completeIntent).not.toHaveBeenCalled();
  });

  it("never reaches the chain when the verify call throws", async () => {
    const isSettled = vi.fn(async () => true);
    const result = await postCreate(
      () => undefined,
      {
        settlementVerifier: { isSettled },
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
    expect(isSettled).not.toHaveBeenCalled();
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

  it("does not recover when the chain says the payment is unproven", async () => {
    const isSettled = vi.fn(async () => false);
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
        settlementVerifier: { isSettled },
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
    expect(isSettled).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: result.terms.payTo, amount: result.terms.amount }),
    );
  });

  it("completes when the settle answer is lost but the chain proves the transfer", async () => {
    const isSettled = vi.fn(async () => true);
    const result = await create({
      settlementVerifier: { isSettled },
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

  it("refuses a lost settle the chain has not proven", async () => {
    const result = await create({
      settlementVerifier: { isSettled: async () => false },
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

  it("completes a settlement_pending answer the chain proves", async () => {
    const result = await create({
      settlementVerifier: { isSettled: async () => true },
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

const USDC = usdcAddressFor("eip155:8453")!;
const AUTHORIZER = "0x1111111111111111111111111111111111111111" as const;
const RECIPIENT = "0x2222222222222222222222222222222222222222" as const;
const STRANGER = "0x3333333333333333333333333333333333333333" as const;
const NONCE = `0x${"ab".repeat(32)}` as `0x${string}`;
const OTHER_NONCE = `0x${"cd".repeat(32)}` as `0x${string}`;
const TX_HASH = `0x${"ef".repeat(32)}` as `0x${string}`;
const AMOUNT = 50_000n;

const AUTHORIZATION_USED_TOPIC = toEventSelector(AUTHORIZATION_USED_EVENT).toLowerCase();
const TRANSFER_TOPIC = toEventSelector(TRANSFER_EVENT).toLowerCase();

const TERMS = { authorizer: AUTHORIZER, nonce: NONCE, recipient: RECIPIENT, amount: AMOUNT };

function topicOf(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

/** The FiatTokenV2 log the nonce query is supposed to match. */
function authorizationUsed(overrides: { nonce?: string; authorizer?: string; removed?: boolean } = {}) {
  return {
    address: USDC,
    topics: [AUTHORIZATION_USED_TOPIC, topicOf(overrides.authorizer ?? AUTHORIZER), (overrides.nonce ?? NONCE).toLowerCase()],
    data: "0x",
    transactionHash: TX_HASH,
    removed: overrides.removed ?? false,
  };
}

function transfer(overrides: {
  from?: string;
  to?: string;
  value?: bigint;
  address?: string;
} = {}) {
  return {
    address: overrides.address ?? USDC,
    topics: [
      TRANSFER_TOPIC,
      topicOf(overrides.from ?? AUTHORIZER),
      topicOf(overrides.to ?? RECIPIENT),
    ],
    data: word(overrides.value ?? AMOUNT),
  };
}

function receiptWith(...logs: unknown[]) {
  return { status: "success", transactionHash: TX_HASH, logs };
}

function fakeReader(
  answers: {
    head?: bigint;
    logs?: unknown;
    receipt?: unknown;
    logsError?: Error;
    headError?: Error;
    receiptError?: Error;
  } = {},
) {
  return {
    blockNumber: vi.fn(async () => {
      if (answers.headError) throw answers.headError;
      return answers.head ?? 1_000_000n;
    }),
    logs: vi.fn(async () => {
      if (answers.logsError) throw answers.logsError;
      return answers.logs ?? [authorizationUsed()];
    }),
    receipt: vi.fn(async () => {
      if (answers.receiptError) throw answers.receiptError;
      return answers.receipt ?? receiptWith(transfer());
    }),
  };
}

function verifier(reader: ReturnType<typeof fakeReader>, lookbackBlocks?: number) {
  return new UsdcSettlementVerifier({
    rpcUrl: "https://rpc.invalid",
    usdcAddress: USDC,
    reader,
    ...(lookbackBlocks !== undefined ? { lookbackBlocks } : {}),
  });
}

describe("USDC settlement verifier", () => {
  it("grants a transfer of exactly the price to the configured recipient", async () => {
    const reader = fakeReader();

    await expect(verifier(reader).isSettled(TERMS)).resolves.toBe(true);
    expect(reader.logs).toHaveBeenCalledWith({
      address: USDC,
      event: AUTHORIZATION_USED_EVENT,
      args: { authorizer: AUTHORIZER, nonce: NONCE },
      fromBlock: 1_000_000n - BigInt(DEFAULT_SETTLEMENT_LOOKBACK_BLOCKS),
      toBlock: 1_000_000n,
    });
    // The receipt is the one the log named, not a receipt of our choosing.
    expect(reader.receipt).toHaveBeenCalledWith(TX_HASH);
  });

  it("grants a transfer above the price", async () => {
    const reader = fakeReader({ receipt: receiptWith(transfer({ value: AMOUNT + 1n })) });

    await expect(verifier(reader).isSettled(TERMS)).resolves.toBe(true);
  });

  it("does not grant a transfer to a different address", async () => {
    const reader = fakeReader({ receipt: receiptWith(transfer({ to: STRANGER })) });

    await expect(verifier(reader).isSettled(TERMS)).resolves.toBe(false);
  });

  it("does not grant a transfer that is one atomic unit short", async () => {
    const reader = fakeReader({ receipt: receiptWith(transfer({ value: AMOUNT - 1n })) });

    await expect(verifier(reader).isSettled(TERMS)).resolves.toBe(false);
  });

  it("does not grant a transfer from another sender, even to the right address", async () => {
    const reader = fakeReader({ receipt: receiptWith(transfer({ from: STRANGER })) });

    await expect(verifier(reader).isSettled(TERMS)).resolves.toBe(false);
  });

  it("does not grant a transfer of another token contract", async () => {
    const reader = fakeReader({ receipt: receiptWith(transfer({ address: STRANGER })) });

    await expect(verifier(reader).isSettled(TERMS)).resolves.toBe(false);
  });

  it("does not grant a used nonce whose transaction has no matching Transfer", async () => {
    const reader = fakeReader({
      receipt: receiptWith(
        // The authorization's own log is not a transfer, and neither is an
        // unrelated one in the same transaction.
        authorizationUsed(),
        transfer({ from: STRANGER, to: STRANGER }),
      ),
    });

    await expect(verifier(reader).isSettled(TERMS)).resolves.toBe(false);
  });

  it("does not grant a reverted transaction", async () => {
    const reader = fakeReader({
      receipt: { status: "reverted", transactionHash: TX_HASH, logs: [transfer()] },
    });

    await expect(verifier(reader).isSettled(TERMS)).resolves.toBe(false);
  });

  it("rejects a receipt for a different transaction than the log named", async () => {
    const reader = fakeReader({
      receipt: { status: "success", transactionHash: `0x${"aa".repeat(32)}`, logs: [transfer()] },
    });

    await expect(verifier(reader).isSettled(TERMS)).rejects.toThrow(/different transaction/);
  });

  it("does not grant when the log is not in the window", async () => {
    const reader = fakeReader({ logs: [] });

    await expect(verifier(reader).isSettled(TERMS)).resolves.toBe(false);
    expect(reader.receipt).not.toHaveBeenCalled();
  });

  it("anchors the window to the configured lookback", async () => {
    const reader = fakeReader({ head: 1_000n });

    await verifier(reader, 30).isSettled(TERMS);

    expect(reader.logs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 970n, toBlock: 1_000n }));
  });

  it("does not run the window below genesis", async () => {
    const reader = fakeReader({ head: 5n });

    await verifier(reader, 900).isSettled(TERMS);

    expect(reader.logs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 0n, toBlock: 5n }));
  });

  it("treats a log removed by a reorg as no evidence", async () => {
    const reader = fakeReader({ logs: [authorizationUsed({ removed: true })] });

    await expect(verifier(reader).isSettled(TERMS)).resolves.toBe(false);
    expect(reader.receipt).not.toHaveBeenCalled();
  });

  it("rejects rather than answering when the log read fails", async () => {
    const reader = fakeReader({ logsError: new Error("rpc unavailable") });

    await expect(verifier(reader).isSettled(TERMS)).rejects.toThrow(/rpc unavailable/);
  });

  it("rejects rather than answering when the head read fails", async () => {
    const reader = fakeReader({ headError: new Error("timeout") });

    await expect(verifier(reader).isSettled(TERMS)).rejects.toThrow(/timeout/);
  });

  it("rejects rather than answering when the receipt read fails", async () => {
    const reader = fakeReader({ receiptError: new Error("pruned") });

    await expect(verifier(reader).isSettled(TERMS)).rejects.toThrow(/pruned/);
  });

  it("rejects a log the node returned for another nonce", async () => {
    // The node was asked for one exact event and answered with another. Nothing
    // it says about this payment can be trusted, so the answer is unavailable.
    const reader = fakeReader({ logs: [authorizationUsed({ nonce: OTHER_NONCE })] });

    await expect(verifier(reader).isSettled(TERMS)).rejects.toThrow(/nonce/);
  });

  it("rejects a log list that is not a list", async () => {
    await expect(verifier(fakeReader({ logs: { result: [] } })).isSettled(TERMS)).rejects.toThrow(
      /no list/,
    );
  });

  it("rejects a zero expected amount instead of settling it", async () => {
    await expect(
      verifier(fakeReader()).isSettled({ ...TERMS, amount: 0n }),
    ).rejects.toThrow(/positive/);
  });

  it("refuses to build with a lookback that is not a positive number", () => {
    expect(() => verifier(fakeReader(), 0)).toThrow(/positive/);
    expect(() => verifier(fakeReader(), -1)).toThrow(/positive/);
    expect(() => verifier(fakeReader(), 1.5)).toThrow(/positive/);
  });

  it("builds no verifier for the mock path and none without an RPC URL", () => {
    expect(buildSettlementVerifier({ paymentMode: "mock", network: "mock:local" })).toBeUndefined();
    expect(buildSettlementVerifier({ paymentMode: "testnet", network: "eip155:84532" })).toBeUndefined();
  });

  it("defaults the contract address per network and honours an override", () => {
    const built = buildSettlementVerifier({
      paymentMode: "testnet",
      network: "eip155:84532",
      paymentRpcUrl: "https://rpc.invalid",
    });
    expect(built).toBeInstanceOf(UsdcSettlementVerifier);
    expect(
      buildSettlementVerifier({
        paymentMode: "testnet",
        network: "eip155:84532",
        paymentRpcUrl: "https://rpc.invalid",
        paymentUsdcAddress: "0x2222222222222222222222222222222222222222",
      }),
    ).toBeInstanceOf(UsdcSettlementVerifier);
  });
});

describe("chain verdict", () => {
  const payload = { payload: { authorization: { from: AUTHORIZER, nonce: NONCE } } };

  it("is unavailable without a verifier, so callers fall through to the lookup", async () => {
    await expect(
      confirmSettledOnChain(undefined, payload, { payTo: RECIPIENT, amount: "50000" }),
    ).resolves.toBe("unavailable");
  });

  it("is unavailable when the payload carries no authorizer or nonce", async () => {
    const isSettled = vi.fn(async () => true);
    await expect(
      confirmSettledOnChain({ isSettled }, { payload: {} }, { payTo: RECIPIENT, amount: "50000" }),
    ).resolves.toBe("unavailable");
    expect(isSettled).not.toHaveBeenCalled();
  });

  it("is unavailable when the price is not a positive integer", async () => {
    const isSettled = vi.fn(async () => true);
    for (const amount of ["", "0", "-1", "50000.5", "1e5"]) {
      await expect(
        confirmSettledOnChain({ isSettled }, payload, { payTo: RECIPIENT, amount }),
      ).resolves.toBe("unavailable");
    }
    expect(isSettled).not.toHaveBeenCalled();
  });

  it("is unavailable when the recipient is not an address", async () => {
    const isSettled = vi.fn(async () => true);
    await expect(
      confirmSettledOnChain({ isSettled }, payload, { payTo: "", amount: "50000" }),
    ).resolves.toBe("unavailable");
    expect(isSettled).not.toHaveBeenCalled();
  });

  it("is unsettled when the verifier answers false", async () => {
    await expect(
      confirmSettledOnChain({ isSettled: async () => false }, payload, {
        payTo: RECIPIENT,
        amount: "50000",
      }),
    ).resolves.toBe("unsettled");
  });

  it("is unavailable, never settled, when the verifier throws", async () => {
    await expect(
      confirmSettledOnChain(
        {
          isSettled: async () => {
            throw new Error("rpc unavailable");
          },
        },
        payload,
        { payTo: RECIPIENT, amount: "50000" },
      ),
    ).resolves.toBe("unavailable");
  });
});
