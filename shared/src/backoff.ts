/**
 * How long to wait before trying again: exponential from a base delay, with a
 * ceiling and full jitter.
 *
 * The arithmetic is trivial; the randomness is the point. Every retry loop in
 * this repository computed `base * 2 ** n` and none of them added a jitter term,
 * so one dependency restart put every retryer on the same schedule:
 *
 *  - a Postgres restart makes both controller retry budgets and every API
 *    replica's start-up retry wake up in phase, in waves, against a database
 *    that is still coming up;
 *  - a relay restart drops every guest on the shard at the same instant, and
 *    identical 250 ms doublings send the whole shard back in one thundering
 *    herd.
 *
 * Full jitter (uniform over `[0, min(cap, base * 2 ** n)]`) spreads those wake
 * ups over the whole window, which is what turns "one herd per wave" into "a
 * smooth arrival rate the recovering dependency can serve".
 *
 * Two things are deliberately kept separate:
 *
 *  - `backoffCeiling` is the deterministic closed form. It is what a caller
 *    reads when it needs the bound, and what a test asserts against.
 *  - `backoffMs` samples it. The sample is drawn from an injected source, never
 *    from seeded global state, so a timing test stays deterministic without
 *    making the process-wide random sequence part of the assertion.
 *
 * Nothing here reads a clock or a global: the caller owns the wait.
 */

/** The two numbers every backoff needs. `RetryPolicy` satisfies this. */
export interface BackoffPolicy {
  /** Delay before the first retry. */
  readonly baseDelayMs: number;
  /** Ceiling on the delay, so a persistent failure does not retry for a day. */
  readonly maxDelayMs: number;
}

export interface BackoffOptions {
  /**
   * Full jitter, on by default. `false` returns the ceiling itself, which is
   * what a test (or a loop that must not smear its wake ups) asks for.
   */
  readonly jitter?: boolean;
  /**
   * Uniform source over `[0, 1]`. Defaults to `Math.random`.
   *
   * Injected rather than seeded: `() => 1` pins the ceiling and `() => 0` pins
   * zero, so two tests in one process cannot interfere through a shared
   * sequence.
   */
  readonly random?: () => number;
}

/**
 * The un-jittered delay: `min(maxDelayMs, baseDelayMs * 2 ** attemptsSoFar)`.
 *
 * `attemptsSoFar` is the number of refusals already recorded, so 0 means the
 * first retry and waits exactly the base delay. `2 ** n` overflows to Infinity
 * long before the ceiling matters; the clamp keeps the result a safe integer
 * for any attempt count.
 */
export function backoffCeiling(policy: BackoffPolicy, attemptsSoFar: number): number {
  const exponent = Math.max(0, Math.floor(attemptsSoFar));
  const delay = policy.baseDelayMs * 2 ** exponent;
  return Number.isFinite(delay) ? Math.min(policy.maxDelayMs, delay) : policy.maxDelayMs;
}

/**
 * Delay before the next attempt, sampled from `[0, ceiling]`.
 *
 * The sample is floored so the result stays an integer number of milliseconds
 * and never exceeds the ceiling. A source that returns something absurd (NaN,
 * 1.5, -3) is clamped rather than trusted: a retry loop must not be talked into
 * a negative or unbounded sleep by its own random source.
 */
export function backoffMs(
  policy: BackoffPolicy,
  attemptsSoFar: number,
  options: BackoffOptions = {},
): number {
  const ceiling = backoffCeiling(policy, attemptsSoFar);
  if (options.jitter === false) return ceiling;
  const sample = (options.random ?? Math.random)();
  const unit = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
  return Math.min(ceiling, Math.floor(ceiling * unit));
}

/**
 * How long a server asked us to wait, from a `Retry-After` header.
 *
 * Accepts delta-seconds (the form the API and the relay send) and an HTTP-date.
 * An absent, empty or unparseable value returns `undefined`, so the caller
 * falls back to its own backoff instead of inventing a wait or waiting zero.
 */
export function retryAfterMs(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) {
    const wait = Number(raw) * 1000;
    return Number.isSafeInteger(wait) ? wait : undefined;
  }
  // An HTTP-date always has a space in it (IMF-fixdate, RFC 850 and asctime
  // alike). Requiring one keeps `Date.parse` from reading a stray number or a
  // bare year as a date and producing a wait nobody asked for.
  if (!/\s/.test(raw)) return undefined;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}
