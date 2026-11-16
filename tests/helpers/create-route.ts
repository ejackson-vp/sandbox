/**
 * Drive `createSessionHandler` end to end with a real payment header and a real
 * wallet signature over the client commitment.
 *
 * The handler is the only place the create-path decisions are ordered, so the
 * unit tests use this rather than mocking the handler itself. Everything the
 * handler talks to is a stub; the assertions are about which stub was called and
 * in what order.
 */
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/client";
import { vi } from "vitest";
import {
  clientCommitmentMessage,
  type ClientCommitmentInput,
} from "../../shared/src/entries/crypto.js";
import {
  DEFAULT_TIERS,
  MOCK_NETWORK,
  MockExactClientScheme,
  loadPlatformLimits,
  paymentKey,
} from "../../shared/src/entries/payment.js";
import { TokenBucket } from "../../shared/src/entries/runtime.js";
import type { SettlementLookup } from "../../shared/src/entries/runtime.js";
import {
  capabilityKeyRing,
  mintCapability,
  recoverCapability as recoverCapabilityFromRing,
} from "../../shared/src/capability.js";
import { createSessionHandler } from "../../api/src/routes/create-session.js";
import type { ChainSettlementVerifier } from "../../shared/src/entries/settlement.js";

export const CHALLENGE_NONCE = `cn_${"a".repeat(32)}`;

/**
 * The terms the harness prices every create at ($0.05, the `standard` tier).
 * Exported so an attack can build a payload against the same requirements the
 * server will quote, which is the only way to test one field in isolation.
 */
export const REQUIREMENT: PaymentRequirements = {
  scheme: "exact",
  network: MOCK_NETWORK,
  asset: "mock:usdc",
  amount: "50000",
  payTo: "0x0000000000000000000000000000000000000402",
  maxTimeoutSeconds: 300,
  extra: {},
};

/**
 * One fixed ring, so a capability re-derivation is the production HMAC rather
 * than a constant. Deliberately low entropy: a fixture, not a credential.
 */
const CAPABILITY_RING = capabilityKeyRing({ keyId: "k1", secret: "c".repeat(32) });

/** Everything the handler may call on the controller, defaulted to "admit". */
interface ControllerStub {
  preflightCapacity: ReturnType<typeof vi.fn>;
  authorizeAllowlistedPayer: ReturnType<typeof vi.fn>;
  holdCapacity: ReturnType<typeof vi.fn>;
  claimIntent: ReturnType<typeof vi.fn>;
  completeIntent: ReturnType<typeof vi.fn>;
  burnChallengeNonce: ReturnType<typeof vi.fn>;
  reserveBudget: ReturnType<typeof vi.fn>;
  releaseCapacity: ReturnType<typeof vi.fn>;
  failIntent: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  readCreateSwitch: ReturnType<typeof vi.fn>;
  wake: ReturnType<typeof vi.fn>;
  healthz: ReturnType<typeof vi.fn>;
}

/** The switch off, with the operator fields empty: no row has been written. */
export const SWITCH_OFF = {
  enabled: false as const,
  reason: "",
  actor: "",
  changedAt: null,
  expiresAt: null,
  expired: false,
};

function admittingController(): ControllerStub {
  return {
    preflightCapacity: vi.fn(async () => ({ admitted: true as const, reservationId: "r" })),
    authorizeAllowlistedPayer: vi.fn(async () => ({
      allowed: false as const,
      reason: "not_allowlisted" as const,
    })),
    holdCapacity: vi.fn(async () => ({ admitted: true as const, nodeId: "n", reservation: { nodeId: "n" } })),
    claimIntent: vi.fn(async () => ({ status: "claimed" as const, recovered: false, token: "t", expiresAt: 1 })),
    completeIntent: vi.fn(async () => ({ sessionId: "sbx_test", state: "PAID" as const, created: true })),
    burnChallengeNonce: vi.fn(async () => ({ status: "burned" })),
    reserveBudget: vi.fn(async () => ({
      ok: true,
      remaining: {
        payerCreates: 10,
        payerSpend: "1000",
        payerConcurrent: 2,
        globalCreates: 10,
        globalConcurrent: 10,
      },
      windowResetsAt: Date.now() + 60_000,
    })),
    releaseCapacity: vi.fn(async () => undefined),
    failIntent: vi.fn(async () => undefined),
    getSession: vi.fn(async () => null),
    readCreateSwitch: vi.fn(async () => SWITCH_OFF),
    wake: vi.fn(async () => undefined),
    healthz: vi.fn(async () => ({ ok: true })),
  };
}

