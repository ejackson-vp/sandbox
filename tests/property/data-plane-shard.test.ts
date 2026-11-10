import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { dataPlaneShard } from "../../controller/src/data-plane-shard.js";

/**
 * Placement is the correctness contract at N>1: every replica and the
 * controller must agree on a session's owner without talking to each other.
 * These properties are what make that safe.
 */
describe("data-plane shard placement", () => {
  it("is a pure function of the session id", () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1, max: 64 }), (sessionId, replicas) => {
        expect(dataPlaneShard(sessionId, replicas)).toBe(dataPlaneShard(sessionId, replicas));
      }),
      { numRuns: 300 },
    );
  });

  it("always returns an index inside [0, replicas)", () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1, max: 64 }), (sessionId, replicas) => {
        const shard = dataPlaneShard(sessionId, replicas);
        expect(Number.isInteger(shard)).toBe(true);
        expect(shard).toBeGreaterThanOrEqual(0);
        expect(shard).toBeLessThan(replicas);
      }),
      { numRuns: 500 },
    );
  });

  it("returns 0 for a single replica, whatever the id", () => {
    fc.assert(
      fc.property(fc.string(), (sessionId) => {
        expect(dataPlaneShard(sessionId, 1)).toBe(0);
        expect(dataPlaneShard(sessionId, 0)).toBe(0);
        expect(dataPlaneShard(sessionId, -3)).toBe(0);
      }),
      { numRuns: 300 },
    );
  });

  it("spreads opaque sbx_ ids across every shard", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 8, maxLength: 32 }), {
          minLength: 2_000,
          maxLength: 2_000,
        }),
        (suffixes) => {
          const replicas = 8;
          const counts = new Array<number>(replicas).fill(0);
          for (const suffix of suffixes) {
            counts[dataPlaneShard(`sbx_${suffix}`, replicas)]! += 1;
          }
          // Every shard must receive work. A cheap rolling hash (or a length
          // based one) collapses onto a few buckets here.
          expect(counts.every((count) => count > 0)).toBe(true);
          const mean = suffixes.length / replicas;
          for (const count of counts) {
            expect(count).toBeGreaterThan(mean * 0.5);
            expect(count).toBeLessThan(mean * 1.5);
          }
        },
      ),
      { numRuns: 5 },
    );
  });

  it("stays stable when other sessions are placed in between", () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 2, max: 64 }), (sessionId, replicas) => {
        const shard = dataPlaneShard(sessionId, replicas);
        // Same count is stable even when the call is interleaved with others.
        dataPlaneShard("sbx_other", replicas + 1);
        expect(dataPlaneShard(sessionId, replicas)).toBe(shard);
      }),
      { numRuns: 200 },
    );
  });
});
