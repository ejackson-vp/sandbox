import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { runBounded } from "../../controller/src/bounded-queue.js";

describe("bounded fan-out properties", () => {
  it("runs every item exactly once and never exceeds the concurrency bound", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 1_000 }), { maxLength: 40 }),
        fc.integer({ min: 1, max: 16 }),
        async (items, concurrency) => {
          const seen: number[] = [];
          let active = 0;
          let peak = 0;
          await runBounded(
            items,
            async (item) => {
              active += 1;
              peak = Math.max(peak, active);
              // Force an actual interleaving point between the bound check and
              // completion, so a broken bound is visible rather than incidental.
              await Promise.resolve();
              active -= 1;
              seen.push(item);
            },
            { concurrency },
          );
          expect(seen).toHaveLength(items.length);
          expect(peak).toBeLessThanOrEqual(concurrency);
          expect([...seen].sort((a, b) => a - b)).toEqual([...items].sort((a, b) => a - b));
        },
      ),
      { numRuns: 200 },
    );
  });

  it("reports queue depth and wait through the start hook", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer(), { maxLength: 40 }), async (items) => {
        let clock = 0;
        const waits: number[] = [];
        const depths: number[] = [];
        await runBounded(
          items,
          async () => {
            clock += 1;
          },
          {
            concurrency: 4,
            now: () => clock,
            onStart: (waitMs, depth) => {
              waits.push(waitMs);
              depths.push(depth);
            },
          },
        );
        expect(waits).toHaveLength(items.length);
        expect(depths).toHaveLength(items.length);
        // Depth is what remains behind the item being started, never negative.
        for (const depth of depths) expect(depth).toBeGreaterThanOrEqual(0);
        for (const wait of waits) expect(wait).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 100 },
    );
  });
});
