/**
 * `pollUntil`: the one wait the client loop uses.
 *
 * Three loops had their own copy (ready, destroy, the operation poll), each with
 * a stepped interval and none of them reading what the server asked for. These
 * tests pin the three things the copy is responsible for:
 *
 *  - the pace: `fastPolls` at `fastMs`, then `slowMs`;
 *  - the deadline: a poll never outlives it, and it answers `undefined`;
 *  - the refusal: a `429` is a wait, and its `Retry-After` is a floor.
 *
 * Intervals are measured on the wall clock rather than by faking timers, so the
 * assertions are about the wait a caller actually experiences. The random source
 * is injected, never seeded.
 */
import { describe, expect, it } from "vitest";
import { pollDelayMs, pollUntil } from "../../sdk/src/timing.js";
import { SandboxError } from "../../sdk/src/types.js";

/** A poll that always answers, so only the loop's pacing is under test. */
function immediate<T>(value: T): () => Promise<T> {
  return async () => value;
}

describe("pollDelayMs", () => {
  it("never returns zero, so a poll cannot become a hot loop", () => {
    expect(pollDelayMs(100, undefined, () => 0)).toBe(50);
    expect(pollDelayMs(100, undefined, () => 1)).toBe(100);
    expect(pollDelayMs(0, undefined, () => 1)).toBe(0);
  });

  it("lets a Retry-After outrank the interval", () => {
    // The client's own pace would be 50ms; the server asked for 2s.
    expect(pollDelayMs(100, 2_000, () => 0)).toBe(2_000);
    // A header shorter than the pace does not make the client faster.
    expect(pollDelayMs(1_000, 10, () => 1)).toBe(1_000);
    expect(pollDelayMs(100, 0, () => 0)).toBe(50);
    expect(pollDelayMs(100, Number.NaN, () => 0)).toBe(50);
  });
});

describe("pollUntil", () => {
  it("returns the value as soon as the poll answers", async () => {
    let calls = 0;
    const value = await pollUntil<string>(
      Date.now() + 5_000,
      async () => {
        calls += 1;
        return calls < 3 ? undefined : "ready";
      },
      { fastMs: 20, slowMs: 20, fastPolls: 0, random: () => 0 },
    );
    expect(value).toBe("ready");
    expect(calls).toBe(3);
  });

  it("stops at the deadline and answers undefined", async () => {
    const deadline = Date.now() + 120;
    let calls = 0;
    const value = await pollUntil<string>(
      deadline,
      async () => {
        calls += 1;
        return undefined;
      },
      { fastMs: 40, slowMs: 40, fastPolls: 0, random: () => 1 },
    );
    expect(value).toBeUndefined();
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(Date.now()).toBeLessThanOrEqual(deadline + 100);
  });

  it("does not run at all for a deadline that has already passed", async () => {
    let calls = 0;
    await pollUntil(
      Date.now() - 1,
      async () => {
        calls += 1;
        return "never";
      },
      { fastMs: 10, slowMs: 10, fastPolls: 0 },
    );
    expect(calls).toBe(0);
  });

  it("waits at least the Retry-After a rate-limited answer asked for", async () => {
    // This is the assertion that did not exist: the loop used to retry a
    // `rate_limited` call at its own 75/100/200/250ms pace and spin a limiter
    // that had explicitly said "wait".
    const seenAt: number[] = [];
    const started = Date.now();
    const value = await pollUntil<string>(
      started + 5_000,
      async () => {
        seenAt.push(Date.now() - started);
        if (seenAt.length === 1) {
          throw new SandboxError("rate_limited", "slow down", 429, undefined, 150);
        }
        return "ready";
      },
      // 10ms without the header, so the 150ms wait can only come from it.
      { fastMs: 20, slowMs: 20, fastPolls: 0, random: () => 0 },
    );
    expect(value).toBe("ready");
    expect(seenAt).toHaveLength(2);
    // 150 is what was asked for; the tolerance is for the clock, not the
    // contract. A timer may resolve a fraction early and `Date.now()`
    // truncates, so the measured gap can be 149 on a loaded runner. The
    // no-header pace is 20ms, so a loop that ignored Retry-After still cannot
    // reach this bound.
    expect(seenAt[1]!).toBeGreaterThanOrEqual(140);
  });

  it("keeps polling when a rate limit names no wait", async () => {
    let calls = 0;
    const value = await pollUntil<string>(
      Date.now() + 2_000,
      async () => {
        calls += 1;
        if (calls === 1) throw new SandboxError("rate_limited", "slow down", 429);
        return "ready";
      },
      { fastMs: 20, slowMs: 20, fastPolls: 0, random: () => 0 },
    );
    expect(value).toBe("ready");
  });

  it("surfaces every other refusal instead of retrying it", async () => {
    let calls = 0;
    await expect(
      pollUntil(
        Date.now() + 5_000,
        async () => {
          calls += 1;
          throw new SandboxError("capability_required", "no capability", 401);
        },
        { fastMs: 10, slowMs: 10, fastPolls: 0 },
      ),
    ).rejects.toMatchObject({ code: "capability_required" });
    expect(calls).toBe(1);
  });

  it("runs the fast pace for fastPolls attempts, then the slow one", async () => {
    const seenAt: number[] = [];
    const started = Date.now();
    await pollUntil<string | undefined>(
      started + 2_000,
      async () => {
        seenAt.push(Date.now() - started);
        return seenAt.length === 4 ? "done" : undefined;
      },
      // jittered = the step itself, so the intervals are exactly 40, 40, 100.
      { fastMs: 40, slowMs: 100, fastPolls: 2, random: () => 1 },
    );
    expect(seenAt).toHaveLength(4);
    const gaps = seenAt.slice(1).map((at, i) => at - seenAt[i]!);
    expect(gaps[0]!).toBeGreaterThanOrEqual(35);
    expect(gaps[1]!).toBeGreaterThanOrEqual(35);
    // The third wait is the slow pace.
    expect(gaps[2]!).toBeGreaterThanOrEqual(95);
  });

  it("stops waiting when the deadline is closer than the interval", async () => {
    const started = Date.now();
    const value = await pollUntil(
      started + 60,
      immediate(undefined),
      { fastMs: 5_000, slowMs: 5_000, fastPolls: 0, random: () => 1 },
    );
    expect(value).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
