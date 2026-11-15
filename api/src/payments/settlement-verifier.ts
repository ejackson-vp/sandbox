/**
 * On-chain settlement verification (F-10, F-17).
 *
 * The facilitator's `settled` answer was the only thing that granted an
 * entitlement before this module existed, so a buggy or hostile facilitator
 * could mint free sessions, and a crash after settlement could lose the
 * entitlement entirely: recovery depended on `GET /settlements/:paymentKey`,
 * which the public testnet facilitator does not expose.
 *
 * "The EIP-3009 nonce was used" is *not* the same claim as "this amount reached
 * this address". `authorizationState(address authorizer, bytes32 nonce)` answers
 * only the first, so a 1-atomic-unit authorisation read as settled for a session
 * priced at 50 000 units (F-17). This module proves the transfer instead:
 *
 *  1. `AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)` on
 *     the USDC contract, filtered on both indexed topics over a bounded block
 *     window, names the transaction that consumed the nonce.
 *  2. That transaction's receipt must carry
 *     `Transfer(address indexed from, address indexed to, uint256 value)` on the
 *     same contract with `from == authorizer`, `to == recipient` and
 *     `value >= amount`.
 *
 * Both facts are read from the raw topics and data rather than from anything a
 * node decoded for us, so the answer is "the chain said this", not "the RPC
 * thought this". The window is bounded because the nonce is consumed inside the
 * intent's lifetime; a log outside it is not found, which is `false` and fails
 * closed. So does an unreadable answer: it throws, and the caller answers
 * `unavailable`.
 *
 * The reader is injected so tests never need an RPC endpoint; nothing here makes
 * a network call until `isSettled` is called on the real implementation.
 */
import { createPublicClient, http, parseAbiItem, toEventSelector } from "viem";
import type { AbiEvent } from "viem";

/**
 * The two events this module reads. `parseAbiItem` (rather than a plain string)
 * gives viem the indexed-argument types the `getLogs` filter needs.
 *
 * `AuthorizationUsed` is emitted by FiatTokenV2's `transferWithAuthorization`
 * and friends exactly once per consumed nonce. `Transfer` is the ERC-20 event
 * on the same contract; its `value` is the amount that actually moved.
 */
export const AUTHORIZATION_USED_EVENT = parseAbiItem(
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
);

export const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/** The exact indexed-topic hash for each event, from the signature above. */
const AUTHORIZATION_USED_TOPIC = toEventSelector(AUTHORIZATION_USED_EVENT as AbiEvent).toLowerCase();
const TRANSFER_TOPIC = toEventSelector(TRANSFER_EVENT as AbiEvent).toLowerCase();

/** USDC by CAIP-2 network. Base mainnet then Base Sepolia. */
export const USDC_BY_NETWORK: Readonly<Record<string, `0x${string}`>> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

/**
 * How far behind head to look for the `AuthorizationUsed` log.
 *
 * Base produces a block every 2 s, so 900 blocks is 30 minutes: an order of
 * magnitude more than the intent lifetime (`PAYMENT_INTENT_STALE_MS`, 30 s) and
 * the settlement-recovery grace (5 min), and still a single small `eth_getLogs`
 * request because it is filtered by contract and two indexed topics. A window is
 * needed at all so this check cannot scan from genesis on a hostile or careless
 * call; a nonce older than the window is `unsettled`, never `settled`.
 */
export const DEFAULT_SETTLEMENT_LOOKBACK_BLOCKS = 900;

/** A single nonce can only be consumed once; more than this is not one payment. */
const MAX_CANDIDATE_TRANSACTIONS = 8;

/**
 * What the chain must prove. Every member is the server's own value: the
 * authorizer and nonce come from the signed authorisation, the recipient and
 * amount come from the requirement the server priced, never from the request.
 */
export interface SettlementRequirement {
  /** The wallet that signed the EIP-3009 authorisation. */
  authorizer: `0x${string}`;
  /** The single-use nonce in that authorisation. */
  nonce: `0x${string}`;
  /** The server's `PAY_TO`: the only address that settles this payment. */
  recipient: `0x${string}`;
  /** The server's price in atomic units; a smaller transfer does not settle. */
  amount: bigint;
}

/** The settlement question, with no transport in it. */
export interface ChainSettlementVerifier {
  /**
   * True only when the transaction that consumed this nonce also transferred at
   * least `amount` of this contract from `authorizer` to `recipient`.
   * Throws when the answer could not be obtained; callers fail closed.
   */
  isSettled(requirement: SettlementRequirement): Promise<boolean>;
}

