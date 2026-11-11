/**
 * x402 payment integration.
 *
 * Two payment paths are supported:
 *
 *  - `mock:local` / scheme `exact`  — a deterministic, offline facilitator for
 *    local development. Authorization is a real EIP-712 signature (same shape
 *    as EIP-3009 TransferWithAuthorization) verified off-chain. There is no
 *    on-chain settlement and therefore no economic security.
 *  - `eip155:84532` / scheme `exact` — Base Sepolia testnet using the official
 *    x402 facilitator and @x402/evm's ExactEvmScheme. Enabled only when
 *    PAYMENT_MODE=testnet; mainnet is rejected by configuration validation.
 *
 * The wire protocol is x402 v2 (PAYMENT-REQUIRED / PAYMENT-SIGNATURE /
 * PAYMENT-RESPONSE headers) implemented by @x402/core.
 */
import { randomBytes } from "node:crypto";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkClient,
  SchemeNetworkFacilitator,
  SchemeNetworkServer,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { canonicalJson, sha256Hex } from "./crypto.js";
import { parseUsdPrice } from "./money.js";

export const PAYMENT_VERSION = 2;
export const MOCK_NETWORK = "mock:local" as Network;
export const MOCK_SCHEME = "exact";
export const MOCK_ASSET = "mock:usdc";
export const MOCK_ASSET_DECIMALS = 6;
export const TESTNET_NETWORK = "eip155:84532" as Network;

/** EIP-712 domain used by the mock authorization. chainId 0 = no chain. */
export const MOCK_EIP712_DOMAIN = {
  name: "x402 Mock USD",
  version: "1",
  chainId: 0,
  verifyingContract: "0x0000000000000000000000000000000000000402",
} as const;

export const MOCK_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface MockAuthorization {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
}

export interface MockPayload {
  authorization: MockAuthorization;
  signature: `0x${string}`;
}

/**
 * Stable identity of a payment attempt. One key == at most one entitlement.
 * Uses canonical JSON so logically identical payloads hash identically.
 */
