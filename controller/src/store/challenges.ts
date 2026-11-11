/**
 * Single-use challenge nonces (F-07).
 *
 * The client commitment is a wallet signature over (paymentKey, clientPublicKey,
 * clientNonce). Without a server-issued freshness value, a captured *complete*
 * create request is a valid retry forever. The nonce in the 402 challenge is
 * burned on first use, so the signature is only good for one live challenge.
 *
 * State lives in the single-writer SQLite database because the API holds no
 * durable state and a restart must not resurrect a burned nonce. Three bounds
 * keep the table from becoming a write-amplification surface: a TTL, a prune on
 * issue (throttled), and a hard cap on active rows.
 */

import type { DatabaseSync, StatementSync } from "node:sqlite";

export type ChallengeBurnResult =
  | { status: "burned" }
  /** The same payment already burned this nonce: the retry/recovery path. */
  | { status: "replay" }
  | { status: "expired" }
  | { status: "unknown" }
  /** A different payment already burned this nonce. */
  | { status: "reused" };

export class ChallengeNonceCapacityError extends Error {
  constructor(active: number, max: number) {
    super(`challenge nonce table is full (${active}/${max}); refusing to issue`);
    this.name = "ChallengeNonceCapacityError";
  }
}

interface NonceRow {
  nonce: string;
  payment_key: string | null;
  issued_at: number;
  expires_at: number;
  burned_at: number | null;
}

export class ChallengeNonceRepository {
  /**
   * Last prune, so an unauthenticated 402 cannot turn every challenge into a
   * DELETE. Pruning is best effort: the TTL check on burn and the cap on issue
   * are what enforce the bound.
   */
  private lastPruneAt = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly stmts: Record<string, StatementSync>,
  ) {}

  issue(
    nonce: string,
    now: number,
    ttlMs: number,
    maxActive: number,
  ): { nonce: string; expiresAt: number } {
    this.maybePrune(now);
    const expiresAt = now + ttlMs;
    if (maxActive > 0) {
      const active = this.activeCount(now);
      if (active >= maxActive) {
        // A full table is almost always expired rows; one forced prune is cheap
        // and only runs on the unhappy path.
        this.prune(now);
        if (this.activeCount(now) >= maxActive) {
          throw new ChallengeNonceCapacityError(active, maxActive);
        }
      }
    }
    this.stmts.insertChallengeNonce!.run(nonce, now, expiresAt);
    return { nonce, expiresAt };
  }

  /**
   * Burn a nonce for one payment. Idempotent for the same payment (a retry must
   * still recover its entitlement) and refused for a different one.
   */
  burn(nonce: string, paymentKey: string, now: number): ChallengeBurnResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.stmts.getChallengeNonce!.get(nonce) as NonceRow | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return { status: "unknown" };
      }
      if (row.burned_at !== null) {
        this.db.exec("COMMIT");
        return { status: row.payment_key === paymentKey ? "replay" : "reused" };
      }
      if (row.expires_at <= now) {
        this.db.exec("COMMIT");
        return { status: "expired" };
      }
      const changed = this.stmts.burnChallengeNonce!.run(paymentKey, now, nonce, now).changes;
      this.db.exec("COMMIT");
      // A concurrent burn won the row between the read and the write.
      return changed > 0 ? { status: "burned" } : { status: "reused" };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Delete rows that are past their TTL and either unburned or burned long ago. */
  prune(now: number): number {
    this.lastPruneAt = now;
    return Number(this.stmts.pruneChallengeNonces!.run(now).changes ?? 0);
  }

  /** Rows that could still be burned. */
  activeCount(now: number): number {
    return (this.stmts.countActiveChallengeNonces!.get(now) as { n: number } | undefined)?.n ?? 0;
  }

  private maybePrune(now: number): void {
    if (now - this.lastPruneAt < 1_000) return;
    this.prune(now);
  }
}
