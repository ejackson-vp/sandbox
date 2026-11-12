/**
 * Single-use challenge nonces (#47, F-07).
 *
 * Two halves, both security properties rather than implementation detail:
 *
 *  - the *store* must refuse a second burn, survive a restart, honour the TTL
 *    and stay bounded;
 *  - the create *route* must refuse a reused/expired/unknown nonce before it
 *    holds capacity, claims the intent or settles anything.
 *
 * The end-to-end handshake (a real wallet signature over the nonce) is covered
 * by tests/integration/api-flow.test.ts, which CI runs.
 */
import { describe, expect, it } from "vitest";
import { ChallengeNonceCapacityError } from "../../controller/src/store/models.js";
import { CHALLENGE_NONCE, postCreate } from "../helpers/create-route.js";
import { freshStore, openStore, sqlExec } from "../helpers/test-store.js";

const NONCE = `cn_${"a".repeat(32)}`;
const OTHER = `cn_${"b".repeat(32)}`;
const PAYMENT = "f".repeat(64);

describe("challenge nonce store", () => {
  it("burns once, replays for the same payment and refuses another", async () => {
    const store = await freshStore();
    await store.issueChallengeNonce(NONCE, 60_000, 0);

    expect(await store.burnChallengeNonce(NONCE, PAYMENT)).toEqual({ status: "burned" });
    // The same payment retrying is the crash-recovery path, not an attack.
    expect(await store.burnChallengeNonce(NONCE, PAYMENT)).toEqual({ status: "replay" });
    // A different payment cannot ride the same challenge.
    expect(await store.burnChallengeNonce(NONCE, "e".repeat(64))).toEqual({ status: "reused" });
  });

  it("refuses an expired nonce and an unknown one", async () => {
    const store = await freshStore();
    // A zero TTL is expired by the time the burn reads the row.
    await store.issueChallengeNonce(NONCE, 0, 0);
    expect(await store.burnChallengeNonce(NONCE, PAYMENT)).toEqual({ status: "expired" });
    expect(await store.burnChallengeNonce(OTHER, PAYMENT)).toEqual({ status: "unknown" });
  });

  it("keeps the burn across a restart", async () => {
    const store = await freshStore();
    await store.issueChallengeNonce(NONCE, 60_000, 0);
    await store.burnChallengeNonce(NONCE, PAYMENT);
    await store.close();

    const reopened = await openStore();
    try {
      expect(await reopened.burnChallengeNonce(NONCE, PAYMENT)).toEqual({ status: "replay" });
      expect(await reopened.burnChallengeNonce(NONCE, "e".repeat(64))).toEqual({ status: "reused" });
    } finally {
      await reopened.close();
    }
  });

  it("bounds active nonces and recovers once they expire", async () => {
    const store = await freshStore();
    await store.issueChallengeNonce(NONCE, 60_000, 2);
    await store.issueChallengeNonce(OTHER, 60_000, 2);
    await expect(store.issueChallengeNonce(`cn_${"c".repeat(32)}`, 60_000, 2)).rejects.toThrow(
      ChallengeNonceCapacityError,
    );
    // Past the TTL the same cap admits a new challenge.
    await sqlExec("UPDATE challenge_nonces SET expires_at = 0");
    const issued = await store.issueChallengeNonce(`cn_${"c".repeat(32)}`, 60_000, 2);
    expect(issued.nonce).toBe(`cn_${"c".repeat(32)}`);
    expect(issued.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe("create route with a spent challenge", () => {
  it.each(["reused", "expired", "unknown"])(
    "answers 402 for a %s nonce, before capacity or money",
    async (status) => {
      const result = await postCreate(({ controller }) => {
        controller.burnChallengeNonce.mockResolvedValue({ status });
      });

      expect(result.status).toBe(402);
      expect(result.body.error).toBe(`challenge_nonce_${status}`);
      expect(result.controller.burnChallengeNonce).toHaveBeenCalledWith(CHALLENGE_NONCE, result.paymentKey);
      // Nothing was held, claimed, budgeted or settled.
      expect(result.controller.holdCapacity).not.toHaveBeenCalled();
      expect(result.controller.claimIntent).not.toHaveBeenCalled();
      expect(result.controller.reserveBudget).not.toHaveBeenCalled();
    },
  );

  it("continues on a replay of the same payment", async () => {
    const result = await postCreate(({ controller }) => {
      controller.burnChallengeNonce.mockResolvedValue({ status: "replay" });
    });

    expect(result.controller.holdCapacity).toHaveBeenCalled();
    expect(result.controller.claimIntent).toHaveBeenCalled();
    expect(result.controller.reserveBudget).toHaveBeenCalled();
  });

  it("answers 402 when a payment arrives without a challenge nonce", async () => {
    const result = await postCreate(({ body }) => {
      delete body.challengeNonce;
    });

    expect(result.status).toBe(402);
    expect(result.body.error).toBe("challenge_nonce_required");
    expect(result.controller.burnChallengeNonce).not.toHaveBeenCalled();
  });
});
