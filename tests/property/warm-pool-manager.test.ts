/**
 * The manager's reconcile pass: one shared create budget, drains, and the work
 * it must refuse.
 *
 * The allocation policy (how large each profile's target is) is pinned in
 * warm-pool-allocation.test.ts and the pod-level claim rules in
 * warm-pool-claims.test.ts. What is left is the pass that turns targets into
 * cluster effects, and its promises are about arithmetic and arithmetic under
 * failure:
 *
 *   1. one pass creates at most `min(missing, maxCreate, target)`, and the
 *      two-pod create budget is shared across every profile rather than granted
 *      per profile. A pod the pass creates carries the identity the next pass
 *      will accept, so a create is never recycled immediately;
 *   2. a target of zero drains the profile and creates nothing in its place;
 *   3. a claimed pod is never a delete victim, even when its profile's target is
 *      clamped to zero under the live claim;
 *   4. a miss that more pods cannot fix, a runtime this controller does not run,
 *      a failed namespace listing, or a refused admission all change nothing.
 *      Every one of those has to fail closed: reusing a pod or spending budget
 *      on an error is how a pool turns a blip into a wrong runtime.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  BASE,
  DIGEST,
  NODE,
  PYTHON,
  harness,
  warmPod,
} from "../helpers/warm-pool-harness.js";

describe("one pass spends one shared create budget", () => {
  it("never creates more than the missing count, the target, or two pods overall", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 0, max: 4 }),
        async (size, baseMin, seeded) => {
          const h = harness({
            WARM_POOL_SIZE: String(size),
            WARM_POOL_BASE_MIN: String(Math.min(baseMin, size)),
          });
          const identity = h.manager.poolFor(BASE)!.identity();
          for (let index = 0; index < seeded; index += 1) {
            h.pods.push(
              warmPod(
                `warm-seed-${index}`,
                `seed${index}`,
                BASE,
                identity,
                h.cfg.runtimeProfiles[BASE]!.digest,
                h.clock.now,
              ),
            );
          }

          await h.manager.reconcile();

          expect(h.creates.length).toBeLessThanOrEqual(2);
          expect(h.creates.length).toBeLessThanOrEqual(h.targets()[BASE]!);
          // Every create names a profile pool that exists and carries the
          // identity that pool will accept on the next pass.
          for (const spec of h.creates) {
            const pool = h.manager.poolFor(spec.runtime);
            expect(pool).toBeDefined();
            expect(spec.identity).toBe(pool!.identity());
          }
          // Created pods are counted, not recycled: a second pass with no claims
          // must not delete what the first one just made.
          const deleted = h.deletes.length;
          await h.manager.reconcile();
          expect(h.deletes).toHaveLength(deleted);
          expect(h.creates.length).toBeLessThanOrEqual(4);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("shares the create budget across profiles instead of granting it per profile", async () => {
    const h = harness({ WARM_POOL_SIZE: "4", WARM_POOL_BASE_MIN: "2" });
    // base wants 2 and python wants 1: three missing pods, two allowed.
    await h.claim(PYTHON);

    await h.manager.reconcile();
    expect(h.creates).toHaveLength(2);
    expect(h.creates.every((spec) => spec.runtime === BASE)).toBe(true);

    // The next pass spends the budget the first one could not, on python.
    await h.manager.reconcile();
    expect(h.creates).toHaveLength(3);
    expect(h.creates[2]!.runtime).toBe(PYTHON);
  });

  it("drains to zero without creating a replacement", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 5 }), async (podCount) => {
        const h = harness({ WARM_POOL_SIZE: "0", WARM_POOL_BASE_MIN: "0" });
        const identity = h.manager.poolFor(BASE)!.identity();
        for (let index = 0; index < podCount; index += 1) {
          h.pods.push(
            warmPod(
              `warm-drain-${index}`,
              `drain${index}`,
              BASE,
              identity,
              h.cfg.runtimeProfiles[BASE]!.digest,
              h.clock.now,
            ),
          );
        }

        // A disabled pool claims nothing, so a miss cannot grow it back.
        expect(await h.claim(BASE)).toBe(false);

        await h.manager.reconcile();

        expect(h.targets()).toEqual({ [BASE]: 0, [PYTHON]: 0, [NODE]: 0 });
        expect(h.pods).toHaveLength(0);
        expect(h.deletes).toHaveLength(podCount);
        expect(h.creates).toHaveLength(0);
      }),
      { numRuns: 15 },
    );
  });
});

describe("a claimed pod is never a victim", () => {
  it("keeps the in-flight pod when its profile is drained to zero under it", async () => {
    const h = harness({ WARM_POOL_SIZE: "4", WARM_POOL_BASE_MIN: "1" });
    await h.claim(PYTHON);
    await h.manager.reconcile();
    const pythonPod = h.podsFor(PYTHON)[0]!;
    expect(pythonPod).toBeDefined();
    // Step past the pool's two-second listing cache: `pick` must see the pod the
    // reconcile just created, not the empty listing it read before it.
    h.clock.now += 2_500;

    const inFlight = await h.parkClaim(PYTHON);
    // An operator lowers the budget under a live claim: the allocation clamp
    // drops python's target to zero, but the reserved pod must survive.
    h.cfg.warmPoolSize = 1;
    await h.manager.reconcile();

    expect(h.targets()[PYTHON]).toBe(0);
    expect(h.deletes).not.toContain(pythonPod.name);
    expect(h.pods.some((pod) => pod.warmId === pythonPod.warmId)).toBe(true);

    inFlight.finish();
    expect(await inFlight.result).toBe(true);
  });
});

describe("the manager refuses work it cannot do", () => {
  it("never grows on a miss that more pods cannot fix", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (attempts) => {
        const h = harness({ WARM_POOL_SIZE: "4", WARM_POOL_BASE_MIN: "1" });
        const pool = h.manager.poolFor(PYTHON)!;
        const limits = { ...pool.limits(), cpuMillis: pool.limits().cpuMillis + 1 };

        for (let index = 0; index < attempts; index += 1) {
          expect(await h.claim(PYTHON, { limits })).toBe(false);
          h.clock.now += h.cfg.warmPoolCooldownMs;
        }

        expect(h.targets()).toEqual({ [BASE]: 1, [PYTHON]: 0, [NODE]: 0 });
        expect(h.manager.stats()[PYTHON]!.limitMisses).toBe(attempts);
        expect(h.manager.stats()[PYTHON]!.misses).toBe(0);
      }),
      { numRuns: 10 },
    );
  });

  it("fails closed on a runtime profile this controller does not run", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .stringMatching(/^[a-z][a-z0-9-]{0,11}$/)
          .filter((name) => ![BASE, PYTHON, NODE].includes(name)),
        async (runtime) => {
          const h = harness();

          expect(await h.claim(runtime)).toBe(false);

          // Never routed to `base`, and nothing was spent on it.
          expect(h.targets()).toEqual({ [BASE]: 1, [PYTHON]: 0, [NODE]: 0 });
          expect(h.pods).toHaveLength(0);
          expect(h.creates).toHaveLength(0);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("changes nothing when the namespace listing fails", async () => {
    const h = harness({ WARM_POOL_SIZE: "4", WARM_POOL_BASE_MIN: "2" });
    await h.claim(PYTHON);
    const before = h.targets();
    h.refuseList();

    await expect(h.manager.reconcile()).resolves.toBeUndefined();

    expect(h.targets()).toEqual(before);
    expect(h.creates).toHaveLength(0);
    expect(h.deletes).toHaveLength(0);
  });

  it("does not create when admission refuses", async () => {
    const h = harness({ WARM_POOL_SIZE: "4", WARM_POOL_BASE_MIN: "2" });
    await h.claim(PYTHON);
    h.refuseAdmission();

    await h.manager.reconcile();

    // The target is a decision, not a promise: the pool keeps wanting pods and
    // retries next pass, but nothing was created or deleted.
    expect(h.targets()[PYTHON]).toBe(1);
    expect(h.creates).toHaveLength(0);
    expect(h.deletes).toHaveLength(0);
  });

  it("recycles orphan pods from a profile this controller no longer runs", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 3 }), async (orphans) => {
        const h = harness({ WARM_POOL_SIZE: "4", WARM_POOL_BASE_MIN: "1" });
        for (let index = 0; index < orphans; index += 1) {
          h.pods.push(
            warmPod(`warm-orphan-${index}`, `orphan${index}`, "ruby", "stale", DIGEST, h.clock.now),
          );
        }
        // A pod with no warm id predates the pool labels and is not ours to
        // delete: the listing cannot prove it belongs to a pool.
        h.pods.push(warmPod("warm-unlabelled", "", "ruby", "", "", h.clock.now));
        // A pod from before profiles existed carries no runtime either.
        h.pods.push(warmPod("warm-preprofile", "preprofile", "", "", "", h.clock.now));

        await h.manager.reconcile();

        expect(h.deletes).toHaveLength(orphans + 1);
        expect(h.deletes).toContain("warm-preprofile");
        expect(h.deletes).not.toContain("warm-unlabelled");
        expect(h.purges).toEqual([
          ...Array.from({ length: orphans }, (_, index) => `warm_orphan${index}`),
          "warm_preprofile",
        ]);
      }),
      { numRuns: 10 },
    );
  });
});
