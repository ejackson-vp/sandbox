/**
 * Egress byte budget arithmetic.
 *
 * No sockets and no clock: the window rolls on an injected clock, so every case
 * here is exact rather than tolerance-based.
 */
import { describe, expect, it } from "vitest";
import { createEgressBudget, EGRESS_LIMIT_SCOPES } from "../../controller/src/egress-budget.js";

describe("egress byte budget", () => {
  it("charges both directions to one per-session total", () => {
    const budget = createEgressBudget({
      maxBytesPerSession: 100,
      maxBytesGlobal: 1_000,
      windowMs: 1_000,
    });
    expect(budget.charge("s1", 40)).toBeNull();
    expect(budget.charge("s1", 60)).toBeNull();
    expect(budget.totals()).toEqual({ bytes: 100, sessions: 1, windowBytes: 100 });
  });

  it("fills to the limit exactly and refuses the next chunk whole", () => {
    const budget = createEgressBudget({
      maxBytesPerSession: 10,
      maxBytesGlobal: 1_000,
      windowMs: 1_000,
    });
    // A chunk that lands exactly on the bound is accepted.
    expect(budget.charge("s1", 10)).toBeNull();
    expect(budget.charge("s1", 1)).toBe("session");
    // The refused chunk was never written, so it is not egress.
    expect(budget.totals()).toEqual({ bytes: 10, sessions: 1, windowBytes: 10 });
  });

  it("refuses a chunk that would straddle the session bound rather than taking part of it", () => {
    const budget = createEgressBudget({
      maxBytesPerSession: 10,
      maxBytesGlobal: 1_000,
      windowMs: 1_000,
    });
    expect(budget.charge("s1", 6)).toBeNull();
    // 8 more would cross 10 at byte 4. The whole chunk is refused, and none of
    // it is charged.
    expect(budget.charge("s1", 8)).toBe("session");
    expect(budget.totals().bytes).toBe(6);
  });

  it("names the per-session bound before the global one", () => {
    const budget = createEgressBudget({
      maxBytesPerSession: 5,
      maxBytesGlobal: 5,
      windowMs: 1_000,
    });
    expect(budget.charge("s1", 5)).toBeNull();
    expect(budget.charge("s1", 1)).toBe("session");
    expect(budget.charge("s2", 1)).toBe("global");
  });

  it("shares one global window across sessions", () => {
    const budget = createEgressBudget({
      maxBytesPerSession: 1_000,
      maxBytesGlobal: 10,
      windowMs: 1_000,
    });
    expect(budget.charge("s1", 6)).toBeNull();
    expect(budget.charge("s2", 6)).toBe("global");
    // s2 moved no bytes, so it does not get an entry: the map only holds
    // sessions with a total to compare against.
    expect(budget.totals()).toEqual({ bytes: 6, sessions: 1, windowBytes: 6 });
  });

  it("rolls the global window on the clock without resetting a session", () => {
    let clock = 0;
    const budget = createEgressBudget({
      maxBytesPerSession: 10,
      maxBytesGlobal: 10,
      windowMs: 1_000,
      now: () => clock,
    });
    expect(budget.charge("s1", 10)).toBeNull();
    clock = 999;
    expect(budget.charge("s1", 1)).toBe("session");
    clock = 1_000;
    // The window is fresh, but the session total is not: a reconnect inside a
    // window cannot buy a second per-session budget.
    expect(budget.charge("s1", 1)).toBe("session");
    expect(budget.charge("s2", 10)).toBeNull();
    expect(budget.totals()).toEqual({ bytes: 20, sessions: 2, windowBytes: 10 });
  });

  it("treats 0 as no bound", () => {
    const budget = createEgressBudget({
      maxBytesPerSession: 0,
      maxBytesGlobal: 0,
      windowMs: 1_000,
    });
    expect(budget.charge("s1", 10 * 1024 ** 3)).toBeNull();
  });

  it("ignores a non-positive chunk instead of tearing a tunnel down", () => {
    const budget = createEgressBudget({
      maxBytesPerSession: 1,
      maxBytesGlobal: 1,
      windowMs: 1_000,
    });
    expect(budget.charge("s1", 0)).toBeNull();
    expect(budget.totals().bytes).toBe(0);
  });

  it("exports only the scopes the metrics accept", () => {
    expect([...EGRESS_LIMIT_SCOPES]).toEqual(["session", "global"]);
  });
});
