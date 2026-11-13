/**
 * Warm-pool allocation: one shared budget, one growth policy, one drain rule.
 *
 * `WarmPoolManager` owns the numbers that decide how many pre-booted pods each
 * runtime profile is allowed to want. `WarmPool` (covered by
 * warm-pool-claims.test.ts) turns a target into creates and deletes. The policy
 * above it is what this file pins, and it is the kind of thing no single example
 * catches:
 *
 *   1. the sum of the per-profile targets never exceeds `WARM_POOL_SIZE`, no
 *      target is negative, and `base` never drops below its configured floor;
 *   2. growth spends free budget first and only then moves a pod from an idle
 *      profile, so a profile that is serving claims is never the victim, and a
 *      0 budget refuses growth outright;
 *   3. a pool gives back at most one pod per drain cooldown, and only once it has
 *      been quiet for the drain grace, so a burst of misses cannot oscillate it;
 *   4. a shrunken budget sheds non-base profiles largest-first and only then
 *      takes `base` down to its floor.
 *
 * The first property drives the whole policy against a reference implementation
 * of the documented rules (the same shape lease-health.test.ts uses for the
 * probe strikes), because the interesting failures are sequences: demand that
 * decays across a window, a cooldown that spans two misses, a drain during
 * another profile's growth.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  AllocationModel,
  BASE,
  DIGEST,
  NODE,
  PYTHON,
  harness,
  shed,
} from "../helpers/warm-pool-harness.js";

describe("allocation follows the documented policy", () => {
  it("matches the reference model over any sequence of claims, passes and time", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.record({
              kind: fc.constant("claim" as const),
              profile: fc.constantFrom(BASE, PYTHON, NODE),
            }),
            fc.record({ kind: fc.constant("reconcile" as const) }),
            fc.record({
              kind: fc.constant("advance" as const),
              ms: fc.integer({ min: 0, max: 90_000 }),
            }),
          ),
          { minLength: 1, maxLength: 10 },
        ),
        async (actions) => {
          const h = harness({ WARM_POOL_SIZE: "5", WARM_POOL_BASE_MIN: "1" });
          const model = new AllocationModel(h.cfg, Object.keys(h.cfg.runtimeProfiles));

          for (const action of actions) {
            if (action.kind === "advance") {
              h.clock.now += action.ms;
              continue;
            }
            if (action.kind === "reconcile") {
              await h.manager.reconcile();
              model.reconcile(h.clock.now);
              // Idle pods never exceed the target: creates are only spent on
              // the missing count, so a pass cannot overshoot.
              for (const profile of model.order) {
                const target = h.targets()[profile]!;
                expect(h.podsFor(profile).length, `${profile} idle`).toBeLessThanOrEqual(target);
              }
            } else {
              const claimed = await h.claim(action.profile);
              model.record(action.profile, claimed ? "hit" : "miss", h.clock.now);
            }

            expect(h.targets()).toEqual(model.targets());
            const targets = Object.values(h.targets());
            expect(targets.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(
              h.cfg.warmPoolSize,
            );
            expect(Math.min(...targets)).toBeGreaterThanOrEqual(0);
            // `base` is the only profile with a floor, and it is never drained
            // below it even while another profile is growing.
            expect(h.targets()[BASE]).toBeGreaterThanOrEqual(
              Math.min(h.cfg.warmPoolBaseMin, h.cfg.warmPoolSize),
            );
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  it("steals from the larger pool first, then breaks a tie on the name", async () => {
    const larger = harness({
      WARM_POOL_SIZE: "6",
      WARM_POOL_BASE_MIN: "1",
      WARM_POOL_IDLE_DRAIN_MS: "0",
      RUNTIME_PROFILES: JSON.stringify({
        [PYTHON]: { image: "guest-python", digest: DIGEST },
        [NODE]: { image: "guest-node", digest: DIGEST },
        ruby: { image: "guest-ruby", digest: DIGEST },
      }),
    });
    // Fill the budget with node holding two units and ruby one.
    for (const profile of [PYTHON, NODE, NODE, "ruby", PYTHON]) {
      await larger.claim(profile);
      larger.clock.now += larger.cfg.warmPoolCooldownMs;
    }
    expect(larger.targets()).toEqual({ [BASE]: 1, [PYTHON]: 2, [NODE]: 2, ruby: 1 });

    // Past the demand window every candidate is idle; the larger pool loses.
    larger.clock.now += larger.cfg.warmPoolDemandWindowMs;
    await larger.claim(PYTHON);
    expect(larger.targets()).toEqual({ [BASE]: 1, [PYTHON]: 3, [NODE]: 1, ruby: 1 });

    const tied = harness({
      WARM_POOL_SIZE: "6",
      WARM_POOL_BASE_MIN: "1",
      WARM_POOL_IDLE_DRAIN_MS: "0",
      RUNTIME_PROFILES: JSON.stringify({
        [PYTHON]: { image: "guest-python", digest: DIGEST },
        [NODE]: { image: "guest-node", digest: DIGEST },
        ruby: { image: "guest-ruby", digest: DIGEST },
        zig: { image: "guest-zig", digest: DIGEST },
      }),
    });
    // base 1 + four profiles at 1 leaves one unit, which python takes.
    for (const profile of [PYTHON, NODE, "ruby", "zig", PYTHON]) {
      await tied.claim(profile);
      tied.clock.now += tied.cfg.warmPoolCooldownMs;
    }
    expect(tied.targets()).toEqual({ [BASE]: 1, [PYTHON]: 2, [NODE]: 1, ruby: 1, zig: 1 });

    // Three equally idle candidates: the name tie-break must pick `node`.
    tied.clock.now += tied.cfg.warmPoolDemandWindowMs;
    await tied.claim(PYTHON);
    expect(tied.targets()).toEqual({ [BASE]: 1, [PYTHON]: 3, [NODE]: 0, ruby: 1, zig: 1 });
  });

  it("refuses growth once every profile is at its floor", async () => {
    const h = harness({
      WARM_POOL_SIZE: "2",
      WARM_POOL_BASE_MIN: "1",
      WARM_POOL_IDLE_DRAIN_MS: "0",
    });
    // base 1 + python 1 fills the budget, and base cannot be drained.
    await h.claim(PYTHON);
    h.clock.now += h.cfg.warmPoolDemandWindowMs;
    await h.claim(PYTHON);

    expect(h.targets()).toEqual({ [BASE]: 1, [PYTHON]: 1, [NODE]: 0 });
    h.clock.now += h.cfg.warmPoolDemandWindowMs;
    await h.claim(PYTHON);
    expect(h.targets()).toEqual({ [BASE]: 1, [PYTHON]: 1, [NODE]: 0 });
  });
});

describe("the idle drain is slow on purpose", () => {
  it("gives back one pod per cooldown, never below the floor", async () => {
    const h = harness({ WARM_POOL_SIZE: "3", WARM_POOL_BASE_MIN: "1" });
    // Two misses fill the free budget: base keeps its floor, python gets two.
    await h.claim(PYTHON);
    h.clock.now += h.cfg.warmPoolCooldownMs;
    await h.claim(PYTHON);
    expect(h.targets()).toEqual({ [BASE]: 1, [PYTHON]: 2, [NODE]: 0 });

    // Past the demand window and the drain grace, so the profile is idle.
    h.clock.now += Math.max(h.cfg.warmPoolDemandWindowMs, h.cfg.warmPoolIdleDrainMs);
    await h.manager.reconcile();
    expect(h.targets()[PYTHON]).toBe(1);

    // Inside the cooldown a second drain is refused, so a burst of quiet passes
    // cannot oscillate the pool.
    await h.manager.reconcile();
    expect(h.targets()[PYTHON]).toBe(1);

    h.clock.now += h.cfg.warmPoolCooldownMs;
    await h.manager.reconcile();
    expect(h.targets()[PYTHON]).toBe(0);
    // The base profile never shrinks below its configured minimum.
    expect(h.targets()[BASE]).toBe(1);
  });

  it("keeps a pool whose drain grace is longer than the demand window", async () => {
    // An operator can set WARM_POOL_IDLE_DRAIN_MS above the demand window. The
    // drain is then gated on the last use, not on demand having decayed to zero.
    const h = harness({
      WARM_POOL_SIZE: "3",
      WARM_POOL_BASE_MIN: "1",
      WARM_POOL_IDLE_DRAIN_MS: "180000",
    });
    await h.claim(PYTHON);
    h.clock.now += h.cfg.warmPoolCooldownMs;
    await h.claim(PYTHON);
    expect(h.targets()[PYTHON]).toBe(2);

    h.clock.now += h.cfg.warmPoolDemandWindowMs;
    await h.manager.reconcile();
    expect(h.targets()[PYTHON]).toBe(2);

    h.clock.now += h.cfg.warmPoolIdleDrainMs;
    await h.manager.reconcile();
    expect(h.targets()[PYTHON]).toBe(1);
  });
});

describe("the allocation is clamped when the budget shrinks", () => {
  it("sheds non-base profiles first, then base down to its floor", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 4 }), async (remaining) => {
        const h = harness({ WARM_POOL_SIZE: "6", WARM_POOL_BASE_MIN: "2" });
        for (const profile of [PYTHON, PYTHON, NODE]) {
          await h.claim(profile);
          h.clock.now += h.cfg.warmPoolCooldownMs;
        }
        const before = h.targets();
        expect(before).toEqual({ [BASE]: 2, [PYTHON]: 2, [NODE]: 1 });

        h.cfg.warmPoolSize = remaining;
        await h.manager.reconcile();

        // Only the clamp is modelled here: every profile still has demand in
        // the window, so the idle drain cannot shed anything on top of it.
        expect(h.targets()).toEqual(shed(before, remaining, h.cfg.warmPoolBaseMin));
        expect(
          Object.values(h.targets()).reduce((sum, value) => sum + value, 0),
        ).toBeLessThanOrEqual(remaining);
      }),
      { numRuns: 10 },
    );
  });
});
