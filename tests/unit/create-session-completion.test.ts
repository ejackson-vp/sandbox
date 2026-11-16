/**
 * Entitlement completion: the settled payment becomes exactly one session.
 *
 * Every branch here is about money that has already moved, and each one has a
 * failure mode that costs a customer a session or charges for one twice:
 *
 *  - a concurrent worker won the completion race, so the answer must be *that*
 *    session, with a capability re-derived from the same payment;
 *  - the capability was signed by a key that has since been retired, so no
 *    honest answer exists and the client must be told to buy a new session
 *    instead of being handed an unusable one;
 *  - the completion failed for a reason the caller can retry (capacity), or one
 *    they cannot (anything else), and the difference is whether the payment
 *    stays recoverable.
 *
 * These go through `postCreate`, so the real handler, the real stages and the
 * real shape of the answer are what is asserted.
 */
import { describe, expect, it, vi } from "vitest";
import { ControllerError } from "../../api/src/controller-client.js";
import { postCreate } from "../helpers/create-route.js";

const WINNER_ID = "sbx_aaaaaaaaaaaaaaaaaaaaaaaa";
const CAPABILITY_HASH = "f".repeat(64);

/** Verify and settle succeed: this file is about what happens after settle. */
const settled = {
  verifyPayment: async () => ({ isValid: true }),
  settlePayment: async () => ({ success: true, transaction: "mock:tx", network: "mock:local" }),
};

/** The paid create, with a facilitator that verifies and settles. */
function paid(
  patch: Parameters<typeof postCreate>[0],
  opts: Parameters<typeof postCreate>[1] = {},
) {
  return postCreate(patch, { resourceServer: settled, ...opts });
}

/** The controller's view of a session that already exists. */
function winnerView(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: WINNER_ID,
    state: "PAID",
    tier: "standard",
    durationSeconds: 300,
    limits: { cpuMillis: 500, memoryMiB: 512, diskMiB: 256 },
    createdAt: Date.now(),
    remainingSeconds: 300,
    clientNonce: "b".repeat(44),
    clientPublicKey: "a".repeat(44),
    capabilityHash: CAPABILITY_HASH,
    capabilityExpiresAt: Date.now() + 60_000,
    busy: false,
    payment: {
      paymentKey: "0x" + "c".repeat(64),
      network: "mock:local",
      scheme: "exact",
      asset: "mock:usdc",
      amount: "50000",
      payTo: "0x0000000000000000000000000000000000000402",
      mode: "mock",
    },
    ...overrides,
  };
}

describe("a completion that this request won", () => {
  it("answers 201 with the folded session view and does not re-read it", async () => {
    const result = await paid(({ controller }) => {
      controller.completeIntent = vi.fn(async () => ({ sessionId: WINNER_ID, state: "PAID", created: true, session: winnerView() }));
    });

    expect(result.status).toBe(201);
    expect(result.body.sessionId).toBe(WINNER_ID);
    // The harness mints with the production ring, so the capability is a real
    // key-id-prefixed HMAC rather than a constant.
    expect(result.body.capability).toMatch(/^k1\.[A-Za-z0-9_-]{43}$/);
    // The view is folded into the completion, so the extra round trip is gone.
    expect(result.controller.getSession).not.toHaveBeenCalled();
    expect(result.body).toMatchObject({ state: "PAID", tier: "standard", durationSeconds: 300 });
  });
});

describe("a completion that lost the race", () => {
  it("returns the session the winner created, with its capability re-derived", async () => {
    const recovered: Array<{ key: string; commitment: string; storedHash: string }> = [];
    const result = await paid(
      ({ controller }) => {
        controller.completeIntent = vi.fn(async () => ({ sessionId: WINNER_ID, state: "PAID", created: false, session: winnerView() }));
      },
      {
        recoverCapability: (key, commitment, storedHash) => {
          recovered.push({ key, commitment, storedHash });
          return "replayed-capability";
        },
      },
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      sessionId: WINNER_ID,
      capability: "replayed-capability",
      state: "PAID",
    });
    // One payment, one session: the capability comes from the winner's stored
    // hash, not from a fresh mint.
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.storedHash).toBe(CAPABILITY_HASH);
    expect(recovered[0]!.key).toBe(result.paymentKey);
  });

  it("falls back to a lookup when the controller does not fold the view in", async () => {
    const result = await paid(
      ({ controller }) => {
        controller.completeIntent = vi.fn(async () => ({ sessionId: WINNER_ID, state: "PAID", created: false }));
        controller.getSession = vi.fn(async () => winnerView());
      },
      { recoverCapability: () => "recovered-capability" },
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      sessionId: WINNER_ID,
      capability: "recovered-capability",
      limits: { cpuMillis: 500, memoryMiB: 512, diskMiB: 256 },
    });
  });

  it("refuses to invent a session when the winner cannot be read", async () => {
    const result = await paid(({ controller }) => {
      controller.completeIntent = vi.fn(async () => ({ sessionId: WINNER_ID, state: "PAID", created: false }));
      controller.getSession = vi.fn(async () => null);
    });

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ error: "provisioning_unavailable" });
    expect(result.body.message).toContain("contact support");
  });

  it("answers 409 when no configured key can reproduce the stored hash", async () => {
    // No override: the harness recovers with the production ring, and the
    // winner's stored hash is not one this ring can produce.
    const result = await paid(({ controller }) => {
      controller.completeIntent = vi.fn(async () => ({ sessionId: WINNER_ID, state: "PAID", created: false, session: winnerView() }));
    });

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: "capability_key_retired", sessionId: WINNER_ID });
  });
});

describe("a completion the controller rejected", () => {
  it("returns the concurrent winner's session when the 409 names one", async () => {
    const result = await paid(
      ({ controller }) => {
        controller.completeIntent = vi.fn(async () => {
          throw new ControllerError(409, "intent_settled", "already completed", { sessionId: WINNER_ID });
        });
        controller.getSession = vi.fn(async () => winnerView());
      },
      { recoverCapability: () => "recovered-capability" },
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ sessionId: WINNER_ID, capability: "recovered-capability" });
  });

  it("keeps the settled payment recoverable when the completion lost capacity", async () => {
    const result = await paid(({ controller }) => {
      controller.completeIntent = vi.fn(async () => {
        throw new ControllerError(503, "capacity_unavailable", "settled, no node", { reason: "no_eligible_nodes" });
      });
    });

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      error: "capacity_unavailable",
      retryable: true,
      reason: "no_eligible_nodes",
    });
    // The client is told to retry the same payment, not to pay again.
    expect(String(result.body.message)).toContain("same payment");
  });

  it("answers 503 without leaking the controller's message for anything else", async () => {
    const result = await paid(({ controller }) => {
      controller.completeIntent = vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.7:3001");
      });
    });

    expect(result.status).toBe(503);
    expect(result.body).toEqual({
      error: "provisioning_unavailable",
      message: "payment settled; contact support with your receipt",
    });
    expect(JSON.stringify(result.body)).not.toContain("10.0.0.7");
  });

  it("treats a 409 that names no session as a provisioning failure", async () => {
    const result = await paid(({ controller }) => {
      controller.completeIntent = vi.fn(async () => {
        throw new ControllerError(409, "intent_mismatch", "not the same payment");
      });
    });

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ error: "provisioning_unavailable" });
  });
});
