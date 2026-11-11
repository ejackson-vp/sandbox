/**
 * Single-use challenge nonces (#47, F-07).
 *
 * Two halves, both of them security properties rather than implementation
 * detail:
 *
 *  - the *store* must refuse a second burn, survive a restart, honour the TTL
 *    and stay bounded;
 *  - the create *route* must refuse a reused/expired/unknown nonce before it
 *    holds capacity, claims the intent or settles anything.
 *
 * The end-to-end handshake (a real wallet signature over the nonce) is covered
 * by tests/integration/api-flow.test.ts, which CI runs.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { clientCommitmentMessage } from "../../shared/src/entries/crypto.js";
import { MOCK_NETWORK, paymentKey } from "../../shared/src/entries/payment.js";
import { TokenBucket } from "../../shared/src/entries/runtime.js";
import { DEFAULT_TIERS, loadPlatformLimits } from "../../shared/src/entries/payment.js";
import { Store } from "../../controller/src/store.js";
import { ChallengeNonceCapacityError } from "../../controller/src/store/challenges.js";
import { createSessionHandler } from "../../api/src/routes/create-session.js";
import { createMockPayingClient } from "../helpers/x402.js";

const NONCE = `cn_${"a".repeat(32)}`;
const OTHER = `cn_${"b".repeat(32)}`;
const PAYMENT = "f".repeat(64);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshStore(): { store: Store; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "x402-nonce-"));
  dirs.push(dir);
  const path = join(dir, "controller.db");
  return { store: new Store(path), path };
}

describe("challenge nonce store", () => {
  it("burns once, replays for the same payment and refuses another", () => {
    const { store } = freshStore();
    const now = 1_000;
    store.challenges.issue(NONCE, now, 60_000, 0);

    expect(store.challenges.burn(NONCE, PAYMENT, now + 1)).toEqual({ status: "burned" });
    // The same payment retrying is the crash-recovery path, not an attack.
    expect(store.challenges.burn(NONCE, PAYMENT, now + 2)).toEqual({ status: "replay" });
    // A different payment cannot ride the same challenge.
    expect(store.challenges.burn(NONCE, "e".repeat(64), now + 3)).toEqual({ status: "reused" });
  });

  it("refuses an expired nonce and an unknown one", () => {
    const { store } = freshStore();
    store.challenges.issue(NONCE, 1_000, 5_000, 0);
    expect(store.challenges.burn(NONCE, PAYMENT, 6_000)).toEqual({ status: "expired" });
    expect(store.challenges.burn(OTHER, PAYMENT, 6_000)).toEqual({ status: "unknown" });
  });

  it("keeps the burn across a restart", () => {
    const { store, path } = freshStore();
    store.challenges.issue(NONCE, Date.now(), 60_000, 0);
    store.challenges.burn(NONCE, PAYMENT, Date.now());
    store.close();

    const reopened = new Store(path);
    expect(reopened.challenges.burn(NONCE, PAYMENT, Date.now())).toEqual({ status: "replay" });
    expect(reopened.challenges.burn(NONCE, "e".repeat(64), Date.now())).toEqual({ status: "reused" });
    reopened.close();
  });

  it("bounds active nonces and recovers once they expire", () => {
    const { store } = freshStore();
    store.challenges.issue(NONCE, 1_000, 1_000, 2);
    store.challenges.issue(OTHER, 1_000, 1_000, 2);
    expect(() => store.challenges.issue(`cn_${"c".repeat(32)}`, 1_000, 1_000, 2)).toThrow(
      ChallengeNonceCapacityError,
    );
    // Past the TTL the same cap admits a new challenge.
    expect(store.challenges.issue(`cn_${"c".repeat(32)}`, 5_000, 1_000, 2)).toMatchObject({
      nonce: `cn_${"c".repeat(32)}`,
      expiresAt: 6_000,
    });
  });
});

/* ------------------------------------------------------------------ */
/* The create route refuses a nonce it cannot burn, before any money.  */
/* ------------------------------------------------------------------ */

const requirement = {
  scheme: "exact",
  network: MOCK_NETWORK,
  asset: "mock:usdc",
  amount: "50000",
  payTo: "0x0000000000000000000000000000000000000402",
  maxTimeoutSeconds: 300,
  extra: {},
};

async function signedRequest(burnStatus: string) {
  const account = privateKeyToAccount(generatePrivateKey());
  const { client, http } = createMockPayingClient(account);
  const payload = await client.createPaymentPayload({
    x402Version: 2,
    resource: { url: "https://sandbox.test/v1/sessions" },
    accepts: [requirement],
  } as never);
  const header = http.encodePaymentSignatureHeader(payload)["PAYMENT-SIGNATURE"]!;
  const key = paymentKey(decodePaymentSignatureHeader(header));

  const clientPublicKey = "a".repeat(44);
  const clientNonce = "b".repeat(44);
  const challengeNonce = NONCE;
  const clientSignature = await account.signMessage({
    message: clientCommitmentMessage({ paymentKey: key, clientPublicKey, clientNonce, challengeNonce }),
  });

  const controller = {
    preflightCapacity: vi.fn(async () => ({ admitted: true as const, reservationId: "r" })),
    holdCapacity: vi.fn(async () => ({ admitted: true as const, nodeId: "n", reservation: { nodeId: "n" } })),
    claimIntent: vi.fn(async () => ({ status: "claimed" as const, recovered: false, token: "t", expiresAt: 1 })),
    burnChallengeNonce: vi.fn(async () => ({ status: burnStatus })),
    // The replay case runs past the nonce into verification, which fails on the
    // stubbed resource server; the release path must exist for it.
    releaseCapacity: vi.fn(async () => undefined),
    failIntent: vi.fn(async () => undefined),
  };
  const payment402 = vi.fn(async (res: { status: (code: number) => { json: (v: unknown) => void } }, _r: unknown, error: string) => {
    res.status(402).json({ error });
  });
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
  const request = {
    body: { tier: "standard", clientPublicKey, clientNonce, challengeNonce, clientSignature },
    ip: "127.0.0.1",
    header: (name: string) => (name.toLowerCase() === "payment-signature" ? header : undefined),
    on: () => undefined,
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
    settlementLookup: {},
    requirementFor: async () => requirement,
    payment402,
    capabilityFor: () => "capability",
    ipCreateLimiter: new TokenBucket(100, 100),
    createLimiter: new TokenBucket(100, 100),
  } as never);

  await handler(request as never, response as never);
  return { status: response.statusCode, body: response.body as { error?: string }, controller, payment402, key };
}

describe("create route with a spent challenge", () => {
  it.each(["reused", "expired", "unknown"])("answers 402 for a %s nonce, before capacity or money", async (status) => {
    const result = await signedRequest(status);
    expect(result.status).toBe(402);
    expect(result.body.error).toBe(`challenge_nonce_${status}`);
    expect(result.controller.burnChallengeNonce).toHaveBeenCalledWith(NONCE, result.key);
    // Nothing was held, claimed or settled.
    expect(result.controller.holdCapacity).not.toHaveBeenCalled();
    expect(result.controller.claimIntent).not.toHaveBeenCalled();
  });

  it("continues on a replay of the same payment", async () => {
    const result = await signedRequest("replay");
    expect(result.controller.holdCapacity).toHaveBeenCalled();
    expect(result.controller.claimIntent).toHaveBeenCalled();
    // Past capacity the route continues to the intent, so it is no longer a 402
    // from the nonce path.
    expect(result.body.error).not.toBe("challenge_nonce_reused");
  });
});
