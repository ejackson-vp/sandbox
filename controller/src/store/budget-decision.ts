/**
 * The durable create-budget decision, shared by the SQLite and Postgres
 * adapters (#48).
 *
 * Pure: no SQL, no clock, no I/O. The adapter reads the rows it needs, hands
 * them here with `now`, then persists the outcome. The refusal codes, the order
 * they are checked in (global before payer) and the remaining-budget arithmetic
 * therefore exist once instead of once per adapter.
 *
 * The payer half of the snapshot is allowed to be absent because of read order:
 * a create refused on the global budget must not create or roll a payer row, so
 * an adapter decides the global half first and reads the payer rows only when
 * that admits. Calling again with the payer half filled in is the same decision
 * the single call would have made.
 */

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

/** One `payer_budgets` row, after its fixed window has been rolled forward. */
export interface BudgetRowSnapshot {
  windowStartMs: number;
  creates: number;
  /** Atomic units committed in the window. */
  spend: string;
}

export interface BudgetSnapshot {
  /** The constant `global` row. */
  global: BudgetRowSnapshot;
  /** Non-terminal sessions cluster-wide. */
  globalLive: number;
  /**
   * The payer's row and its live session count, or null when this create has
   * no payer. Null also means "not read yet"; a refusal produced with the payer
   * half absent can only be a global one.
   */
  payer: { row: BudgetRowSnapshot; live: number } | null;
}

/**
 * Decide one create against the global budget and, when present, the payer's.
 *
 * All-or-nothing: a caller that gets `ok: true` writes both increments, and a
 * caller that gets a refusal writes nothing. The remaining figures in a refusal
 * are the ones the API reports in its 429, so they are computed before the
 * refusal is returned and left untouched by it.
 */
export function decideBudget(
  snapshot: BudgetSnapshot,
  amountAtomic: string,
  limits: BudgetLimits,
  now: number,
): BudgetDecision {
  const amount = BigInt(amountAtomic);
  const global = snapshot.global;
  const globalBase: BudgetRemaining = {
    payerCreates: null,
    payerSpend: null,
    payerConcurrent: null,
    globalCreates: Math.max(0, limits.globalCreates - global.creates),
    globalConcurrent:
      limits.globalConcurrent > 0 ? Math.max(0, limits.globalConcurrent - snapshot.globalLive) : null,
  };
  if (global.creates >= limits.globalCreates) {
    return reject("global_create", global.windowStartMs, limits, globalBase, now);
  }
  if (limits.globalConcurrent > 0 && snapshot.globalLive >= limits.globalConcurrent) {
    return reject("global_concurrent", global.windowStartMs, limits, globalBase, now);
  }

  const payer = snapshot.payer;
  if (payer) {
    const payerBase: BudgetRemaining = {
      ...globalBase,
      payerCreates: Math.max(0, limits.payerCreates - payer.row.creates),
      payerSpend: (BigInt(limits.payerSpend) - BigInt(payer.row.spend)).toString(),
      payerConcurrent:
        limits.payerConcurrent > 0 ? Math.max(0, limits.payerConcurrent - payer.live) : null,
    };
    if (payer.row.creates >= limits.payerCreates) {
      return reject("payer_create", payer.row.windowStartMs, limits, payerBase, now);
    }
    if (BigInt(payer.row.spend) + amount > BigInt(limits.payerSpend)) {
      return reject("payer_spend", payer.row.windowStartMs, limits, payerBase, now);
    }
    if (limits.payerConcurrent > 0 && payer.live >= limits.payerConcurrent) {
      return reject("payer_concurrent", payer.row.windowStartMs, limits, payerBase, now);
    }
  }

  return {
    ok: true,
    windowResetsAt: global.windowStartMs + limits.windowMs,
    remaining: {
      payerCreates: payer ? Math.max(0, limits.payerCreates - payer.row.creates - 1) : null,
      payerSpend: payer ? (BigInt(limits.payerSpend) - BigInt(payer.row.spend)).toString() : null,
      payerConcurrent:
        payer && limits.payerConcurrent > 0
          ? Math.max(0, limits.payerConcurrent - payer.live)
          : null,
      globalCreates: Math.max(0, limits.globalCreates - global.creates - 1),
      globalConcurrent:
        limits.globalConcurrent > 0 ? Math.max(0, limits.globalConcurrent - snapshot.globalLive) : null,
    },
  };
}

function reject(
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