/** The `getLogs` filter for the nonce, bounded to a block window. */
export interface AuthorizationUsedFilter {
  address: `0x${string}`;
  event: typeof AUTHORIZATION_USED_EVENT;
  args: { authorizer: `0x${string}`; nonce: `0x${string}` };
  fromBlock: bigint;
  toBlock: bigint;
}

/**
 * The three reads, injectable so the adapter is testable offline. Every method
 * returns `unknown`: the adapter validates the shape rather than trusting a
 * transport's decoding.
 */
export interface UsdcChainReader {
  /** The current head, so the window is anchored to the chain and not a cache. */
  blockNumber(): Promise<bigint>;
  /** Logs matching the exact event and both indexed topics in the window. */
  logs(filter: AuthorizationUsedFilter): Promise<unknown>;
  /** The receipt for a transaction the log named. */
  receipt(hash: `0x${string}`): Promise<unknown>;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export interface UsdcVerifierOptions {
  rpcUrl: string;
  usdcAddress: `0x${string}`;
  /** Blocks behind head to scan. Defaults to `DEFAULT_SETTLEMENT_LOOKBACK_BLOCKS`. */
  lookbackBlocks?: number;
  /** Per-request timeout on the JSON-RPC call. */
  timeoutMs?: number;
  /** Test seam. Production builds a viem client from `rpcUrl`. */
  reader?: UsdcChainReader;
}

function viemReader(rpcUrl: string, timeoutMs: number): UsdcChainReader {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: timeoutMs }) });
  return {
    blockNumber: async () => client.getBlockNumber(),
    logs: async (filter) => client.getLogs(filter as never),
    receipt: async (hash) => client.getTransactionReceipt({ hash }),
  };
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const WORD_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function isAddress(value: unknown): value is `0x${string}` {
  return typeof value === "string" && ADDRESS_PATTERN.test(value);
}

function sameAddress(left: unknown, right: string): boolean {
  return typeof left === "string" && left.toLowerCase() === right.toLowerCase();
}

/** An address as the 32-byte indexed topic it occupies. */
function addressTopic(address: `0x${string}`): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function topicAt(topics: unknown, index: number): string | null {
  if (!Array.isArray(topics)) return null;
  const topic = topics[index];
  return typeof topic === "string" ? topic.toLowerCase() : null;
}

/** A 32-byte `uint256` from log data, or null when it is not one. */
function wordAt(data: unknown): bigint | null {
  return typeof data === "string" && WORD_PATTERN.test(data) ? BigInt(data) : null;
}

interface RawLog {
  address?: unknown;
  topics?: unknown;
  data?: unknown;
  transactionHash?: unknown;
  removed?: unknown;
  status?: unknown;
  logs?: unknown;
}

function asLog(entry: unknown): RawLog | null {
  return typeof entry === "object" && entry !== null ? (entry as RawLog) : null;
}

/**
 * Does this receipt prove the transfer the requirement asks for?
 *
 * Every clause is separate on purpose: the contract, the event, the sender, the
 * recipient and the amount are each checked, so passing one cannot imply another.
 * An unrelated log in the same receipt is skipped; a receipt that is not an
 * object, or has no log list, throws because nothing can be concluded from it.
 */
function receiptProvesTransfer(
  receipt: unknown,
  usdcAddress: `0x${string}`,
  requirement: SettlementRequirement,
  transactionHash: `0x${string}`,
): boolean {
  const body = asLog(receipt);
  if (!body) throw new Error("transaction receipt was not an object");
  // The transfer must be in *this* transaction, so a receipt for another one is
  // not evidence about it whatever it contains.
  if (typeof body.transactionHash !== "string" || !WORD_PATTERN.test(body.transactionHash)) {
    throw new Error("transaction receipt had no transaction hash");
  }
  if (body.transactionHash.toLowerCase() !== transactionHash) {
    throw new Error("transaction receipt was for a different transaction");
  }
  // A reverted transaction moved nothing, whatever its logs claim.
  if (body.status !== undefined && body.status !== "success") return false;
  if (!Array.isArray(body.logs)) throw new Error("transaction receipt had no log list");

  const fromTopic = addressTopic(requirement.authorizer);
  const toTopic = addressTopic(requirement.recipient);
  for (const entry of body.logs) {
    const candidate = asLog(entry);
    if (!candidate || candidate.removed === true) continue;
    if (!sameAddress(candidate.address, usdcAddress)) continue;
    if (topicAt(candidate.topics, 0) !== TRANSFER_TOPIC) continue;
    if (topicAt(candidate.topics, 1) !== fromTopic) continue;
    if (topicAt(candidate.topics, 2) !== toTopic) continue;
    const value = wordAt(candidate.data);
    if (value !== null && value >= requirement.amount) return true;
  }
  return false;
}

