/**
 * Payment ledger and refund surface, for Postgres.
 *
 * Every state change is a conditional UPDATE, so two refund workers cannot both
 * move the same row: the loser matches zero rows and treats it as "someone else
 * already did this". `insertUnclaimed` is `ON CONFLICT DO NOTHING` for the same
 * reason: a concurrent recovery or a manual refund wins and the second write is
 * a no-op rather than an error.
 *
 * The refund claim is the one place a plain conditional UPDATE is not enough,
 * because the worker has to choose *which* due rows to own before it sends. It
 * is a single statement: a `FOR UPDATE SKIP LOCKED` sub-select picks the rows,
 * and the outer UPDATE fences them with one fresh token. Two workers running it
 * concurrently get disjoint sets, and neither waits behind the other (see
 * `claimRefunds`). The rule it implements is the shared durable-call contract
 * (ADR 0011): the arithmetic lives in `shared/src/durable/claim.ts`, and this
 * adapter only compares the cutoff it is given.
 */
import {
  mapIntent,
  mapLedger,
  type ClaimedRefund,
  type LedgerStatus,
  type PaymentIntentRecord,
  type PaymentLedgerRecord,
  type RefundClaimRequest,
  type UnclaimedLedgerEntry,
} from "../models.js";
import { keyPrefix, type ClaimToken } from "@x402s/shared/durable";
import type { PgConnection } from "./pg.js";

export class PgLedgerRepository {
  constructor(private readonly conn: PgConnection) {}

  private async one(text: string, values: unknown[]): Promise<PaymentLedgerRecord | null> {
    const res = await this.conn.query(text, values);
    const row = res.rows[0];
    return row ? mapLedger(row) : null;
  }

  private async many(text: string, values: unknown[] = []): Promise<PaymentLedgerRecord[]> {
    const res = await this.conn.query(text, values);
    return res.rows.map(mapLedger);
  }

  getByPayment(paymentKey: string): Promise<PaymentLedgerRecord | null> {
    return this.one("SELECT * FROM payment_ledger WHERE payment_key = $1", [paymentKey]);
  }

  getBySession(sessionId: string): Promise<PaymentLedgerRecord | null> {
    return this.one("SELECT * FROM payment_ledger WHERE session_id = $1", [sessionId]);
  }

  getByNonce(settlementNonce: string): Promise<PaymentLedgerRecord | null> {
    return this.one(
      "SELECT * FROM payment_ledger WHERE settlement_nonce = $1 ORDER BY created_at DESC LIMIT 1",
      [settlementNonce],
    );
  }

  listByStatus(status: LedgerStatus): Promise<PaymentLedgerRecord[]> {
    return this.many("SELECT * FROM payment_ledger WHERE status = $1 ORDER BY updated_at ASC", [status]);
  }

