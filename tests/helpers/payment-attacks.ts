/**
 * Attack tooling for the payment path.
 *
 * `tests/unit/payment-adversarial.test.ts` is the record of the attacks; this is
 * what they are built from. It lives here so the suite stays a list of attacks
 * rather than a list of fixtures, and so the structual line budget counts the
 * attacks and nothing else.
 *
 * Two things are deliberately real rather than stubbed: the facilitator is the
 * repository's own `MockExactFacilitatorScheme` (so a refusal is the guard
 * firing, not a stub agreeing), and the chain is the real
 * `UsdcSettlementVerifier` over a fake reader. Nothing here reaches a network.
 */
import { randomBytes } from "node:crypto";
import { vi } from "vitest";
import { verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { ControllerSessionView } from "../../shared/src/entries/protocol.js";
import { sha256Hex } from "../../shared/src/entries/crypto.js";
import {
  MOCK_NETWORK,
  MockExactFacilitatorScheme,
  type MockAuthorization,
} from "../../shared/src/entries/payment.js";
import { REQUIREMENT, postCreate } from "./create-route.js";
import { RecordingNonceStore, signAuthorization } from "./mock-scheme.js";
import {
  AUTHORIZATION_USED_TOPIC,
  TX_HASH,
  USDC,
  fakeReader,
  receiptWith,
  topicOf,
  transfer,
  usdcVerifier,
} from "./settlement-fixtures.js";

export type Account = ReturnType<typeof privateKeyToAccount>;

export const ACCOUNT = () => privateKeyToAccount(generatePrivateKey());
export const ZERO = "0x0000000000000000000000000000000000000000";
export const ELSEWHERE = "0x9999999999999999999999999999999999999999";
export const ATOMIC = BigInt(REQUIREMENT.amount);

/** A live-window EIP-712 authorisation, signed by `account`. */
export async function payloadFor(
  account: Account,
  overrides: Partial<MockAuthorization> = {},
  accepted: PaymentRequirements = REQUIREMENT,
): Promise<PaymentPayload> {
  const now = Math.floor(Date.now() / 1000);
  const authorization: MockAuthorization = {
    from: account.address,
    to: accepted.payTo as `0x${string}`,
    value: accepted.amount,
    validAfter: String(now - 60),
    validBefore: String(now + 300),
    nonce: `0x${randomBytes(32).toString("hex")}`,
    ...overrides,
  };
  const signature = await signAuthorization(account, authorization);
  return {
    x402Version: 2,
    accepted,
    payload: { authorization, signature },
  } as unknown as PaymentPayload;
}

export function headerOf(payload: PaymentPayload): string {
  return encodePaymentSignatureHeader(payload);
}

export function authorizationOf(payload: PaymentPayload): MockAuthorization {
  return (payload.payload as unknown as { authorization: MockAuthorization }).authorization;
}

/** The real mock facilitator, wired the way the API wires one. */
export function facilitator(store = new RecordingNonceStore()) {
  const scheme = new MockExactFacilitatorScheme(
    { store, network: MOCK_NETWORK },
    verifyTypedData as never,
  );
  const verifyPayment = vi.fn(async (p: unknown, r: unknown) => scheme.verify(p as never, r as never));
  const settlePayment = vi.fn(async (p: unknown, r: unknown) => scheme.settle(p as never, r as never));
  return { store, verifyPayment, settlePayment, resourceServer: { verifyPayment, settlePayment } };
}

/**
 * A facilitator that always passes verify, so the guard under test is the one
 * after it. Used on the recovery branches, where verify is not the gate.
 */
export function permissiveFacilitator(settle: () => Promise<unknown>) {
  return { verifyPayment: async () => ({ isValid: true }), settlePayment: vi.fn(settle) };
}

/** An `AuthorizationUsed` log for this authorisation, on the real USDC address. */
export function authUsed(authorizer: string, nonce: string, address: string = USDC) {
  return {
    address,
    topics: [AUTHORIZATION_USED_TOPIC, topicOf(authorizer), nonce.toLowerCase()],
    data: "0x",
    transactionHash: TX_HASH,
    removed: false,
  };
}

/** A receipt whose Transfer names `from`, `to` and `value`. */
export function receipt(from: string, to: string = REQUIREMENT.payTo, value: bigint = ATOMIC) {
  return receiptWith(transfer({ from, to, value }));
}

/** The real verifier over a fake chain, anchored on one payment's nonce. */
export function chainFor(
  payload: PaymentPayload,
  answers: Parameters<typeof fakeReader>[0] = {},
) {
  const authorization = authorizationOf(payload);
  const reader = fakeReader({
    head: 1_000_000n,
    logs: [authUsed(authorization.from, authorization.nonce)],
    ...answers,
  });
  return { reader, verifier: usdcVerifier(reader) };
}

/** The controller's view of a session, for the replay paths. */
export function sessionView(overrides: Partial<ControllerSessionView> = {}): ControllerSessionView {
  const now = Date.now();
  return {
    sessionId: "sbx_first",
    state: "PAID",
    tier: "standard",
    durationSeconds: 300,
    limits: {
      cpuMillis: 1000,
      memoryMiB: 1024,
      diskMiB: 1024,
      maxOutputBytes: 262_144,
      maxFileBytes: 8 * 1024 * 1024,
      maxCommandSeconds: 300,
      maxProcesses: 64,
    },
    createdAt: now,
    remainingSeconds: 300,
    clientPublicKey: "a".repeat(44),
    clientNonce: "b".repeat(44),
    capabilityHash: sha256Hex("capability"),
    capabilityExpiresAt: now + 60_000,
    busy: false,
    payment: {
      paymentKey: "p",
      network: MOCK_NETWORK,
      scheme: "exact",
      asset: "mock:usdc",
      amount: REQUIREMENT.amount,
      payTo: REQUIREMENT.payTo as `0x${string}`,
      mode: "mock",
    },
    ...overrides,
  };
}

/** A create whose only answer is the chain: verify and settle are permissive. */
export async function chainAttempt(
  payer: Account,
  payload: PaymentPayload,
  answers: Parameters<typeof chainFor>[1] = {},
  settle: () => Promise<unknown> = async () => ({
    success: true,
    transaction: "0xtx",
    network: MOCK_NETWORK,
  }),
) {
  const { reader, verifier } = chainFor(payload, answers);
  const result = await postCreate(() => undefined, {
    account: payer,
    paymentHeader: headerOf(payload),
    resourceServer: permissiveFacilitator(settle),
    settlementVerifier: verifier,
  });
  return { result, reader };
}

/** A create the controller answers `recovered` for: the crash-recovery branch. */
export function recoveredIntent(): Parameters<typeof postCreate>[0] {
  return ({ controller }) => {
    Object.assign(controller, {
      claimIntent: vi.fn(async () => ({
        status: "claimed" as const,
        recovered: true,
        token: "t",
        expiresAt: 1,
      })),
    });
  };
}

/** A facilitator that says the nonce is already spent. */
export function nonceAlreadyUsed() {
  return async () => ({
    success: false,
    errorReason: "nonce_already_used",
    transaction: "",
    network: MOCK_NETWORK,
  });
}
