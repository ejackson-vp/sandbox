/**
 * Retry and lease policy for durable external calls (ADR 0011).
 *
 * The policy is data, and every decision is a pure function of it, so the same
 * numbers drive the worker, the claim query and the property tests without the
 * test having to reproduce the arithmetic.
 *
 * Two rules are encoded here rather than left to a caller:
 *
 *  - **Backoff is exponential from the base delay, with a ceiling.** The
 *    exponent is the number of *definitive* refusals already recorded, so the
 *    first retry waits the base delay, the second waits twice that, and so on.
 *  - **The lease must outlive the call timeout.** A lease shorter than the
 *    provider's timeout lets a second pass resend while the first is still
 *    waiting. That is safe only because the key is stable, and it is still
 *    noise, so the relationship is checked instead of assumed.
 */

export interface RetryPolicy {
  /** Definitive refusals before the work is left for an operator. */
  readonly maxAttempts: number;
  /** Delay before the first retry. */
  readonly baseDelayMs: number;
  /** Ceiling on the delay, so a persistent failure does not retry for a day. */
  readonly maxDelayMs: number;
  /** How long one external call may take before it is treated as unknown. */
  readonly callTimeoutMs: number;
  /** How long one pass owns the claim. Must exceed `callTimeoutMs`. */
  readonly leaseMs: number;
}

const DEFAULTS = {
  maxAttempts: 10,
  baseDelayMs: 60_000,
  maxDelayMs: 3_600_000,
  callTimeoutMs: 10_000,
  leaseMs: 60_000,
} as const satisfies RetryPolicy;

export function retryPolicy(overrides: Partial<RetryPolicy> = {}): RetryPolicy {
  const policy: RetryPolicy = { ...DEFAULTS, ...overrides };
  const problems = policyProblems(policy);
  if (problems.length > 0) throw new TypeError(`invalid retry policy: ${problems.join("; ")}`);
  return policy;
}

/** Every way a policy can be unusable. Empty means valid. */
export function policyProblems(policy: RetryPolicy): string[] {
  const problems: string[] = [];
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    problems.push(`maxAttempts must be >= 1, got ${policy.maxAttempts}`);
  }
  if (!Number.isSafeInteger(policy.baseDelayMs) || policy.baseDelayMs < 0) {
    problems.push(`baseDelayMs must be >= 0, got ${policy.baseDelayMs}`);
  }
  if (!Number.isSafeInteger(policy.maxDelayMs) || policy.maxDelayMs < policy.baseDelayMs) {
    problems.push(`maxDelayMs must be >= baseDelayMs, got ${policy.maxDelayMs}`);
  }
  if (!Number.isSafeInteger(policy.callTimeoutMs) || policy.callTimeoutMs <= 0) {
    problems.push(`callTimeoutMs must be > 0, got ${policy.callTimeoutMs}`);
  }
  if (!Number.isSafeInteger(policy.leaseMs) || policy.leaseMs <= 0) {
    problems.push(`leaseMs must be > 0, got ${policy.leaseMs}`);
  }
  return problems;
}

/**
 * Delay before the next attempt, given the definitive refusals recorded so far.
 * Zero refusals means the first retry, which waits the base delay.
 */
export function backoffMs(policy: RetryPolicy, attemptsSoFar: number): number {
  const exponent = Math.max(0, Math.floor(attemptsSoFar));
  // `2 ** exponent` overflows to Infinity long before the ceiling matters; the
  // clamp keeps the result a safe integer for any attempt count.
  const delay = policy.baseDelayMs * 2 ** exponent;
  return Number.isFinite(delay) ? Math.min(policy.maxDelayMs, delay) : policy.maxDelayMs;
}

/** Absolute time the next attempt becomes due. */
export function nextAttemptAtMs(policy: RetryPolicy, attemptsSoFar: number, nowMs: number): number {
  return nowMs + backoffMs(policy, attemptsSoFar);
}

/** True once the recorded refusals reach the limit. */
export function isExhausted(policy: RetryPolicy, attempts: number): boolean {
  return attempts >= policy.maxAttempts;
}

/**
 * Whether the lease is long enough for one call. A short lease is not a
 * correctness bug (the key makes the resend safe) but it is a durability
 * smell, so the worker logs it instead of hiding it.
 */
export function leaseCoversCallTimeout(policy: RetryPolicy): boolean {
  return policy.leaseMs > policy.callTimeoutMs;
}

/**
 * The policy a refund worker runs with. Kept here so the worker constructor
 * stays a thin adapter over configuration and the tests can read the numbers.
 */
export function refundRetryPolicy(overrides: {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  leaseMs?: number;
  callTimeoutMs?: number;
}): RetryPolicy {
  return retryPolicy({
    maxAttempts: overrides.maxAttempts,
    baseDelayMs: overrides.baseDelayMs,
    maxDelayMs: overrides.maxDelayMs ?? DEFAULTS.maxDelayMs,
    leaseMs: overrides.leaseMs ?? DEFAULTS.leaseMs,
    callTimeoutMs: overrides.callTimeoutMs ?? DEFAULTS.callTimeoutMs,
  });
}
