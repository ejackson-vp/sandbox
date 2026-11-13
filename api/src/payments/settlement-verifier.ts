/**
 * On-chain settlement verification (F-10).
 *
 * The facilitator's `settled` answer is the only thing that granted an
 * entitlement before this module existed, so a buggy or hostile facilitator
 * could mint free sessions, and a crash after settlement could lose the
 * entitlement entirely: recovery depended on `GET /settlements/:paymentKey`,
 * which the public testnet facilitator does not expose.
 *
 * An EIP-3009 `TransferWithAuthorization` is verified on chain by consuming its
 * nonce. `authorizationState(address authorizer, bytes32 nonce)` on the USDC
 * contract returns `true` exactly once that nonce is used, so settlement can be
 * read from the chain instead of trusted from an HTTP answer. That makes the
 * chain the source of truth for "did the money move", and it is the same check
 * on the first attempt and on the crash-recovery path.
 *
 * The port is injected so tests never need an RPC endpoint; nothing here makes
 * a network call until `isSettled` is called on the real implementation.
 */
import { createPublicClient, http, parseAbi } from "viem";

/**
 * The two functions of the EIP-3009 / FiatTokenV2 surface this module uses.
 * `parseAbi` (rather than a plain string) makes viem type `authorizationState`
 * as returning `boolean`.
 */
export const AUTHORIZATION_STATE_ABI = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

/** The settlement question, with no transport in it. */
export interface ChainSettlementVerifier {
  /**
   * True only when the chain says this authorizer's nonce has been used.
   * Throws when the answer could not be obtained; callers fail closed.
   */
  isSettled(authorizer: `0x${string}`, nonce: `0x${string}`): Promise<boolean>;
}

/** USDC by CAIP-2 network. Base mainnet then Base Sepolia. */
export const USDC_BY_NETWORK: Readonly<Record<string, `0x${string}`>> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

export function isEvmNetwork(network: string): boolean {
  return network.startsWith("eip155:");
}

/** The USDC contract for a network, or undefined when there is no default. */
export function usdcAddressFor(network: string): `0x${string}` | undefined {
  return USDC_BY_NETWORK[network];
}

export interface AuthorizationStateRequest {
  address: `0x${string}`;
  abi: typeof AUTHORIZATION_STATE_ABI;
  functionName: "authorizationState";
  args: readonly [`0x${string}`, `0x${string}`];
}

/** The one contract read, injectable so the adapter is testable offline. */
export type ReadAuthorizationState = (request: AuthorizationStateRequest) => Promise<unknown>;

const DEFAULT_TIMEOUT_MS = 5_000;

export interface UsdcVerifierOptions {
  rpcUrl: string;
  usdcAddress: `0x${string}`;
  /** Per-request timeout on the JSON-RPC call. */
  timeoutMs?: number;
  /** Test seam. Production builds a viem client from `rpcUrl`. */
  readContract?: ReadAuthorizationState;
}

function viemReader(rpcUrl: string, timeoutMs: number): ReadAuthorizationState {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: timeoutMs }) });
  return async (request) => client.readContract(request as never);
}

/**
 * Reads `authorizationState` on the USDC contract for the configured network.
 *
 * A read that returns something other than a boolean is an error, not a `false`
 * and not a `true`: an unreadable answer must never be read as settlement.
 */
export class UsdcAuthorizationStateVerifier implements ChainSettlementVerifier {
  private readonly readContract: ReadAuthorizationState;
  private readonly usdcAddress: `0x${string}`;

  constructor(options: UsdcVerifierOptions) {
    this.usdcAddress = options.usdcAddress;
    this.readContract =
      options.readContract ?? viemReader(options.rpcUrl, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  async isSettled(authorizer: `0x${string}`, nonce: `0x${string}`): Promise<boolean> {
    const answer = await this.readContract({
      address: this.usdcAddress,
      abi: AUTHORIZATION_STATE_ABI,
      functionName: "authorizationState",
      args: [authorizer, nonce],
    });
    if (typeof answer !== "boolean") {
      throw new Error("authorizationState returned a non-boolean answer");
    }
    return answer;
  }
}
