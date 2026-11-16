/**
 * The one backoff, and the two properties a retry loop depends on.
 *
 * 1. **Bounded.** A delay is never negative and never past the ceiling. A loop
 *    that budgeted five seconds must not be handed a minute because a random
 *    source misbehaved.
 * 2. **Jittered.** The default sample moves across the whole window, which is
 *    what stops every replica, worker and guest waking on the same schedule
 *    after the dependency they share comes back.
 *
 * The source is injected everywhere, so these assertions are exact rather than
 * statistical and no test depends on the process-wide random sequence.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { backoffCeiling, backoffMs, retryAfterMs } from "@x402s/shared/runtime";

const policy = { baseDelayMs: 100, maxDelayMs: 5_000 };

/** A source that walks the range in `steps` evenly spaced samples. */
function sequence(steps: number): () => number {
  let i = 0;
  return () => {
    const value = i / steps;
    i += 1;
    return value;
  };
}

describe("backoff ceiling", () => {
  it("doubles from the base and clamps at the cap", () => {
    expect(backoffCeiling(policy, 0)).toBe(100);
    expect(backoffCeiling(policy, 1)).toBe(200);
    expect(backoffCeiling(policy, 2)).toBe(400);
    expect(backoffCeiling(policy, 5)).toBe(3_200);
    expect(backoffCeiling(policy, 6)).toBe(5_000);
    expect(backoffCeiling(policy, 60)).toBe(5_000);
  });

  it("treats a negative or fractional attempt count as the first retry", () => {
    expect(backoffCeiling(policy, -1)).toBe(100);
    expect(backoffCeiling(policy, 0.9)).toBe(100);
  });

  it("does not overflow at an absurd attempt count", () => {
    const delay = backoffCeiling(policy, 1_024);
    expect(delay).toBe(5_000);
    expect(Number.isSafeInteger(delay)).toBe(true);
  });
});

describe("backoff sample", () => {
  it("stays inside [0, ceiling] for every sample of the range", () => {
    const random = sequence(100);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const ceiling = backoffCeiling(policy, attempt);
      for (let i = 0; i < 100; i += 1) {
        const delay = backoffMs(policy, attempt, { random });
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(ceiling);
        expect(delay).toBeLessThanOrEqual(policy.maxDelayMs);
      }
    }
  });

  it("spreads the same attempt across the whole window", () => {
    // The defect this replaces: an unjittered loop returns one value, so every
    // caller that failed at the same time retries at the same time.
    const seen = new Set<number>();
    const random = sequence(7);
    for (let i = 0; i < 8; i += 1) seen.add(backoffMs(policy, 3, { random }));
    expect(seen.size).toBe(8);
    expect(Math.min(...seen)).toBe(0);
    expect(Math.max(...seen)).toBe(backoffCeiling(policy, 3));
  });

  it("pins the ceiling without jitter, and the bounds with it", () => {
    expect(backoffMs(policy, 3, { jitter: false })).toBe(800);
    expect(backoffMs(policy, 3, { random: () => 1 })).toBe(800);
    expect(backoffMs(policy, 3, { random: () => 0 })).toBe(0);
    expect(backoffMs(policy, 3, { random: () => 0.5 })).toBe(400);
  });

  it("clamps a random source that misbehaves", () => {
    expect(backoffMs(policy, 3, { random: () => Number.NaN })).toBe(0);
    expect(backoffMs(policy, 3, { random: () => 9 })).toBe(800);
    expect(backoffMs(policy, 3, { random: () => -9 })).toBe(0);
  });

  it("is a safe integer for any policy and any attempt count", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (baseDelayMs, cap, attempt, sample) => {
          const shape = { baseDelayMs, maxDelayMs: Math.max(cap, baseDelayMs) };
          const ceiling = backoffCeiling(shape, attempt);
          const delay = backoffMs(shape, attempt, { random: () => sample });
          expect(ceiling).toBeLessThanOrEqual(shape.maxDelayMs);
          expect(delay).toBeGreaterThanOrEqual(0);
          expect(delay).toBeLessThanOrEqual(ceiling);
          expect(Number.isSafeInteger(delay)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("Retry-After", () => {
  it("reads delta-seconds, which is what the API sends", () => {
    expect(retryAfterMs("1")).toBe(1_000);
    expect(retryAfterMs("30")).toBe(30_000);
    expect(retryAfterMs(" 2 ")).toBe(2_000);
    expect(retryAfterMs("0")).toBe(0);
  });

  it("reads an HTTP-date relative to now", () => {
    const now = Date.parse("2026-11-16T10:00:00Z");
    expect(retryAfterMs("Mon, 16 Nov 2026 10:00:05 GMT", now)).toBe(5_000);
    // A date in the past means "now", never a negative wait.
    expect(retryAfterMs("Mon, 16 Nov 2026 09:59:00 GMT", now)).toBe(0);
  });

  it("returns undefined when the header says nothing usable", () => {
    expect(retryAfterMs(undefined)).toBeUndefined();
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs("")).toBeUndefined();
    expect(retryAfterMs("soon")).toBeUndefined();
    expect(retryAfterMs("-5")).toBeUndefined();
    expect(retryAfterMs("1.5")).toBeUndefined();
    expect(retryAfterMs("9".repeat(40))).toBeUndefined();
  });
});
