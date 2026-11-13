/**
 * Fixtures for the two mock-scheme test files.
 *
 * `payment-scheme.test.ts` covers pricing and the window a client signs;
 * `payment-authorization.test.ts` covers what the facilitator accepts. Both
 * need the same requirements, the same clock and the same nonce-store
 * recorder, and a second copy would drift from the first the day the scheme
 * changes. Nothing here asserts: it builds inputs and records effects.
 */
import { randomBytes } from "node:crypto";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  MOCK_ASSET,
  MOCK_AUTHORIZATION_TYPES,
  MOCK_EIP712_DOMAIN,
  MOCK_NETWORK,
  MOCK_SCHEME,
  MockExactFacilitatorScheme,
  type MockAuthorization,
  type MockNonceStore,
} from "../../shared/src/entries/payment.js";

export const NETWORK = MOCK_NETWORK;
export const PAY_TO = "0x0000000000000000000000000000000000000402";
/** A fixed clock, so a validity window is a number and not a stopwatch. */
export const NOW_MS = 1_700_000_000_000;
export const NOW_SEC = Math.floor(NOW_MS / 1000);

export function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: MOCK_SCHEME,
    network: NETWORK,
    asset: MOCK_ASSET,
    amount: "50000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: {},
    ...overrides,
  };
}

export function clientAccount() {
  return privateKeyToAccount(generatePrivateKey());
}

export type Account = ReturnType<typeof clientAccount>;

/**
 * Sign a hand-built authorization, so a test can present a valid signature
 * over a window the facilitator should still refuse.
 */
export async function signAuthorization(
  account: Account,
  authorization: MockAuthorization,
): Promise<`0x${string}`> {
  return account.signTypedData({
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
}

export interface Window {
  validAfter?: number;
  validBefore?: number;
  value?: string;
  nonce?: string;
}

export async function authorizedPayload(account: Account, window: Window = {}): Promise<PaymentPayload> {
  const authorization: MockAuthorization = {
    from: account.address,
    to: PAY_TO,
    value: window.value ?? "50000",
    validAfter: String(window.validAfter ?? NOW_SEC - 60),
    validBefore: String(window.validBefore ?? NOW_SEC + 300),
    nonce: (window.nonce ?? `0x${randomBytes(32).toString("hex")}`) as `0x${string}`,
  };
  const signature = await signAuthorization(account, authorization);
  return {
    x402Version: 2,
    accepted: requirements(),
    payload: { authorization, signature } as unknown as Record<string, unknown>,
  };
}

/**
 * A nonce store that records what reached it, so "refused before claim" is
 * observable rather than inferred from the answer. It is one-shot like the real
 * store by default; pass an answer to force every claim the same way.
 */
export class RecordingNonceStore implements MockNonceStore {
  readonly claims: Array<{
    nonce: string;
    meta: { payer: string; paymentKey: string; amount: string };
  }> = [];
  private readonly seen = new Set<string>();
  constructor(private readonly answer?: boolean) {}
  async claimNonce(
    nonce: string,
    meta: { payer: string; paymentKey: string; amount: string },
  ): Promise<boolean> {
    this.claims.push({ nonce, meta });
    if (this.answer !== undefined) return this.answer;
    if (this.seen.has(nonce)) return false;
    this.seen.add(nonce);
    return true;
  }
}

export function facilitator(
  options: {
    store?: RecordingNonceStore;
    now?: () => number;
    maxValiditySeconds?: number;
    verifier?: (args: unknown) => Promise<boolean>;
  } = {},
) {
  const store = options.store ?? new RecordingNonceStore();
  const verify = (options.verifier ?? verifyTypedData) as never;
  const scheme = new MockExactFacilitatorScheme(
    {
      store,
      network: NETWORK,
      now: options.now ?? (() => NOW_MS),
      ...(options.maxValiditySeconds !== undefined
        ? { maxValiditySeconds: options.maxValiditySeconds }
        : {}),
    },
    verify,
  );
  return { scheme, store };
}
