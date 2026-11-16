/**
 * Shared fixtures for the on-chain settlement tests.
 *
 * The verifier's mechanics (`settlement-verifier.test.ts`) and the create-path
 * wiring (`chain-settlement.test.ts`) use the same authorizer, nonce, recipient
 * and amount, so the constants and the log builders live here rather than being
 * copied. Nothing here reaches an RPC: the chain is a fake reader.
 */
import { vi } from "vitest";
import { toEventSelector } from "viem";
import {
  AUTHORIZATION_USED_EVENT,
  DEFAULT_SETTLEMENT_LOOKBACK_BLOCKS,
  DEFAULT_SETTLEMENT_SCAN_CHUNK_BLOCKS,
  TRANSFER_EVENT,
  UsdcSettlementVerifier,
  usdcAddressFor,
  type AuthorizationUsedFilter,
  type ChainSettlementVerifier,
  type DisproofReason,
  type SettlementProof,
} from "../../api/src/payments/settlement-verifier.js";

export const USDC = usdcAddressFor("eip155:8453")!;
export const AUTHORIZER = "0x1111111111111111111111111111111111111111" as const;
export const RECIPIENT = "0x2222222222222222222222222222222222222222" as const;
export const STRANGER = "0x3333333333333333333333333333333333333333" as const;
export const NONCE = `0x${"ab".repeat(32)}` as `0x${string}`;
export const OTHER_NONCE = `0x${"cd".repeat(32)}` as `0x${string}`;
export const TX_HASH = `0x${"ef".repeat(32)}` as `0x${string}`;
export const AMOUNT = 50_000n;
export const TERMS = {
  authorizer: AUTHORIZER,
  nonce: NONCE,
  recipient: RECIPIENT,
  amount: AMOUNT,
};

export function proven(transaction: `0x${string}` = TX_HASH): SettlementProof {
  return { verdict: "proven", transaction };
}

export function disproven(
  reason: DisproofReason,
  transaction: `0x${string}` = TX_HASH,
): SettlementProof {
  return { verdict: "disproven", transaction, reason };
}

export function notFound(): SettlementProof {
  return { verdict: "not-found" };
}

/** A fake chain check that always gives the same answer. */
export function chainProof(answer: SettlementProof): ChainSettlementVerifier {
  return { settlementProof: async () => answer };
}

export const AUTHORIZATION_USED_TOPIC = toEventSelector(AUTHORIZATION_USED_EVENT).toLowerCase();
export const TRANSFER_TOPIC = toEventSelector(TRANSFER_EVENT).toLowerCase();

export function topicOf(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

export function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

/** The FiatTokenV2 log the nonce query is supposed to match. */
export function authorizationUsed(overrides: { nonce?: string; removed?: boolean } = {}) {
  return {
    address: USDC,
    topics: [
      AUTHORIZATION_USED_TOPIC,
      topicOf(AUTHORIZER),
      (overrides.nonce ?? NONCE).toLowerCase(),
    ],
    data: "0x",
    transactionHash: TX_HASH,
    removed: overrides.removed ?? false,
  };
}

export function transfer(
  overrides: { from?: string; to?: string; value?: bigint; address?: string } = {},
) {
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

export function receiptWith(...logs: unknown[]) {
  return { status: "success", transactionHash: TX_HASH, logs };
}

export type LogAnswer = unknown | ((filter: AuthorizationUsedFilter) => unknown);

/** A reader whose every answer a test can set, recording each `getLogs` call. */
export function fakeReader(
  answers: {
    head?: bigint;
    logs?: LogAnswer;
    receipt?: unknown;
    headError?: Error;
    logsError?: Error;
    receiptError?: Error;
  } = {},
) {
  const calls: AuthorizationUsedFilter[] = [];
  return {
    calls,
    blockNumber: vi.fn(async () => {
      if (answers.headError) throw answers.headError;
      return answers.head ?? 1_000_000n;
    }),
    logs: vi.fn(async (filter: AuthorizationUsedFilter) => {
      calls.push(filter);
      if (answers.logsError) throw answers.logsError;
      if (typeof answers.logs === "function") return answers.logs(filter);
      return answers.logs ?? [];
    }),
    receipt: vi.fn(async () => {
      if (answers.receiptError) throw answers.receiptError;
      return answers.receipt ?? receiptWith(transfer());
    }),
  };
}

export function usdcVerifier(
  reader: ReturnType<typeof fakeReader>,
  options: { lookbackBlocks?: number; chunkBlocks?: number } = {},
) {
  return new UsdcSettlementVerifier({
    rpcUrl: "https://rpc.invalid",
    usdcAddress: USDC,
    reader,
    ...options,
  });
}

/** The ranges a full default scan asks for, newest first. */
export function defaultScanRanges(): Array<[bigint, bigint]> {
  const ranges: Array<[bigint, bigint]> = [];
  let to = 1_000_000n;
  const chunks = DEFAULT_SETTLEMENT_LOOKBACK_BLOCKS / DEFAULT_SETTLEMENT_SCAN_CHUNK_BLOCKS;
  for (let i = 0; i < chunks; i++) {
    ranges.push([to - BigInt(DEFAULT_SETTLEMENT_SCAN_CHUNK_BLOCKS) + 1n, to]);
    to -= BigInt(DEFAULT_SETTLEMENT_SCAN_CHUNK_BLOCKS);
  }
  return ranges;
}
