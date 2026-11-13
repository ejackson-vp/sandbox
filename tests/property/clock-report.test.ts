/**
 * What a clock step reports.
 *
 * The clock guard decides that a reading is a step rather than drift, and this
 * module answers the next question an operator asks: which paid sessions did it
 * move? The answer is the sessions whose immutable deadline falls inside the
 * jumped window, because those end early on a forward step and late on a
 * backward step. Everything else in the report is decoration.
 *
 * Two properties matter and neither is obvious from the code:
 *
 *   1. the window is direction-agnostic, so a backward step reports the same
 *      sessions a forward step over the same two instants would;
 *   2. reporting is fire-and-forget by construction. A store that is down must
 *      not fail a reconcile pass, so a read that throws still logs the step.
 */
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportClockJump } from "../../controller/src/reconciler/clock-report.js";
import type { SessionRecord } from "../../controller/src/store/models.js";
import { log } from "@x402s/shared/runtime";
import { limitsFor, sessionFixture } from "../helpers/store-fixtures.js";

function session(id: string, leaseExpiresAt: number | null): SessionRecord {
  return sessionFixture({
    id,
    paymentKey: `payment-${id}`,
    tier: "standard",
    durationSeconds: 300,
    limits: limitsFor("unit"),
    clientPublicKey: "pk".repeat(22),
    clientNonce: "nn".repeat(22),
    overrides: { state: "READY", leaseExpiresAt },
  });
}

function captureWarn() {
  return vi.spyOn(log, "warn").mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a clock step names the sessions whose deadline moved", () => {
  it("reports exactly the deadlines inside the window, in either direction", async () => {
    // One spy for the whole property: fast-check runs the body many times and a
    // spy per run would leak into the next, so the call log is cleared instead.
    const warn = captureWarn();
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1_000_000, max: 2_000_000 }),
        fc.integer({ min: 1_000_000, max: 2_000_000 }),
        fc.array(fc.integer({ min: 0, max: 3_000_000 }), { minLength: 0, maxLength: 12 }),
        async (from, to, offsets) => {
          warn.mockClear();
          const sessions = offsets.map((offset, index) => session(`sbx_clock_${index}`, offset));
          const low = Math.min(from, to);
          const high = Math.max(from, to);
          const expected = sessions
            .filter(
              (record) =>
                record.leaseExpiresAt !== null &&
                record.leaseExpiresAt >= low &&
                record.leaseExpiresAt <= high,
            )
            .map((record) => record.id);

          await reportClockJump(
            { store: { listNonTerminal: async () => sessions }, jumpCount: 3 },
            { from, to, deltaMs: to - from, direction: to >= from ? "forward" : "backward" },
          );

          expect(warn).toHaveBeenCalledTimes(1);
          const fields = warn.mock.calls[0]?.[1] as Record<string, unknown>;
          expect(fields.affectedSessions).toBe(expected.length);
          expect(fields.affectedSessionIds).toEqual(expected.slice(0, 20));
          expect(fields.jumps).toBe(3);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("counts a deadline exactly on either edge of the window", async () => {
    const warn = captureWarn();
    const from = 1_500_000;
    const to = 1_600_000;
    const sessions = [
      session("sbx_before", from - 1),
      session("sbx_low", from),
      session("sbx_middle", (from + to) / 2),
      session("sbx_high", to),
      session("sbx_after", to + 1),
      session("sbx_no_deadline", null),
    ];

    await reportClockJump(
      { store: { listNonTerminal: async () => sessions }, jumpCount: 1 },
      { from, to, deltaMs: to - from, direction: "forward" },
    );

    const fields = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(fields.affectedSessionIds).toEqual(["sbx_low", "sbx_middle", "sbx_high"]);
    expect(fields.affectedSessions).toBe(3);
  });

  it("caps the id list but not the count", async () => {
    const warn = captureWarn();
    const sessions = Array.from({ length: 45 }, (_, index) => session(`sbx_many_${index}`, 1_000_000 + index));

    await reportClockJump(
      { store: { listNonTerminal: async () => sessions }, jumpCount: 1 },
      { from: 1_000_000, to: 2_000_000, deltaMs: 1_000_000, direction: "forward" },
    );

    const fields = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(fields.affectedSessions).toBe(45);
    expect(fields.affectedSessionIds).toHaveLength(20);
  });
});

describe("reporting never fails a reconcile pass", () => {
  it("still logs the step when the store cannot be read", async () => {
    const warn = captureWarn();

    await expect(
      reportClockJump(
        {
          store: {
            listNonTerminal: async () => {
              throw new Error("store unavailable");
            },
          },
          jumpCount: 1,
        },
        { from: 1_000_000, to: 1_100_000, deltaMs: 100_000, direction: "backward" },
      ),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    const fields = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(fields.affectedSessions).toBe(0);
    expect(fields.affectedSessionIds).toEqual([]);
    expect(fields.direction).toBe("backward");
  });

  it("reports a zero-width window as the single instant it is", async () => {
    const warn = captureWarn();
    const instant = 1_234_567;
    const sessions = [session("sbx_exact", instant), session("sbx_other", instant + 1)];

    await reportClockJump(
      { store: { listNonTerminal: async () => sessions }, jumpCount: 1 },
      { from: instant, to: instant, deltaMs: 0, direction: "forward" },
    );

    const fields = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(fields.affectedSessionIds).toEqual(["sbx_exact"]);
  });
});