interface CreateResult {
  status: number;
  body: { error?: string; [key: string]: unknown };
  controller: ControllerStub;
  payment402: ReturnType<typeof vi.fn>;
  paymentKey: string;
  /** The authorizer and EIP-3009 nonce in the signed header, for verifier assertions. */
  authorizer: `0x${string}`;
  settlementNonce: `0x${string}`;
  /** The server's own terms: the chain check must be given these, not the body. */
  terms: { payTo: `0x${string}`; amount: bigint };
  /** The header that was presented, so a second call can replay it verbatim. */
  header: string;
}

/**
 * Post a paid create with a valid header and commitment. `patch` runs before
 * the handler is built so a test can change one controller answer or one body
 * field without rebuilding the harness. `opts.settlementLookup` replaces the
 * inert default when a test exercises the recovery path, and `opts.resourceServer`
 * replaces the inert stub when a test exercises verify/settle.
 */
export async function postCreate(
  patch: (
    ctx: { controller: ControllerStub; body: Record<string, unknown> },
  ) => void | Promise<void> = () => undefined,
  opts: {
    settlementLookup?: SettlementLookup;
    /** A fake chain check. Tests must never reach an RPC. */
    settlementVerifier?: ChainSettlementVerifier;
    resourceServer?: {
      verifyPayment?: (...args: unknown[]) => Promise<unknown>;
      settlePayment?: (...args: unknown[]) => Promise<unknown>;
    };
    /** Sign the commitment with a different wallet (F-02 negative case). */
    commitmentSigner?: { signMessage(args: { message: string }): Promise<`0x${string}`> };
    /** Override PAYER_ALLOWLIST_ENABLED for the create. Defaults to on. */
    allowlistEnabled?: boolean;
    /**
     * The wallet that signs the payment header and the commitment. Reuse one
     * across two calls to replay a header, or to sign a commitment the payment
     * did not authorise.
     */
    account?: ReturnType<typeof privateKeyToAccount>;
    /** Body challenge nonce. Defaults to {@link CHALLENGE_NONCE}. */
    challengeNonce?: string;
    /**
     * Present this PAYMENT-SIGNATURE verbatim instead of minting one. The
     * commitment is still signed by `opts.account` (or `commitmentSigner`), so a
     * test can hold one payment constant and vary the proof.
     */
    paymentHeader?: string;
    /**
     * What the payer wallet actually signs. Defaults to the canonical
     * commitment; override one field to attack the binding (F-02, F-07).
     */
    commitmentMessage?: (canonical: ClientCommitmentInput) => ClientCommitmentInput;
    /** Price the requirement from the resolved spec, so a tier is really priced. */
    requirementFor?: (priceUsd: string, spec: { tier: string }) => PaymentRequirements;
    /**
     * Re-derive the capability an existing session was issued. Only the replay
     * and idempotent-completion paths call it, and only a test that wants to
     * name the replayed token should override it: the default is the production
     * derivation below, which is what makes a replay judged against the real
     * HMAC.
     */
    recoverCapability?: (key: string, commitment: string, storedHash: string) => string | null;
    /** Send no PAYMENT-SIGNATURE header: the unpaid quote path. */
    unpaid?: boolean;
  } = {},
): Promise<CreateResult> {
  const account = opts.account ?? privateKeyToAccount(generatePrivateKey());
  const controller = admittingController();
  const body: Record<string, unknown> = {
    tier: "standard",
    clientPublicKey: "a".repeat(44),
    clientNonce: "b".repeat(44),
    challengeNonce: opts.challengeNonce ?? CHALLENGE_NONCE,
  };
  await patch({ controller, body });

  let header: string;
  if (opts.paymentHeader) {
    header = opts.paymentHeader;
  } else {
    const client = x402Client.fromConfig({
      schemes: [{ network: MOCK_NETWORK, client: new MockExactClientScheme(account) }],
      spendControls: false,
    });
    const payload = await client.createPaymentPayload({
      x402Version: 2,
      resource: { url: "https://sandbox.test/v1/sessions" },
      accepts: [REQUIREMENT],
    } as never);
    header = new x402HTTPClient(client).encodePaymentSignatureHeader(payload)["PAYMENT-SIGNATURE"]!;
  }
  const decoded = decodePaymentSignatureHeader(header);
  const key = paymentKey(decoded);
  const authorization = (decoded.payload as { authorization?: { from?: string; nonce?: string } })
    .authorization;
  const authorizer = (authorization?.from ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
  const settlementNonce = (authorization?.nonce ?? `0x${"0".repeat(64)}`) as `0x${string}`;

  if (body.clientSignature === undefined) {
    const canonical: ClientCommitmentInput = {
      paymentKey: key,
      clientPublicKey: body.clientPublicKey as string,
      clientNonce: body.clientNonce as string,
      challengeNonce: body.challengeNonce as string,
    };
    body.clientSignature = await (opts.commitmentSigner ?? account).signMessage({
      message: clientCommitmentMessage(opts.commitmentMessage?.(canonical) ?? canonical),
    });
  }

  const payment402 = vi.fn(
    async (res: { status: (code: number) => { json: (v: unknown) => void } }, _r: unknown, error: string) => {
      res.status(402).json({ error });
    },
  );
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: unknown) {
      this.body = value;
      return this;
    },
    setHeader() {
      return this;
    },
    on() {
      return this;
    },
  };
  const handler = createSessionHandler({
    config: {
      tiers: DEFAULT_TIERS,
      platformLimits: loadPlatformLimits({}),
      network: MOCK_NETWORK,
      paymentMode: "mock",
      payerAllowlistEnabled: opts.allowlistEnabled ?? true,
      capabilityTtlSeconds: 60,
      intentStaleMs: 30_000,
    },
    controller,
    resourceServer: opts.resourceServer ?? {},
    settlementLookup: opts.settlementLookup ?? { supported: false, lookup: async () => null },
    ...(opts.settlementVerifier ? { settlementVerifier: opts.settlementVerifier } : {}),
    requirementFor: async (priceUsd: string, spec: { tier: string }) =>
      opts.requirementFor?.(priceUsd, spec) ?? REQUIREMENT,
    payment402,
    // The production derivation, so a replay is judged against the real HMAC:
    // the same payment with a different client commitment cannot reproduce the
    // stored hash, which is what makes a second create return 409 rather than a
    // token for someone else's session.
    capabilityFor: (key: string, commitment: string) =>
      mintCapability(CAPABILITY_RING.signing, key, commitment),
    recoverCapability: (key: string, commitment: string, storedHash: string) =>
      opts.recoverCapability?.(key, commitment, storedHash) ??
      recoverCapabilityFromRing(CAPABILITY_RING, key, commitment, storedHash),
    ipCreateLimiter: new TokenBucket(100, 100),
    createLimiter: new TokenBucket(100, 100),
  } as never);

  await handler(
    {
      body,
      ip: "127.0.0.1",
      header: (name: string) =>
        opts.unpaid || name.toLowerCase() !== "payment-signature" ? undefined : header,
      on: () => undefined,
    } as never,
    response as never,
  );
  return {
    status: response.statusCode,
    body: response.body as CreateResult["body"],
    controller,
    payment402,
    paymentKey: key,
    authorizer,
    settlementNonce,
    terms: { payTo: REQUIREMENT.payTo as `0x${string}`, amount: BigInt(REQUIREMENT.amount) },
    header,
  };
}