  async countByStatus(status: LedgerStatus): Promise<number> {
    const res = await this.conn.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM payment_ledger WHERE status = $1",
      [status],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  listUnrefundedTerminalBeforeReady(): Promise<PaymentLedgerRecord[]> {
    return this.many(
      // `source = 'x402'`: a $0 allowlist row has nothing to send back, and a
      // REFUND_PENDING row for it would be pure operator noise (ADR 0013).
      `SELECT l.* FROM payment_ledger l JOIN sessions s ON s.id = l.session_id
        WHERE l.status = 'SETTLED' AND l.source = 'x402' AND s.ready_at IS NULL
          AND s.state IN ('FAILED','EXPIRED','DESTROYED')
        ORDER BY l.updated_at ASC LIMIT 100`,
    );
  }

  listUnclaimedSettled(): Promise<PaymentLedgerRecord[]> {
    return this.many(
      `SELECT * FROM payment_ledger
        WHERE status = 'SETTLED' AND source = 'x402'
          AND (session_id LIKE 'unsettled:%' OR session_id LIKE 'duplicate:%')
        ORDER BY updated_at ASC LIMIT 100`,
    );
  }

  /**
   * Terminal relay-loss sessions whose ledger is still `SETTLED` (#31).
   *
   * The ordinary policy only refunds a session that never reached READY. A
   * session interrupted by relay loss did reach READY, but the remaining paid
   * time was undeliverable, so the start-up reconciliation refunds it too. The
   * reason match is exact: `failure:relay_lost` is the string the relay
   * continuity branch terminates with.
   */
  listRelayLostSettled(): Promise<PaymentLedgerRecord[]> {
    return this.many(
      `SELECT l.* FROM payment_ledger l JOIN sessions s ON s.id = l.session_id
        WHERE l.status = 'SETTLED' AND l.source = 'x402'
          AND s.state IN ('FAILED','EXPIRED','DESTROYED')
          AND (s.termination_reason IN ('failure:relay_lost','relay_lost')
               OR s.failure_code = 'relay_lost')
        ORDER BY l.updated_at ASC LIMIT 100`,
    );
  }

  /**
   * Take ownership of up to `limit` due refunds, one statement.
   *
   * Due means `REFUND_PENDING` whose backoff has elapsed, or `REFUND_SENDING`
   * whose lease expired (the crash/timeout path). A row at `maxAttempts` is
   * never due again, so an exhausted refund stays visible instead of being
   * retried forever.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes two workers disjoint: each locks the
   * rows it selects, and the other skips locked rows instead of blocking. The
   * outer UPDATE is the fence: every row leaves with a fresh token, a fresh
   * `refund_claimed_at`, and the stable idempotency key if it has none yet.
   * `RETURNING ... due.status` reports the state before the claim, which is how
   * the worker tells a first attempt from a stale-lease reclaim.
   *
   * A `REFUND_SENDING` row with no `refund_claimed_at` is treated as due: a row
   * that somehow lost its timestamp must not be stuck forever.
   *
   * The prefix is a parameter rather than a literal so the key here and
   * `shared/src/durable/keys.ts:refundKey` cannot drift apart.
   */
  async claimRefunds(request: RefundClaimRequest): Promise<ClaimedRefund[]> {
    const res = await this.conn.write(
      `WITH due AS (
         SELECT payment_key, status
           FROM payment_ledger
          WHERE refund_attempts < $4
            AND (
              (status = 'REFUND_PENDING'
               AND (refund_next_attempt_at IS NULL OR refund_next_attempt_at <= $1))
              OR (status = 'REFUND_SENDING'
                  AND (refund_claimed_at IS NULL OR refund_claimed_at <= $2))
            )
          ORDER BY updated_at ASC
          LIMIT $3
          FOR UPDATE SKIP LOCKED
       )
       UPDATE payment_ledger l
          SET status = 'REFUND_SENDING',
              refund_claim_token = $5,
              refund_claimed_at = $1,
              refund_idempotency_key = COALESCE(l.refund_idempotency_key, $6 || l.payment_key),
              updated_at = $1
         FROM due
        WHERE l.payment_key = due.payment_key
        RETURNING l.*, due.status AS previous_status`,
      [
        request.nowMs,
        request.leaseCutoffMs,
        request.limit,
        request.maxAttempts,
        request.claimToken,
        keyPrefix("refund"),
      ],
    );
    return res.rows.map((row) => ({
      ledger: mapLedger(row),
      reclaimed: (row as { previous_status?: string }).previous_status === "REFUND_SENDING",
    }));
  }

  /**
   * Provider paid: SENDING -> REFUNDED, but only for the owner that still holds
   * the token. Zero rows means another pass reclaimed the row, so this owner
   * must not claim the refund as its own. The policy reason is left alone.
   */
  async completeRefundClaim(
    paymentKey: string,
    claimToken: ClaimToken,
    transaction: string,
  ): Promise<boolean> {
    const res = await this.conn.write(
      `UPDATE payment_ledger
          SET status = 'REFUNDED', refund_tx = $1, refund_claim_token = NULL,
              refund_claimed_at = NULL, updated_at = $2
        WHERE payment_key = $3 AND status = 'REFUND_SENDING' AND refund_claim_token = $4`,
      [transaction, Date.now(), paymentKey, claimToken],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Provider declined: SENDING -> PENDING with the attempt counted and the next
   * backoff armed. Guarded on the token for the same reason as completion: a
   * stale owner must not release a row another pass has since claimed.
   */
  async releaseRefundClaim(
    paymentKey: string,
    claimToken: ClaimToken,
    error: string,
    nextAttemptAt: number,
  ): Promise<boolean> {
    const res = await this.conn.write(
      `UPDATE payment_ledger
          SET status = 'REFUND_PENDING',
              refund_attempts = refund_attempts + 1,
              refund_last_error = $1,
              refund_next_attempt_at = $2,
              refund_claim_token = NULL,
              refund_claimed_at = NULL,
              updated_at = $3
        WHERE payment_key = $4 AND status = 'REFUND_SENDING' AND refund_claim_token = $5`,
      [error.slice(0, 500), nextAttemptAt, Date.now(), paymentKey, claimToken],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async listStaleClaimedIntents(olderThan: number, limit: number): Promise<PaymentIntentRecord[]> {
    const res = await this.conn.query(
      `SELECT * FROM payment_intents
        WHERE status = 'claimed' AND updated_at <= $1
        ORDER BY updated_at ASC LIMIT $2`,
      [olderThan, limit],
    );
    return res.rows.map(mapIntent);
  }

  async markRefundPending(paymentKey: string, reason: string): Promise<boolean> {
    const res = await this.conn.write(
      `UPDATE payment_ledger SET status = 'REFUND_PENDING', reason = $1, updated_at = $2
        WHERE payment_key = $3 AND status = 'SETTLED'`,
      [reason.slice(0, 500), Date.now(), paymentKey],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Direct refund resolution: mock policy, duplicate charge, or an operator who
   * already sent the funds and is recording it.
   *
   * Deliberately refuses `REFUND_SENDING`: a worker owns that row and may be
   * mid-send, so recording a transaction here would race it. The worker's own
   * completion path is `completeRefundClaim`, which requires the token.
   */
  async markRefunded(paymentKey: string, transaction: string, reason: string): Promise<boolean> {
    const res = await this.conn.write(
      `UPDATE payment_ledger
          SET status = 'REFUNDED', reason = $1, refund_tx = $2,
              refund_claim_token = NULL, refund_claimed_at = NULL, updated_at = $3
        WHERE payment_key = $4 AND status IN ('SETTLED','REFUND_PENDING')`,
      [reason.slice(0, 500), transaction, Date.now(), paymentKey],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async insertUnclaimed(entry: UnclaimedLedgerEntry): Promise<boolean> {
    const now = Date.now();
    const res = await this.conn.write(
      `INSERT INTO payment_ledger
         (payment_key, session_id, payer, amount, asset, network, mode, status, reason,
          refund_tx, settlement_nonce, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
       ON CONFLICT DO NOTHING`,
      [
        entry.paymentKey,
        entry.sessionId,
        entry.payer,
        entry.amount,
        entry.asset,
        entry.network,
        entry.mode,
        entry.status,
        entry.reason,
        entry.refundTransaction ?? null,
        entry.settlementNonce,
        now,
      ],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
