/**
 * Durable per-payer and global create budgets, for Postgres (#48).
 *
 * A transaction-scoped advisory lock (`BUDGET_LOCK_KEY`) serialises the
 * reservation because the concurrency caps are counted from other tables and a
 * row lock on `payer_budgets` cannot make a *count of sessions* stable. Every
 * reservation therefore takes the same lock, then reads, then writes; the second
 * reservation sees the committed counters.
 *
 * Spend is separate: it commits inside `completeEntitlement`'s transaction and
 * takes a `FOR UPDATE` lock on the payer row, which is enough because the only
 * writer that can change `spend` is another settlement.
 */
import { NON_TERMINAL_STATE_SQL } from "../models.js";
import {
  GLOBAL_BUDGET_KEY,
  budgetSubject,
  decideBudget,
  payerBudgetKey,
  type BudgetDecision,
  type BudgetLimits,
} from "../budget-decision.js";
import { BUDGET_LOCK_KEY, type PgConnection, type Tx } from "./pg.js";

export type {
  BudgetDecision,
  BudgetLimits,
  BudgetRemaining,
  BudgetScope,
} from "../budget-decision.js";

interface BudgetRow {
  window_start_ms: number;
  creates: number;
  spend: string;
}

export class PgBudgetRepository {
  constructor(private readonly conn: PgConnection) {}

  async reserve(
    payer: string | null,
    amountAtomic: string,
    limits: BudgetLimits,
    now: number,
  ): Promise<BudgetDecision> {
    return this.conn.tx(async (tx) => {
      await tx.serialise(BUDGET_LOCK_KEY);

      const global = await this.readRow(tx, GLOBAL_BUDGET_KEY, now, limits.windowMs);
      const globalLive = await this.liveSessions(tx, null);

      // The global half is decided first so a refusal here never creates or
      // rolls a payer row; the payer rows are read only once it admits.
      let decision = decideBudget({ global, globalLive, payer: null }, amountAtomic, limits, now);
      if (decision.ok && payer) {
        decision = decideBudget(
          {
            global,
            globalLive,
            payer: {
              row: await this.readRow(tx, payerBudgetKey(payer), now, limits.windowMs),
              live: await this.liveSessions(tx, payer),
            },
          },
          amountAtomic,
          limits,
          now,
        );
      }
      if (!decision.ok) return decision;

      await tx.query(
        "UPDATE payer_budgets SET creates = creates + 1, updated_at = $1 WHERE budget_key = $2",
        [now, GLOBAL_BUDGET_KEY],
      );
      if (payer) {
        await tx.query(
          "UPDATE payer_budgets SET creates = creates + 1, updated_at = $1 WHERE budget_key = $2",
          [now, payerBudgetKey(payer)],
        );
      }

      return decision;
    });
  }

  /**
   * Commit settled spend to the verified payer. Runs inside
   * `completeEntitlement`'s transaction; the row lock is what keeps two
   * settlements on the same payer from overwriting each other's total.
   */
  async recordSpend(
    tx: Tx,
    payer: string,
    amountAtomic: string,
    now: number,
    windowMs: number,
  ): Promise<void> {
    if (!payer) return;
    const key = payerBudgetKey(payer);
    await tx.query(
      `INSERT INTO payer_budgets (budget_key, window_start_ms, creates, spend, updated_at)
       VALUES ($1, $2, 0, '0', $2) ON CONFLICT (budget_key) DO NOTHING`,
      [key, now],
    );
    const locked = await tx.query<BudgetRow>(
      "SELECT window_start_ms, creates, spend FROM payer_budgets WHERE budget_key = $1 FOR UPDATE",
      [key],
    );
    const row = locked.rows[0];
    if (!row) return;
    const roll = now - row.window_start_ms >= windowMs;
    const spend = roll ? BigInt(amountAtomic) : BigInt(row.spend) + BigInt(amountAtomic);
    await tx.query(
      `UPDATE payer_budgets
          SET window_start_ms = CASE WHEN $1 THEN $2 ELSE window_start_ms END,
              creates = CASE WHEN $1 THEN 0 ELSE creates END,
              spend = $3, updated_at = $2
        WHERE budget_key = $4`,
      [roll, now, spend.toString(), key],
    );
  }

  /**
   * Live sessions for one budget subject. The subject decides the namespace:
   * `allow:` counts free sessions for that address, a bare address counts paid
   * ones, so the two rows cannot exhaust each other (ADR 0013).
   */
  private async liveSessions(tx: Tx, subject: string | null): Promise<number> {
    if (!subject) {
      const all = await tx.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM sessions WHERE state IN (${NON_TERMINAL_STATE_SQL})`,
      );
      return Number(all.rows[0]?.n ?? 0);
    }
    const { payer, source } = budgetSubject(subject);
    const res = await tx.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sessions s
         JOIN payment_ledger l ON l.session_id = s.id
        WHERE lower(l.payer) = $1 AND l.source = $2
          AND s.state IN (${NON_TERMINAL_STATE_SQL})`,
      [payer, source],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /**
   * Read one budget row, rolling the fixed window forward if it expired. The
   * roll is written immediately: the reservation below depends on the rolled
   * values, and the advisory lock means no other reservation is mid-flight.
   */
  private async readRow(
    tx: Tx,
    key: string,
    now: number,
    windowMs: number,
  ): Promise<{ windowStartMs: number; creates: number; spend: string }> {
    await tx.query(
      `INSERT INTO payer_budgets (budget_key, window_start_ms, creates, spend, updated_at)
       VALUES ($1, $2, 0, '0', $2) ON CONFLICT (budget_key) DO NOTHING`,
      [key, now],
    );
    const res = await tx.query<BudgetRow>(
      "SELECT window_start_ms, creates, spend FROM payer_budgets WHERE budget_key = $1",
      [key],
    );
    const raw = res.rows[0];
    if (!raw) return { windowStartMs: now, creates: 0, spend: "0" };
    if (now - raw.window_start_ms >= windowMs) {
      await tx.query(
        `UPDATE payer_budgets SET window_start_ms = $1, creates = 0, spend = '0', updated_at = $1
          WHERE budget_key = $2`,
        [now, key],
      );
      return { windowStartMs: now, creates: 0, spend: "0" };
    }
    return { windowStartMs: raw.window_start_ms, creates: raw.creates, spend: raw.spend };
  }
}
