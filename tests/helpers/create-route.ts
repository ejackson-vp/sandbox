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
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/client";
import { vi } from "vitest";
import { clientCommitmentMessage } from "../../shared/src/entries/crypto.js";
import {
  DEFAULT_TIERS,
  MOCK_NETWORK,
  MockExactClientScheme,
  loadPlatformLimits,
  paymentKey,
} from "../../shared/src/entries/payment.js";
import { TokenBucket } from "../../shared/src/entries/runtime.js";
import type { SettlementLookup } from "../../shared/src/entries/runtime.js";
import { createSessionHandler } from "../../api/src/routes/create-session.js";

export const CHALLENGE_NONCE = `cn_${"a".repeat(32)}`;

export const REQUIREMENT = {
  scheme: "exact",
  network: MOCK_NETWORK,
  asset: "mock:usdc",
  amount: "50000",
  payTo: "0x0000000000000000000000000000000000000402",
  maxTimeoutSeconds: 300,
  extra: {},
};

/** Everything the handler may call on the controller, defaulted to "admit". */
export interface ControllerStub {
  preflightCapacity: ReturnType<typeof vi.fn>;
  holdCapacity: ReturnType<typeof vi.fn>;
  claimIntent: ReturnType<typeof vi.fn>;
  completeIntent: ReturnType<typeof vi.fn>;
  burnChallengeNonce: ReturnType<typeof vi.fn>;
  reserveBudget: ReturnType<typeof vi.fn>;
  releaseCapacity: ReturnType<typeof vi.fn>;
  failIntent: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  wake: ReturnType<typeof vi.fn>;
  healthz: ReturnType<typeof vi.fn>;
}

export function admittingController(): ControllerStub {
  return {
    preflightCapacity: vi.fn(async () => ({ admitted: true as const, reservationId: "r" })),
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
    wake: vi.fn(async () => undefined),
    healthz: vi.fn(async () => ({ ok: true })),
  };
}

export interface CreateResult {
  status: number;
  body: { error?: string; [key: string]: unknown };
  controller: ControllerStub;
  payment402: ReturnType<typeof vi.fn>;
  paymentKey: string;
}

/**
 * Post a paid create with a valid header and commitment. `patch` runs before
 * the handler is built so a test can change one controller answer or one body
 * field without rebuilding the harness. `opts.settlementLookup` replaces the
 * inert default when a test exercises the recovery path.
 */
export async function postCreate(
  patch: (ctx: { controller: ControllerStub; body: Record<string, unknown> }) => void = () => undefined,
  opts: { settlementLookup?: SettlementLookup } = {},
): Promise<CreateResult> {
  const account = privateKeyToAccount(generatePrivateKey());
  const controller = admittingController();
  const body: Record<string, unknown> = {
    tier: "standard",
    clientPublicKey: "a".repeat(44),
    clientNonce: "b".repeat(44),
    challengeNonce: CHALLENGE_NONCE,
  };
  patch({ controller, body });

  const client = x402Client.fromConfig({
    schemes: [{ network: MOCK_NETWORK, client: new MockExactClientScheme(account) }],
    spendControls: false,
  });
  const payload = await client.createPaymentPayload({
    x402Version: 2,
    resource: { url: "https://sandbox.test/v1/sessions" },
    accepts: [REQUIREMENT],
  } as never);
  const header = new x402HTTPClient(client).encodePaymentSignatureHeader(payload)["PAYMENT-SIGNATURE"]!;
  const key = paymentKey(decodePaymentSignatureHeader(header));

  if (body.clientSignature === undefined) {
    body.clientSignature = await account.signMessage({
      message: clientCommitmentMessage({
        paymentKey: key,
        clientPublicKey: body.clientPublicKey as string,
        clientNonce: body.clientNonce as string,
        challengeNonce: body.challengeNonce as string,
      }),
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
      capabilityTtlSeconds: 60,
      intentStaleMs: 30_000,
    },
    controller,
    resourceServer: {},
    settlementLookup: opts.settlementLookup ?? { supported: false, lookup: async () => null },
    requirementFor: async () => REQUIREMENT,
    payment402,
    capabilityFor: () => "capability",
    ipCreateLimiter: new TokenBucket(100, 100),
    createLimiter: new TokenBucket(100, 100),
  } as never);

  await handler(
    {
      body,
      ip: "127.0.0.1",
      header: (name: string) => (name.toLowerCase() === "payment-signature" ? header : undefined),
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
  };
}
