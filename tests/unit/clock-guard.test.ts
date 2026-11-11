/**
 * Wall-clock steps, with an injected clock.
 *
 * There is no way to make `Date.now()` jump in a test without waiting for an
 * operator to run `date -s`, so the clock and its monotonic reference are both
 * injected. Elapsing wall time without elapsing monotonic time is exactly what
 * an NTP step looks like from inside the process.
 */
import { describe, expect, it } from "vitest";
import {
  CLOCK_JUMP_TOLERANCE_MS,
  ClockGuard,
  type ClockJump,
} from "../../controller/src/clock-guard.js";

/** A wall clock and a monotonic clock that move independently. */
function clocks(start = 1_700_000_000_000) {
  let wall = start;
  let mono = 1_000;
  return {
    now: () => wall,
    monotonic: () => mono,
    /** Time passing normally. */
    advance(ms: number) {
      wall += ms;
      mono += ms;
    },
    /** A forward step: the wall clock moves, no time actually elapsed. */
    stepForward(ms: number) {
      wall += ms;
    },
    /** A backward step. */
    stepBackward(ms: number) {
      wall -= ms;
    },
  };
}

function guarded(clock: ReturnType<typeof clocks>, toleranceMs?: number) {
  const jumps: ClockJump[] = [];
  const guard = new ClockGuard({
    now: clock.now,
    monotonic: clock.monotonic,
    ...(toleranceMs !== undefined ? { toleranceMs } : {}),
    onJump: (jump) => jumps.push(jump),
  });
  return { guard, jumps };
}

describe("clock guard", () => {
  it("reports nothing while wall and monotonic time advance together", () => {
    const clock = clocks();
    const { guard, jumps } = guarded(clock);
    guard.now();
    for (let i = 0; i < 100; i += 1) {
      clock.advance(250);
      guard.now();
    }
    expect(jumps).toEqual([]);
    expect(guard.jumpCount).toBe(0);
  });

  it("reports a forward step with old and new readings", () => {
    const clock = clocks();
    const { guard, jumps } = guarded(clock);
    const before = guard.now();
    clock.stepForward(3_600_000); // one hour, the classic NTP correction
    const after = guard.now();

    expect(jumps).toHaveLength(1);
    expect(jumps[0]).toEqual({
      from: before,
      to: after,
      deltaMs: 3_600_000,
      direction: "forward",
    });
    expect(guard.jumpCount).toBe(1);
  });

  it("reports a backward step as backward", () => {
    const clock = clocks();
    const { guard, jumps } = guarded(clock);
    const before = guard.now();
    clock.stepBackward(90_000);
    const after = guard.now();

    expect(jumps).toHaveLength(1);
    expect(jumps[0]).toMatchObject({
      from: before,
      to: after,
      deltaMs: -90_000,
      direction: "backward",
    });
  });

  it("returns the stepped reading, so stored deadlines follow the clock", () => {
    const clock = clocks();
    const { guard } = guarded(clock);
    guard.now();
    clock.stepForward(10_000);
    // The guard reports the step; it does not hide it. Every caller that
    // compares a deadline to `now()` sees the new time.
    expect(guard.now()).toBe(clock.now());
  });

  it("reports a step once, then rebases", () => {
    const clock = clocks();
    const { guard, jumps } = guarded(clock);
    guard.now();
    clock.stepForward(60_000);
    guard.now();
    clock.advance(250);
    guard.now();
    clock.advance(250);
    guard.now();
    expect(jumps).toHaveLength(1);
  });

  it("reports drift below the tolerance as no step", () => {
    const clock = clocks();
    const { guard, jumps } = guarded(clock);
    guard.now();
    // The reconcile loop ticks every 250ms; a few ms of disagreement between
    // the two clocks is a loaded event loop, not a clock step.
    clock.stepForward(CLOCK_JUMP_TOLERANCE_MS - 1);
    guard.now();
    expect(jumps).toEqual([]);
  });

  it("reports two separate steps separately", () => {
    const clock = clocks();
    const { guard, jumps } = guarded(clock);
    guard.now();
    clock.stepForward(30_000);
    guard.now();
    clock.stepBackward(30_000);
    guard.now();
    expect(jumps.map((jump) => jump.direction)).toEqual(["forward", "backward"]);
  });

  it("uses the tolerance it was given", () => {
    const clock = clocks();
    const { guard, jumps } = guarded(clock, 100);
    guard.now();
    clock.stepForward(150);
    guard.now();
    expect(jumps).toHaveLength(1);
  });
});
