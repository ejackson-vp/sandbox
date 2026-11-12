/**
 * Durable per-payer and global create budgets (#48).
 *
 * The API's token buckets are the first line, but they are in memory: a restart
 * refills every bucket, and the per-payer key is self-asserted (F-09), so a
 * client can rotate the EIP-3009 `from` field to reach a fresh bucket. This
 * store is the durable backstop:
 *
 *   - a fixed window per payer key (creates, committed spend) that survives a
 *     restart and a leadership change;
 *   - a global window keyed on the constant `global`, which no client-chosen
 *     field can influence, and a global concurrent-session cap;
 *   - per-payer concurrency, read from the live session rows rather than
 *     maintained as a counter, so a crash cannot leak a slot.
 *
 * Two rules keep the accounting honest:
 *
 *   - a reservation counts a *create attempt* and never a payment. Spend is
 *     committed only in the same transaction that writes the ledger
 *     (`completeEntitlement`), so a failed settlement cannot lock a payer out;
 *   - every write happens inside one `BEGIN IMMEDIATE` on the single-writer
 *     connection, with the same guarded-write discipline as the rest of the
 *     store.
 *
 * This file owns the rows, the transaction and the writes. The decision itself
 * is `decideBudget` in `budget-decision.ts`, shared with the Postgres adapter.
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { decideBudget, type BudgetDecision, type BudgetLimits } from "./budget-decision.js";

export type {
  BudgetDecision,
  BudgetLimits,
  BudgetRemaining,
  BudgetScope,
} from "./budget-decision.js";

/** The constant key of the global budget row. */
export const GLOBAL_BUDGET_KEY = "global";

export function payerBudgetKey(payer: string): string {
  return `payer:${payer.toLowerCase()}`;
}

interface BudgetRow {
  budget_key: string;
  window_start_ms: number;
  creates: number;
  spend: string;
  updated_at: number;
}

export class BudgetRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly stmts: Record<string, StatementSync>,
  ) {}

  /**
   * Reserve one create for `payer` (optional) and one globally, atomically.
   *
   * Rejection is all-or-nothing: a refused global budget never leaves a payer
   * increment behind, and a refused payer budget never consumes global budget.
   */
  reserve(
    payer: string | null,
    amountAtomic: string,
    limits: BudgetLimits,
    now: number,
  ): BudgetDecision {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const global = this.readRow(GLOBAL_BUDGET_KEY, now, limits.windowMs);
      const globalLive = this.liveSessions(null);

      // The global half is decided first so a refusal here never creates or
      // rolls a payer row; the payer rows are read only once it admits.
      let decision = decideBudget({ global, globalLive, payer: null }, amountAtomic, limits, now);
      if (decision.ok && payer) {
        decision = decideBudget(
          {
            global,
            globalLive,
            payer: {
              row: this.readRow(payerBudgetKey(payer), now, limits.windowMs),
              live: this.liveSessions(payer),
            },
          },
          amountAtomic,
          limits,
          now,
        );
      }
      if (!decision.ok) {
        this.db.exec("COMMIT");
        return decision;
      }

      this.stmts.bumpBudgetCreate!.run(now, GLOBAL_BUDGET_KEY);
      if (payer) this.stmts.bumpBudgetCreate!.run(now, payerBudgetKey(payer));
      this.db.exec("COMMIT");

      return decision;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Commit settled spend to the verified payer. Called from inside
   * `completeEntitlement`'s transaction, so it must never open its own.
   */
  recordSpendWithinTransaction(payer: string, amountAtomic: string, now: number, windowMs: number): void {
    if (!payer) return;
    const key = payerBudgetKey(payer);
    const row = this.readRow(key, now, windowMs);
    const spend = (BigInt(row.spend) + BigInt(amountAtomic)).toString();
    this.stmts.setBudgetSpend!.run(spend, now, key);
  }

  /**
   * Non-terminal sessions owned by `payer` (or all of them for `null`). Read
   * from the rows, not a counter: a crash must not leak a concurrency slot.
   */
  private liveSessions(payer: string | null): number {
    if (payer === null) {
      return (this.stmts.countLiveSessions!.get() as { n: number } | undefined)?.n ?? 0;
    }
    return (
      (this.stmts.countLiveSessionsForPayer!.get(payer.toLowerCase()) as { n: number } | undefined)?.n ?? 0
    );
  }

  /**
   * Read one budget row, rolling the fixed window forward if it expired. The
   * roll is written immediately: an expired window is a real state, and the
   * reservation below depends on the rolled values.
   */
  private readRow(key: string, now: number, windowMs: number): {
    windowStartMs: number;
    creates: number;
    spend: string;
  } {
    const raw = this.stmts.getBudget!.get(key) as BudgetRow | undefined;
    if (!raw) {
      this.stmts.insertBudgetRow!.run(key, now, now);
      return { windowStartMs: now, creates: 0, spend: "0" };
    }
    if (now - raw.window_start_ms >= windowMs) {
      this.stmts.resetBudgetWindow!.run(now, now, key, now - windowMs);
      return { windowStartMs: now, creates: 0, spend: "0" };
    }
    return { windowStartMs: raw.window_start_ms, creates: raw.creates, spend: raw.spend };
  }

}