export function paymentKey(payload: PaymentPayload): string {
  return sha256Hex(
    canonicalJson({
      x402Version: payload.x402Version,
      network: payload.accepted?.network,
      scheme: payload.accepted?.scheme,
      asset: payload.accepted?.asset,
      payTo: payload.accepted?.payTo,
      amount: payload.accepted?.amount,
      payload: payload.payload,
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Server-side scheme: builds PaymentRequirements for `mock:local`      */
/* ------------------------------------------------------------------ */

export class MockExactServerScheme implements SchemeNetworkServer {
  readonly scheme = MOCK_SCHEME;
  readonly defaultAssetTransferMethod = "mock";
  readonly paymentFlows = {
    mock: { supported: ["authorization"] as const, default: "authorization" as const },
  };

  async parsePrice(price: string | number | { amount: string; asset: string }, network: Network) {
    void network;
    if (typeof price === "object" && price !== null && "amount" in price) {
      return { amount: price.amount, asset: price.asset, extra: {} };
    }
    const { amount } = parseUsdPrice(String(price));
    return { amount: amount.toString(), asset: MOCK_ASSET, extra: { decimals: MOCK_ASSET_DECIMALS } };
  }

  async enhancePaymentRequirements(req: PaymentRequirements) {
    return req;
  }
}

/* ------------------------------------------------------------------ */
/* Client-side mock signer                                             */
/* ------------------------------------------------------------------ */

/**
 * Creates a real EIP-712 signature over a mock EIP-3009 authorization.
 * Accepts any viem LocalAccount (ephemeral wallets are fine in mock mode).
 */
export class MockExactClientScheme implements SchemeNetworkClient {
  readonly scheme = MOCK_SCHEME;

  constructor(
    private readonly account: {
      address: `0x${string}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signTypedData: (args: any) => Promise<`0x${string}`>;
    },
  ) {}

  async createPaymentPayload(_version: number, requirements: PaymentRequirements) {
    const now = Math.floor(Date.now() / 1000);
    const authorization: MockAuthorization = {
      from: this.account.address,
      to: requirements.payTo as `0x${string}`,
      value: requirements.amount,
      validAfter: String(now - 60),
      validBefore: String(now + Math.max(60, requirements.maxTimeoutSeconds || 300)),
      nonce: `0x${randomBytes(32).toString("hex")}`,
    };
    const signature = await this.account.signTypedData({
      domain: MOCK_EIP712_DOMAIN,
      types: MOCK_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
    });
    return {
      x402Version: PAYMENT_VERSION,
      payload: { authorization, signature } as unknown as Record<string, unknown>,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Facilitator-side mock verifier                                      */
/* ------------------------------------------------------------------ */

export interface MockNonceStore {
  /** Atomically claim a nonce. Returns false when already used. */
  claimNonce(nonce: string, meta: { payer: string; paymentKey: string; amount: string }): Promise<boolean>;
  /** Release a claim after settlement failure (optional). */
  releaseNonce?(nonce: string): Promise<void>;
}

export interface MockFacilitatorOptions {
  store: MockNonceStore;
  network?: Network;
  /** Reject authorizations whose validBefore is further out than this. */
  maxValiditySeconds?: number;
  now?: () => number;
}

export class MockExactFacilitatorScheme implements SchemeNetworkFacilitator {
  readonly scheme = MOCK_SCHEME;
  readonly caipFamily = "mock:*";
  private readonly network: Network;
  private readonly maxValidity: number;
  private readonly now: () => number;

  constructor(
    private readonly opts: MockFacilitatorOptions,
    private readonly verifyTypedData: (args: {
      address: `0x${string}`;
      domain: unknown;
      types: unknown;
      primaryType: string;
      message: unknown;
      signature: `0x${string}`;
    }) => Promise<boolean>,
  ) {
    this.network = opts.network ?? MOCK_NETWORK;
    this.maxValidity = opts.maxValiditySeconds ?? 900;
    this.now = opts.now ?? (() => Date.now());
  }

  getExtra(_network: Network): Record<string, unknown> | undefined {
    return { assetDecimals: MOCK_ASSET_DECIMALS, settlement: "mock-offchain" };
  }

  getSigners(_network: string): string[] {
    return [];
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    try {
      const parsed = await this.validate(payload, requirements);
      if ("error" in parsed) return { isValid: false, invalidReason: parsed.error, invalidMessage: parsed.message };
      return { isValid: true, payer: parsed.authorization.from };
    } catch {
      return { isValid: false, invalidReason: "malformed_payload", invalidMessage: "could not parse payment" };
    }
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const parsed = await this.validate(payload, requirements);
    if ("error" in parsed) {
      return {
        success: false,
        errorReason: parsed.error,
        errorMessage: parsed.message,
        transaction: "",
        network: this.network,
      };
    }
    const key = paymentKey(payload);
    const claimed = await this.opts.store.claimNonce(parsed.authorization.nonce, {
      payer: parsed.authorization.from,
      paymentKey: key,
      amount: parsed.authorization.value,
    });
    if (!claimed) {
      return {
        success: false,
        errorReason: "nonce_already_used",
        errorMessage: "this authorization has already been settled (replay rejected)",
        transaction: "",
        network: this.network,
        payer: parsed.authorization.from,
      };
    }
    return {
      success: true,
      transaction: `mock:${sha256Hex(key).slice(0, 32)}`,
      network: this.network,
      payer: parsed.authorization.from,
      amount: requirements.amount,
    };
  }

  private async validate(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<{ authorization: MockAuthorization } | { error: string; message: string }> {
    if (payload.x402Version !== PAYMENT_VERSION) {
      return { error: "unsupported_version", message: "only x402 v2 is supported" };
    }
    const accepted = payload.accepted;
    if (!accepted) return { error: "malformed_payload", message: "missing accepted requirements" };
    if (accepted.network !== requirements.network || requirements.network !== this.network) {
      return { error: "network_mismatch", message: "payment is for a different network" };
    }
    if (accepted.scheme !== MOCK_SCHEME || requirements.scheme !== MOCK_SCHEME) {
      return { error: "scheme_mismatch", message: "unsupported scheme" };
    }
    if (accepted.asset !== requirements.asset) {
      return { error: "asset_mismatch", message: "payment asset differs from requirements" };
    }
    if (accepted.payTo.toLowerCase() !== requirements.payTo.toLowerCase()) {
      return { error: "payto_mismatch", message: "payment recipient differs from requirements" };
    }
    if (accepted.amount !== requirements.amount) {
      return { error: "amount_mismatch", message: "payment amount differs from requirements" };
    }

    const body = payload.payload as unknown as MockPayload;
    const auth = body?.authorization;
    if (!auth || typeof auth !== "object" || typeof body.signature !== "string") {
      return { error: "malformed_payload", message: "missing authorization or signature" };
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(auth.from) || !/^0x[0-9a-fA-F]{40}$/.test(auth.to)) {
      return { error: "malformed_payload", message: "invalid address" };
    }
    if (auth.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
      return { error: "payto_mismatch", message: "authorization recipient differs from requirements" };
    }
    if (auth.value !== requirements.amount) {
      return { error: "amount_mismatch", message: "authorization value differs from requirements" };
    }
    if (!/^0x[0-9a-f]{64}$/.test(auth.nonce.toLowerCase())) {
      return { error: "malformed_payload", message: "invalid nonce" };
    }

    const nowSec = Math.floor(this.now() / 1000);
    const validAfter = Number(auth.validAfter);
    const validBefore = Number(auth.validBefore);
    if (!Number.isSafeInteger(validAfter) || !Number.isSafeInteger(validBefore)) {
      return { error: "malformed_payload", message: "invalid validity window" };
    }
    if (validBefore <= nowSec) return { error: "expired", message: "authorization expired" };
    if (validAfter > nowSec + 60) return { error: "not_yet_valid", message: "authorization not yet valid" };
    if (validBefore - nowSec > this.maxValidity) {
      return { error: "validity_too_long", message: "authorization validity window is too long" };
    }

    // Real signature check. Any malformed signature/typed-data failure is a
    // verification failure, never an exception that bubbles into a 500.
    let ok = false;
    try {
      ok = await this.verifySignature(auth, body.signature);
    } catch {
      ok = false;
    }
    if (!ok) return { error: "invalid_signature", message: "authorization signature is invalid" };

    return { authorization: auth };
  }

  /** Async signature check, called from verify/settle wrappers. */
  async verifySignature(authorization: MockAuthorization, signature: string): Promise<boolean> {
    return this.verifyTypedData({
      address: authorization.from,
      domain: MOCK_EIP712_DOMAIN,
      types: MOCK_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
      signature: signature as `0x${string}`,
    });
  }
}
