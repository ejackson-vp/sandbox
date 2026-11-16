/**
 * What the USDC settlement verifier reads, and what it refuses to conclude
 * (F-10, F-17).
 *
 * The rule under test: `proven` needs the nonce's transaction *and* a Transfer
 * to the recipient of at least the price. A readable receipt that fails any
 * clause is `disproven`. A nonce the window cannot place is `not-found`, which
 * the caller maps to `unavailable`, never to a refusal. Every read is a fake;
 * nothing here reaches an RPC.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTLEMENT_LOOKBACK_BLOCKS,
  DEFAULT_SETTLEMENT_SCAN_CHUNK_BLOCKS,
  MAX_SETTLEMENT_SCAN_QUERIES,
  AUTHORIZATION_USED_EVENT,
  UsdcSettlementVerifier,
  type AuthorizationUsedFilter,
} from "../../shared/src/entries/settlement.js";
import { buildSettlementVerifier } from "../../api/src/payments/settlement-confirmation.js";
import {
  AMOUNT,
  NONCE,
  OTHER_NONCE,
  STRANGER,
  TERMS,
  TX_HASH,
  USDC,
  authorizationUsed,
  defaultScanRanges,
  disproven,
  fakeReader,
  notFound,
  proven,
  receiptWith,
  transfer,
  usdcVerifier,
} from "../helpers/settlement-fixtures.js";

describe("USDC settlement verifier", () => {
  it("proves a transfer of exactly the price to the configured recipient", async () => {
    const reader = fakeReader({ logs: [authorizationUsed()] });

    await expect(usdcVerifier(reader).settlementProof(TERMS)).resolves.toEqual(proven());
    expect(reader.calls[0]).toEqual({
      address: USDC,
      event: AUTHORIZATION_USED_EVENT,
      args: { authorizer: TERMS.authorizer, nonce: NONCE },
      fromBlock: 1_000_000n - BigInt(DEFAULT_SETTLEMENT_SCAN_CHUNK_BLOCKS) + 1n,
      toBlock: 1_000_000n,
    });
    // The receipt is the one the log named, not a receipt of our choosing.
    expect(reader.receipt).toHaveBeenCalledWith(TX_HASH);
  });

  it("proves a transfer above the price", async () => {
    const reader = fakeReader({
      logs: [authorizationUsed()],
      receipt: receiptWith(transfer({ value: AMOUNT + 1n })),
    });

    await expect(usdcVerifier(reader).settlementProof(TERMS)).resolves.toEqual(proven());
  });

  it("disproves a transfer to a different address", async () => {
    const reader = fakeReader({
      logs: [authorizationUsed()],
      receipt: receiptWith(transfer({ to: STRANGER })),
    });

    await expect(usdcVerifier(reader).settlementProof(TERMS)).resolves.toEqual(
      disproven("transfer_to_another_recipient"),
    );
  });

  it("disproves a transfer that is one atomic unit short", async () => {
    const reader = fakeReader({
      logs: [authorizationUsed()],
      receipt: receiptWith(transfer({ value: AMOUNT - 1n })),
    });

    await expect(usdcVerifier(reader).settlementProof(TERMS)).resolves.toEqual(
      disproven("transfer_below_price"),
    );
  });

  it("disproves a transfer from another sender, even to the right address", async () => {
    const reader = fakeReader({
      logs: [authorizationUsed()],
      receipt: receiptWith(transfer({ from: STRANGER })),
    });

    await expect(usdcVerifier(reader).settlementProof(TERMS)).resolves.toEqual(
      disproven("no_matching_transfer"),
    );
  });

  it("disproves a transfer of another token contract", async () => {
    const reader = fakeReader({
      logs: [authorizationUsed()],
      receipt: receiptWith(transfer({ address: STRANGER })),
    });

    await expect(usdcVerifier(reader).settlementProof(TERMS)).resolves.toEqual(
      disproven("no_matching_transfer"),
    );
  });

  it("disproves a used nonce whose transaction has no matching Transfer", async () => {
    const reader = fakeReader({
      logs: [authorizationUsed()],
      receipt: receiptWith(
        // The authorization's own log is not a transfer, and neither is an
        // unrelated one in the same transaction.
        authorizationUsed(),
        transfer({ from: STRANGER, to: STRANGER }),
      ),
    });

    await expect(usdcVerifier(reader).settlementProof(TERMS)).resolves.toEqual(
      disproven("no_matching_transfer"),
    );
  });

  it("disproves a reverted transaction", async () => {
    const reader = fakeReader({
      logs: [authorizationUsed()],
      receipt: { status: "reverted", transactionHash: TX_HASH, logs: [transfer()] },
    });

    await expect(usdcVerifier(reader).settlementProof(TERMS)).resolves.toEqual(
      disproven("transaction_reverted"),
    );
  });

  it("rejects a receipt for a different transaction than the log named", async () => {
    const reader = fakeReader({
      logs: [authorizationUsed()],
      receipt: { status: "success", transactionHash: `0x${"aa".repeat(32)}`, logs: [transfer()] },
    });

    await expect(usdcVerifier(reader).settlementProof(TERMS)).rejects.toThrow(
      /different transaction/,
    );
  });

  it("answers not-found, not disproven, when the nonce is outside the window", async () => {
    const reader = fakeReader();

    await expect(usdcVerifier(reader).settlementProof(TERMS)).resolves.toEqual(notFound());
    // The whole configured window was scanned before drawing that conclusion.
    expect(reader.calls.map((c) => [c.fromBlock, c.toBlock])).toEqual(defaultScanRanges());
    expect(reader.receipt).not.toHaveBeenCalled();
  });

  it("defaults to a window that covers a multi-day outage", () => {
    // Base is 2 s per block, so the default window is 50 hours. The failure the
    // window exists for is the API settling, staying down, and recovering after
    // a restart; a 30-minute window could not place that payment at all.
    expect(DEFAULT_SETTLEMENT_LOOKBACK_BLOCKS * 2).toBeGreaterThanOrEqual(48 * 60 * 60);
    expect(
      DEFAULT_SETTLEMENT_LOOKBACK_BLOCKS / DEFAULT_SETTLEMENT_SCAN_CHUNK_BLOCKS,
    ).toBeLessThanOrEqual(MAX_SETTLEMENT_SCAN_QUERIES);
  });

  it("scans newest first and stops at the first chunk that knows the nonce", async () => {
    const reader = fakeReader({
      logs: (filter: AuthorizationUsedFilter) =>
        filter.fromBlock === 970_001n ? [authorizationUsed()] : [],
    });

    await expect(usdcVerifier(reader).settlementProof(TERMS)).resolves.toEqual(proven());
    // Newest first, and no older chunk after the hit.
    expect(reader.calls).toHaveLength(3);
    expect(reader.calls[2]).toMatchObject({ fromBlock: 970_001n, toBlock: 980_000n });
  });

  it("does not scan past the configured window", async () => {
    const reader = fakeReader();

    await usdcVerifier(reader, { lookbackBlocks: 25_000, chunkBlocks: 10_000 }).settlementProof(
      TERMS,
    );

    expect(reader.calls.map((c) => [c.fromBlock, c.toBlock])).toEqual([
      [990_001n, 1_000_000n],
      [980_001n, 990_000n],
      [975_001n, 980_000n],
    ]);
  });

  it("does not run the window below genesis", async () => {
    const reader = fakeReader({ head: 5n });

    await expect(usdcVerifier(reader).settlementProof(TERMS)).resolves.toEqual(notFound());
    expect(reader.calls).toHaveLength(1);
    expect(reader.calls[0]).toMatchObject({ fromBlock: 0n, toBlock: 5n });
  });

  it("treats a log removed by a reorg as no evidence", async () => {
    const reader = fakeReader({ logs: [authorizationUsed({ removed: true })] });

    await expect(usdcVerifier(reader).settlementProof(TERMS)).resolves.toEqual(notFound());
    expect(reader.receipt).not.toHaveBeenCalled();
  });

  it("rejects rather than answering when a chunk read fails", async () => {
    const reader = fakeReader({ logsError: new Error("rpc unavailable") });

    await expect(usdcVerifier(reader).settlementProof(TERMS)).rejects.toThrow(/rpc unavailable/);
  });

  it("rejects rather than answering when the head read fails", async () => {
    const reader = fakeReader({ headError: new Error("timeout") });

    await expect(usdcVerifier(reader).settlementProof(TERMS)).rejects.toThrow(/timeout/);
  });

  it("rejects rather than answering when the receipt read fails", async () => {
    const reader = fakeReader({ logs: [authorizationUsed()], receiptError: new Error("pruned") });

    await expect(usdcVerifier(reader).settlementProof(TERMS)).rejects.toThrow(/pruned/);
  });

  it("rejects a log the node returned for another nonce", async () => {
    // The node was asked for one exact event and answered with another. Nothing
    // it says about this payment can be trusted, so the answer is unavailable.
    const reader = fakeReader({ logs: [authorizationUsed({ nonce: OTHER_NONCE })] });

    await expect(usdcVerifier(reader).settlementProof(TERMS)).rejects.toThrow(/nonce/);
  });

  it("rejects a log list that is not a list", async () => {
    await expect(usdcVerifier(fakeReader({ logs: { result: [] } })).settlementProof(TERMS)).rejects.toThrow(
      /no list/,
    );
  });

  it("rejects a zero expected amount instead of settling it", async () => {
    await expect(usdcVerifier(fakeReader()).settlementProof({ ...TERMS, amount: 0n })).rejects.toThrow(
      /positive/,
    );
  });

  it("refuses a window it cannot scan within the query cap", () => {
    const reader = fakeReader();
    // Exactly the cap is allowed; one block more is not.
    expect(() =>
      usdcVerifier(reader, {
        lookbackBlocks: MAX_SETTLEMENT_SCAN_QUERIES * 10_000,
        chunkBlocks: 10_000,
      }),
    ).not.toThrow();
    expect(() =>
      usdcVerifier(reader, {
        lookbackBlocks: MAX_SETTLEMENT_SCAN_QUERIES * 10_000 + 1,
        chunkBlocks: 10_000,
      }),
    ).toThrow(/cap is 12/);
  });

  it("refuses a lookback or chunk that is not a positive number", () => {
    const reader = fakeReader();
    expect(() => usdcVerifier(reader, { lookbackBlocks: 0 })).toThrow(/positive/);
    expect(() => usdcVerifier(reader, { lookbackBlocks: -1 })).toThrow(/positive/);
    expect(() => usdcVerifier(reader, { lookbackBlocks: 1.5 })).toThrow(/positive/);
    expect(() => usdcVerifier(reader, { chunkBlocks: 0 })).toThrow(/positive/);
  });

  it("builds no verifier for the mock path and none without an RPC URL", () => {
    expect(buildSettlementVerifier({ paymentMode: "mock", network: "mock:local" })).toBeUndefined();
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

  it("applies the configured window and chunk size", () => {
    // A pair the constructor would refuse proves the config reaches it.
    expect(() =>
      buildSettlementVerifier({
        paymentMode: "testnet",
        network: "eip155:84532",
        paymentRpcUrl: "https://rpc.invalid",
        paymentSettlementLookbackBlocks: 130_000,
        paymentSettlementScanChunkBlocks: 10_000,
      }),
    ).toThrow(/cap is 12/);
  });
});
