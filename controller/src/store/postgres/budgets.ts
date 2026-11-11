/**
 * Durable per-payer and global create budgets, for Postgres (#48).
 *
 * SQLite gets the all-or-nothing reservation from `BEGIN IMMEDIATE`: the global
 * and payer rows cannot be read by a second writer until the first commits. Here
 * a transaction-scoped advisory lock (`BUDGET_LOCK_KEY`) stands in for that,
 * because the concurrency caps are counted from other tables and a row lock on
 * `payer_budgets` cannot make a *count of sessions* stable. Every reservation
 * therefore takes the same lock, then reads, then writes; the second reservation
 * sees the committed counters.
 *
 * Spend is separate: it commits inside `completeEntitlement`'s transaction and
 * takes a `FOR UPDATE` lock on the payer row, which is enough because the only
 * writer that can change `spend` is another settlement.
 */
import { GLOBAL_BUDGET_KEY, payerBudgetKey } from "../budgets.js";
import { NON_TERMINAL_STATE_SQL } from "../models.js";
import { BUDGET_LOCK_KEY, type PgConnection, type Tx } from "./pg.js";

export type {
  BudgetDecision,
  BudgetLimits,
  BudgetRemaining,
  BudgetScope,
} from "../budgets.js";

import type { BudgetDecision, BudgetLimits, BudgetRemaining, BudgetScope } from "../budgets.js";

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
    const amount = BigInt(amountAtomic);
    return this.conn.tx(async (tx) => {
      await tx.serialise(BUDGET_LOCK_KEY);

      const global = await this.readRow(tx, GLOBAL_BUDGET_KEY, now, limits.windowMs);
      const globalLive = await this.liveSessions(tx, null);
      const globalBase: BudgetRemaining = {
        payerCreates: null,
        payerSpend: null,
        payerConcurrent: null,
        globalCreates: Math.max(0, limits.globalCreates - global.creates),
        globalConcurrent:
          limits.globalConcurrent > 0 ? Math.max(0, limits.globalConcurrent - globalLive) : null,
      };
      if (global.creates >= limits.globalCreates) {
        return this.reject("global_create", global.windowStartMs, limits, globalBase, now);
      }
      if (limits.globalConcurrent > 0 && globalLive >= limits.globalConcurrent) {
        return this.reject("global_concurrent", global.windowStartMs, limits, globalBase, now);
      }

      let payerRow: { windowStartMs: number; creates: number; spend: bigint } | null = null;
      let payerLive = 0;
      if (payer) {
        const key = payerBudgetKey(payer);
        const row = await this.readRow(tx, key, now, limits.windowMs);
        payerRow = { windowStartMs: row.windowStartMs, creates: row.creates, spend: BigInt(row.spend) };
        payerLive = await this.liveSessions(tx, payer);
        const payerBase: BudgetRemaining = {
          ...globalBase,
          payerCreates: Math.max(0, limits.payerCreates - row.creates),
          payerSpend: (BigInt(limits.payerSpend) - BigInt(row.spend)).toString(),
          payerConcurrent:
            limits.payerConcurrent > 0 ? Math.max(0, limits.payerConcurrent - payerLive) : null,
        };
        if (row.creates >= limits.payerCreates) {
          return this.reject("payer_create", row.windowStartMs, limits, payerBase, now);
        }
        if (BigInt(row.spend) + amount > BigInt(limits.payerSpend)) {
          return this.reject("payer_spend", row.windowStartMs, limits, payerBase, now);
        }
        if (limits.payerConcurrent > 0 && payerLive >= limits.payerConcurrent) {
          return this.reject("payer_concurrent", row.windowStartMs, limits, payerBase, now);
        }
      }

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

      return {
        ok: true,
        windowResetsAt: global.windowStartMs + limits.windowMs,
        remaining: {
          payerCreates: payerRow ? Math.max(0, limits.payerCreates - payerRow.creates - 1) : null,
          payerSpend: payerRow ? (BigInt(limits.payerSpend) - payerRow.spend).toString() : null,
          payerConcurrent:
            payerRow && limits.payerConcurrent > 0
              ? Math.max(0, limits.payerConcurrent - payerLive)
              : null,
          globalCreates: Math.max(0, limits.globalCreates - global.creates - 1),
          globalConcurrent:
            limits.globalConcurrent > 0 ? Math.max(0, limits.globalConcurrent - globalLive) : null,
        },
      };
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

  private async liveSessions(tx: Tx, payer: string | null): Promise<number> {
    const res = payer
      ? await tx.query<{ n: number }>(
          `SELECT COUNT(*) AS n FROM sessions s
             JOIN payment_ledger l ON l.session_id = s.id
            WHERE lower(l.payer) = $1 AND s.state IN (${NON_TERMINAL_STATE_SQL})`,
          [payer.toLowerCase()],
        )
      : await tx.query<{ n: number }>(
          `SELECT COUNT(*) AS n FROM sessions WHERE state IN (${NON_TERMINAL_STATE_SQL})`,
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

  private reject(
    scope: BudgetScope,
    windowStartMs: number,
    limits: BudgetLimits,
    remaining: BudgetRemaining,
    now: number,
  ): BudgetDecision {
    const resetsAt = windowStartMs + limits.windowMs;
    return {
      ok: false,
      scope,
      retryAfterSeconds: Math.max(1, Math.ceil((resetsAt - now) / 1000)),
      remaining,
      windowResetsAt: resetsAt,
    };
  }
}
