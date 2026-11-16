/**
 * The waits the client uses.
 *
 * Three loops used to own their own copy of "wait a little, ask again", each
 * with a stepped interval and none of them looking at what the server said. They
 * are the create/ready wait, the destroy wait and the operation poll. `pollUntil`
 * is that loop, once, with three things the copies did not have:
 *
 *  - **One pace.** `fastMs` while the answer is likely to change soon,
 *    `slowMs` after `fastPolls` attempts, so a long wait stops hammering a
 *    read endpoint without making a short one feel slow.
 *  - **Jitter.** The interval is sampled (equal jitter: never zero, because a
 *    zero-length poll is a hot loop), so clients started together do not stay
 *    together against the same API replica.
 *  - **`Retry-After`.** A `429 rate_limited` is a wait the server asked for, not
 *    a failure. Until this existed the client retried a rate-limited call at its
 *    own 75/100/200/250ms cadence, faster than the server told it to, and the
 *    limiter stayed full.
 *
 * The poll decides what is worth retrying: anything it throws that is not a
 * `rate_limited` refusal is the caller's answer.
 */
import { SandboxError } from "./types.js";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface PollPlan {
  /** Interval while the fast budget lasts. */
  readonly fastMs: number;
  /** Interval after it: the far end of a long wait. */
  readonly slowMs: number;
  /** How many polls run at the fast pace before the slow one takes over. */
  readonly fastPolls: number;
  /** Uniform source for the interval jitter. Defaults to `Math.random`. */
  readonly random?: () => number;
}

/**
 * Delay before another poll: the interval, jittered, or the wait the server
 * asked for if that is longer.
 *
 * Equal jitter (`step/2 + random * step/2`) rather than full: a poll that waited
 * zero would turn the loop into a request burst against the same endpoint.
 */
export function pollDelayMs(
  stepMs: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  const half = Math.max(0, stepMs) / 2;
  const sample = random();
  const unit = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
  const jittered = Math.floor(half + half * unit);
  const asked =
    retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? Math.ceil(retryAfterMs)
      : 0;
  return Math.max(jittered, asked);
}

/**
 * Poll `poll` until it answers, the deadline passes, or it throws something that
 * is not a rate limit.
 *
 * `poll` returns the value to stop on, or `undefined` to ask again. A thrown
 * `rate_limited` keeps the loop going and sets the floor for the next wait.
 */
export async function pollUntil<T>(
  deadline: number,
  poll: () => Promise<T | undefined> | T | undefined,
  plan: PollPlan,
): Promise<T | undefined> {
  let polls = 0;
  while (Date.now() < deadline) {
    let asked: number | undefined;
    try {
      const value = await poll();
      if (value !== undefined) return value;
    } catch (err) {
      // A refusal the server asked us to wait out is still a wait. Everything
      // else is the answer: the poll has already decided what is retryable.
      if (!(err instanceof SandboxError) || err.code !== "rate_limited") throw err;
      asked = err.retryAfterMs;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const step = polls < plan.fastPolls ? plan.fastMs : plan.slowMs;
    polls += 1;
    await sleep(Math.min(remaining, pollDelayMs(step, asked, plan.random)));
  }
  return undefined;
}
