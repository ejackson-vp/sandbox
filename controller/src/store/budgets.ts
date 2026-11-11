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
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";

/** The constant key of the global budget row. */
export const GLOBAL_BUDGET_KEY = "global";

export function payerBudgetKey(payer: string): string {
  return `payer:${payer.toLowerCase()}`;
}

export interface BudgetLimits {
  windowMs: number;
  payerCreates: number;
  /** Atomic units of the asset (USDC has 6 decimals). */
  payerSpend: string;
  payerConcurrent: number;
  globalCreates: number;
  globalConcurrent: number;
}

export type BudgetScope =
  | "payer_create"
  | "payer_spend"
  | "payer_concurrent"
  | "global_create"
  | "global_concurrent"
  | "table";

export interface BudgetRemaining {
  /** Creates left for this payer in the window (null when no payer was given). */
  payerCreates: number | null;
  /** Atomic units left to spend in the window. */
  payerSpend: string | null;
  /** Concurrent sessions this payer may still open; null = unlimited. */
  payerConcurrent: number | null;
  /** Creates left globally in the window. */
  globalCreates: number;
  /** Concurrent sessions cluster-wide; null = unlimited. */
  globalConcurrent: number | null;
}

export type BudgetDecision =
  | { ok: true; remaining: BudgetRemaining; windowResetsAt: number }
  | {
      ok: false;
      scope: BudgetScope;
      retryAfterSeconds: number;
      remaining: BudgetRemaining;
      windowResetsAt: number;
    };

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
    const amount = BigInt(amountAtomic);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const windowResetsAt = (start: number) => start + limits.windowMs;

      // ---- global ----
      const global = this.readRow(GLOBAL_BUDGET_KEY, now, limits.windowMs);
      const globalLive = this.liveSessions(null);
      const globalBase: BudgetRemaining = {
        payerCreates: null,
        payerSpend: null,
        payerConcurrent: null,
        globalCreates: Math.max(0, limits.globalCreates - global.creates),
        globalConcurrent:
          limits.globalConcurrent > 0 ? Math.max(0, limits.globalConcurrent - globalLive) : null,
      };
      if (global.creates >= limits.globalCreates) {
        this.db.exec("COMMIT");
        return this.reject("global_create", global.windowStartMs, limits, globalBase, now);
      }
      if (limits.globalConcurrent > 0 && globalLive >= limits.globalConcurrent) {
        this.db.exec("COMMIT");
        return this.reject("global_concurrent", global.windowStartMs, limits, globalBase, now);
      }

      // ---- payer ----
      let payerRow: { windowStartMs: number; creates: number; spend: bigint } | null = null;
      let payerLive = 0;
      if (payer) {
        const key = payerBudgetKey(payer);
        const row = this.readRow(key, now, limits.windowMs);
        payerRow = { windowStartMs: row.windowStartMs, creates: row.creates, spend: BigInt(row.spend) };
        payerLive = this.liveSessions(payer);
        const payerBase: BudgetRemaining = {
          ...globalBase,
          payerCreates: Math.max(0, limits.payerCreates - payerRow.creates),
          payerSpend: (BigInt(limits.payerSpend) - payerRow.spend).toString(),
          payerConcurrent:
            limits.payerConcurrent > 0 ? Math.max(0, limits.payerConcurrent - payerLive) : null,
        };
        if (payerRow.creates >= limits.payerCreates) {
          this.db.exec("COMMIT");
          return this.reject("payer_create", payerRow.windowStartMs, limits, payerBase, now);
        }
        if (payerRow.spend + amount > BigInt(limits.payerSpend)) {
          this.db.exec("COMMIT");
          return this.reject("payer_spend", payerRow.windowStartMs, limits, payerBase, now);
        }
        if (limits.payerConcurrent > 0 && payerLive >= limits.payerConcurrent) {
          this.db.exec("COMMIT");
          return this.reject("payer_concurrent", payerRow.windowStartMs, limits, payerBase, now);
        }
      }

      // ---- commit the reservation ----
      this.stmts.bumpBudgetCreate!.run(now, GLOBAL_BUDGET_KEY);
      if (payer) this.stmts.bumpBudgetCreate!.run(now, payerBudgetKey(payer));
      this.db.exec("COMMIT");

      return {
        ok: true,
        windowResetsAt: windowResetsAt(global.windowStartMs),
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
      // Never 0: a Retry-After of 0 invites an immediate retry storm.
      retryAfterSeconds: Math.max(1, Math.ceil((resetsAt - now) / 1000)),
      remaining,
      windowResetsAt: resetsAt,
    };
  }

}
