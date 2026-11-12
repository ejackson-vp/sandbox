/**
 * Single-use challenge nonces, for Postgres (F-07).
 *
 * Burn is a conditional UPDATE with `RETURNING`, so the row decides the winner
 * and the loser re-reads to distinguish "the same payment retrying" (replay)
 * from "a different payment reusing the nonce" (reused). That is the same
 * answer the previous single-connection adapter returned from its serialised
 * read-then-write.
 *
 * `issue` enforces the hard cap on active rows by counting, and under
 * `READ COMMITTED` two concurrent issues can both see a count below the cap. The
 * by the number of in-flight issuers (single digits here), and the cap is a
 * write-amplification bound rather than a correctness invariant, so the trade is
 * deliberate: taking a global lock on an unauthenticated 402 path would let a
 * client stall every other challenge.
 */
import { ChallengeNonceCapacityError, type ChallengeBurnResult } from "../models.js";
import type { PgConnection } from "./pg.js";

interface NonceRow {
  nonce: string;
  payment_key: string | null;
  issued_at: number;
  expires_at: number;
  burned_at: number | null;
}

export class PgChallengeNonceRepository {
  /** Last prune, so an unauthenticated 402 cannot turn every challenge into a DELETE. */
  private lastPruneAt = 0;

  constructor(private readonly conn: PgConnection) {}

  async issue(
    nonce: string,
    now: number,
    ttlMs: number,
    maxActive: number,
  ): Promise<{ nonce: string; expiresAt: number }> {
    await this.maybePrune(now);
    const expiresAt = now + ttlMs;
    if (maxActive > 0) {
      const active = await this.activeCount(now);
      if (active >= maxActive) {
        await this.prune(now);
        if ((await this.activeCount(now)) >= maxActive) {
          throw new ChallengeNonceCapacityError(active, maxActive);
        }
      }
    }
    await this.conn.write(
      "INSERT INTO challenge_nonces (nonce, payment_key, issued_at, expires_at, burned_at) VALUES ($1, NULL, $2, $3, NULL)",
      [nonce, now, expiresAt],
    );
    return { nonce, expiresAt };
  }

  async burn(nonce: string, paymentKey: string, now: number): Promise<ChallengeBurnResult> {
    const found = await this.conn.query<NonceRow>(
      "SELECT * FROM challenge_nonces WHERE nonce = $1",
      [nonce],
    );
    const row = found.rows[0];
    if (!row) return { status: "unknown" };
    if (row.burned_at !== null) {
      return { status: row.payment_key === paymentKey ? "replay" : "reused" };
    }
    if (row.expires_at <= now) return { status: "expired" };

    const burned = await this.conn.write(
      `UPDATE challenge_nonces SET payment_key = $1, burned_at = $2
        WHERE nonce = $3 AND burned_at IS NULL AND expires_at > $2
        RETURNING payment_key`,
      [paymentKey, now, nonce],
    );
    if ((burned.rowCount ?? 0) > 0) return { status: "burned" };

    // Lost the row between the read and the update: report the committed answer.
    const after = await this.conn.query<NonceRow>(
      "SELECT * FROM challenge_nonces WHERE nonce = $1",
      [nonce],
    );
    const current = after.rows[0];
    if (!current) return { status: "unknown" };
    if (current.burned_at !== null) {
      return { status: current.payment_key === paymentKey ? "replay" : "reused" };
    }
    return current.expires_at <= now ? { status: "expired" } : { status: "reused" };
  }

  async prune(now: number): Promise<number> {
    this.lastPruneAt = now;
    const res = await this.conn.write("DELETE FROM challenge_nonces WHERE expires_at <= $1", [now]);
    return Number(res.rowCount ?? 0);
  }

  async activeCount(now: number): Promise<number> {
    const res = await this.conn.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM challenge_nonces WHERE expires_at > $1",
      [now],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  private async maybePrune(now: number): Promise<void> {
    if (now - this.lastPruneAt < 1_000) return;
    await this.prune(now);
  }
}
