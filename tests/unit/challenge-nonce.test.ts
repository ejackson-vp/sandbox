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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../controller/src/store.js";
import { ChallengeNonceCapacityError } from "../../controller/src/store/challenges.js";
import { CHALLENGE_NONCE, postCreate } from "../helpers/create-route.js";

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
