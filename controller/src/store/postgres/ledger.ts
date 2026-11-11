/**
 * Payment ledger and refund surface, for Postgres.
 *
 * Every state change is a conditional UPDATE, so two refund workers cannot both
 * move the same row: the loser matches zero rows and treats it as "someone else
 * already did this". `insertUnclaimed` is `ON CONFLICT DO NOTHING` for the same
 * reason SQLite uses `INSERT OR IGNORE`: a concurrent recovery or a manual
 * refund wins and the second write is a no-op rather than an error.
 */
import { mapIntent, mapLedger, type LedgerStatus, type PaymentIntentRecord, type PaymentLedgerRecord } from "../models.js";
import type { UnclaimedLedgerEntry } from "../ledger.js";
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
      `SELECT l.* FROM payment_ledger l JOIN sessions s ON s.id = l.session_id
        WHERE l.status = 'SETTLED' AND s.ready_at IS NULL
          AND s.state IN ('FAILED','EXPIRED','DESTROYED')
        ORDER BY l.updated_at ASC LIMIT 100`,
    );
  }

  listUnclaimedSettled(): Promise<PaymentLedgerRecord[]> {
    return this.many(
      `SELECT * FROM payment_ledger
        WHERE status = 'SETTLED'
          AND (session_id LIKE 'unsettled:%' OR session_id LIKE 'duplicate:%')
        ORDER BY updated_at ASC LIMIT 100`,
    );
  }

  listRefundPendingDue(now: number, limit: number): Promise<PaymentLedgerRecord[]> {
    return this.many(
      `SELECT * FROM payment_ledger
        WHERE status = 'REFUND_PENDING'
          AND (refund_next_attempt_at IS NULL OR refund_next_attempt_at <= $1)
        ORDER BY updated_at ASC LIMIT $2`,
      [now, limit],
    );
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

  async markRefunded(paymentKey: string, transaction: string, reason: string): Promise<boolean> {
    const res = await this.conn.write(
      `UPDATE payment_ledger SET status = 'REFUNDED', reason = $1, refund_tx = $2, updated_at = $3
        WHERE payment_key = $4 AND status IN ('SETTLED','REFUND_PENDING')`,
      [reason.slice(0, 500), transaction, Date.now(), paymentKey],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async recordRefundAttempt(paymentKey: string, error: string, nextAttemptAt: number): Promise<boolean> {
    const res = await this.conn.write(
      `UPDATE payment_ledger
          SET refund_attempts = refund_attempts + 1, refund_last_error = $1,
              refund_next_attempt_at = $2, updated_at = $3
        WHERE payment_key = $4 AND status = 'REFUND_PENDING'`,
      [error.slice(0, 500), nextAttemptAt, Date.now(), paymentKey],
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