/**
 * Proves settlement on the configured USDC contract: the nonce's transaction,
 * and the transfer in it, at or above the server's price.
 *
 * Never answers `true` on anything it cannot read. A log outside the window, a
 * transfer to another address, a short amount and a transaction with no matching
 * transfer all read as `false`; an error reads as a throw.
 */
export class UsdcSettlementVerifier implements ChainSettlementVerifier {
  private readonly reader: UsdcChainReader;
  private readonly usdcAddress: `0x${string}`;
  private readonly lookbackBlocks: bigint;

  constructor(options: UsdcVerifierOptions) {
    if (!isAddress(options.usdcAddress)) {
      throw new Error("USDC address must be a 20-byte EVM address");
    }
    const lookback = options.lookbackBlocks ?? DEFAULT_SETTLEMENT_LOOKBACK_BLOCKS;
    if (!Number.isInteger(lookback) || lookback <= 0) {
      // Not clamped: a zero window would answer "unsettled" for a real payment,
      // and a silent widening is not this module's decision to make.
      throw new Error("settlement lookback must be a positive number of blocks");
    }
    this.lookbackBlocks = BigInt(lookback);
    this.usdcAddress = options.usdcAddress;
    this.reader =
      options.reader ?? viemReader(options.rpcUrl, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  async isSettled(requirement: SettlementRequirement): Promise<boolean> {
    if (requirement.amount <= 0n) {
      // A free entitlement never reaches a chain check. A zero price here would
      // make every `value >= 0` transfer, including a 0-unit one, look settled.
      throw new Error("expected settlement amount must be positive");
    }
    const head = await this.reader.blockNumber();
    if (typeof head !== "bigint" || head < 0n) {
      throw new Error("block number read returned no chain height");
    }
    const fromBlock = head > this.lookbackBlocks ? head - this.lookbackBlocks : 0n;
    const logs = await this.reader.logs({
      address: this.usdcAddress,
      event: AUTHORIZATION_USED_EVENT,
      args: { authorizer: requirement.authorizer, nonce: requirement.nonce },
      fromBlock,
      toBlock: head,
    });

    for (const hash of this.authorizationTransactions(logs, requirement)) {
      const receipt = await this.reader.receipt(hash);
      if (receiptProvesTransfer(receipt, this.usdcAddress, requirement, hash)) return true;
    }
    return false;
  }

  /**
   * The transactions the returned logs name, after checking that each log really
   * is this nonce's `AuthorizationUsed` on this contract.
   *
   * A log that does not match the filter is an unreadable answer, not a
   * non-match: the node was asked for one exact event and returned something
   * else, so nothing it says can be trusted for this payment.
   */
  private authorizationTransactions(
    logs: unknown,
    requirement: SettlementRequirement,
  ): `0x${string}`[] {
    if (!Array.isArray(logs)) throw new Error("authorization log query returned no list");
    const authorizerTopic = addressTopic(requirement.authorizer);
    const nonceTopic = requirement.nonce.toLowerCase();
    const hashes = new Set<`0x${string}`>();
    for (const entry of logs) {
      const candidate = asLog(entry);
      if (!candidate) throw new Error("authorization log entry was not an object");
      // A log removed by a reorg is not evidence that the nonce is consumed.
      if (candidate.removed === true) continue;
      if (!sameAddress(candidate.address, this.usdcAddress)) {
        throw new Error("authorization log was not on the configured USDC contract");
      }
      if (topicAt(candidate.topics, 0) !== AUTHORIZATION_USED_TOPIC) {
        throw new Error("authorization log was not an AuthorizationUsed event");
      }
      if (topicAt(candidate.topics, 1) !== authorizerTopic) {
        throw new Error("authorization log named another authorizer");
      }
      if (topicAt(candidate.topics, 2) !== nonceTopic) {
        throw new Error("authorization log named another nonce");
      }
      if (
        typeof candidate.transactionHash !== "string" ||
        !WORD_PATTERN.test(candidate.transactionHash)
      ) {
        throw new Error("authorization log had no transaction hash");
      }
      hashes.add(candidate.transactionHash.toLowerCase() as `0x${string}`);
    }
    if (hashes.size > MAX_CANDIDATE_TRANSACTIONS) {
      throw new Error("more transactions than one nonce can have; refusing to guess");
    }
    return [...hashes];
  }
}

/** The USDC contract for a network, or undefined when there is no default. */
export function usdcAddressFor(network: string): `0x${string}` | undefined {
  return USDC_BY_NETWORK[network];
}

export function isEvmNetwork(network: string): boolean {
  return network.startsWith("eip155:");
}
