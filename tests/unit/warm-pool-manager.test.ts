import { describe, expect, it } from "vitest";
import { digestBase, digestPython, harness, warmPod } from "./helpers/warm-pool-fixtures.js";

const SMALL_LIMITS = {
  cpuMillis: 500,
  memoryMiB: 512,
  diskMiB: 256,
} as const;

describe("warm pool manager budgeting", () => {
  it("gives base its minimum and starts other profiles at zero", () => {
    const h = harness({ env: { WARM_POOL_SIZE: "5", WARM_POOL_BASE_MIN: "2" } });
    expect(h.manager.targets()).toEqual({ base: 2, python: 0, node: 0 });
  });

  it("defaults the base minimum to the whole budget, preserving the old pool", () => {
    const h = harness({ env: { WARM_POOL_SIZE: "3" } });
    expect(h.manager.targets()).toEqual({ base: 3, python: 0, node: 0 });
  });

  it("is off at WARM_POOL_SIZE=0", async () => {
    const h = harness({ env: { WARM_POOL_SIZE: "0" } });
    expect(h.manager.targets()).toEqual({ base: 0, python: 0, node: 0 });
    h.pods.push(warmPod("base", "anything", digestBase));
    expect(await h.claim("python")).toBe(false);
    await h.reconcile();
    expect(h.deletes).toEqual(["warm-aaaaaaaaaaaa"]);
    expect(h.creates).toHaveLength(0);
  });

  it("never allocates more pods than the shared budget", async () => {
    const h = harness({ env: { WARM_POOL_SIZE: "2", WARM_POOL_BASE_MIN: "1" } });
    // One miss on each profile: base cannot fund both, so the second finds no
    // idle pool and is blocked rather than over-allocating.
    await h.claim("python");
    await h.claim("node");
    const targets = h.manager.targets();
    expect(Object.values(targets).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2);
  });
});

describe("warm pool manager growth", () => {
  it("grows the profile that missed, with no prediction", async () => {
    const h = harness({ env: { WARM_POOL_SIZE: "4", WARM_POOL_BASE_MIN: "1" } });
    expect(h.manager.targets().python).toBe(0);
    expect(await h.claim("python")).toBe(false);
    expect(h.manager.targets()).toEqual({ base: 1, python: 1, node: 0 });
    expect(h.manager.stats().python?.misses).toBe(1);
  });

  it("does not grow on a hit", async () => {
    const h = harness({ env: { WARM_POOL_SIZE: "4", WARM_POOL_BASE_MIN: "1" } });
    const pool = h.manager.poolFor("python")!;
    h.pods.push(warmPod("python", pool.identity(), digestPython));
    expect(await h.claim("python")).toBe(true);
    expect(h.manager.targets().python).toBe(0);
    expect(h.manager.stats().python?.hits).toBe(1);
  });

  it("does not grow for a session whose shape does not fit the pool tier", async () => {
    const h = harness({ env: { WARM_POOL_SIZE: "4", WARM_POOL_BASE_MIN: "1" } });
    expect(
      await h.claim("python", {
        limits: { ...SMALL_LIMITS, cpuMillis: 99_000, maxOutputBytes: 1, maxFileBytes: 1, maxCommandSeconds: 1, maxProcesses: 1 },
      }),
    ).toBe(false);
    expect(h.manager.stats().python?.limitMisses).toBe(1);
    expect(h.manager.targets().python).toBe(0);
  });

  it("holds a profile to one growth per cooldown", async () => {
    const h = harness({
      env: { WARM_POOL_SIZE: "6", WARM_POOL_BASE_MIN: "1", WARM_POOL_COOLDOWN_MS: "15000" },
    });
    await h.claim("python");
    expect(h.manager.targets().python).toBe(1);
    await h.claim("python");
    // Inside the cooldown: demand is recorded, capacity is not handed over.
    expect(h.manager.targets().python).toBe(1);
    expect(h.manager.stats().python?.misses).toBe(2);
    h.advance(15_000);
    await h.claim("python");
    expect(h.manager.targets().python).toBe(2);
  });
});

describe("warm pool manager reallocation", () => {
  it("drains an idle profile before refusing a growing one", async () => {
    const h = harness({
      env: {
        WARM_POOL_SIZE: "2",
        WARM_POOL_BASE_MIN: "1",
        WARM_POOL_COOLDOWN_MS: "15000",
        WARM_POOL_IDLE_DRAIN_MS: "60000",
        WARM_POOL_DEMAND_WINDOW_MS: "2000",
      },
    });
    // Base uses the last free slot, so python can only grow by reallocation.
    await h.claim();
    expect(h.manager.targets()).toEqual({ base: 2, python: 0, node: 0 });
    // Base has now been quiet past the demand window and the drain grace.
    h.advance(100_000);
    await h.claim("python");
    expect(h.manager.targets()).toEqual({ base: 1, python: 1, node: 0 });
  });

  it("never drains a profile that is actively serving", async () => {
    const h = harness({
      env: {
        WARM_POOL_SIZE: "2",
        WARM_POOL_BASE_MIN: "1",
        WARM_POOL_COOLDOWN_MS: "15000",
        WARM_POOL_IDLE_DRAIN_MS: "60000",
        WARM_POOL_DEMAND_WINDOW_MS: "2000",
      },
    });
    await h.claim();
    expect(h.manager.targets().base).toBe(2);
    // Base missed a moment ago, so it is hot: python is blocked instead.
    await h.claim("python");
    expect(h.manager.targets()).toEqual({ base: 2, python: 0, node: 0 });
    expect(h.manager.stats().python?.misses).toBe(1);
  });

  it("gives idle headroom back one pod per pass after the grace", async () => {
    const h = harness({
      env: {
        WARM_POOL_SIZE: "4",
        WARM_POOL_BASE_MIN: "1",
        WARM_POOL_COOLDOWN_MS: "1000",
        WARM_POOL_IDLE_DRAIN_MS: "5000",
        WARM_POOL_DEMAND_WINDOW_MS: "2000",
      },
    });
    await h.claim("python");
    expect(h.manager.targets().python).toBe(1);
    // Quiet long enough for both the demand window and the drain grace.
    h.advance(10_000);
    await h.reconcile();
    expect(h.manager.targets().python).toBe(0);
    // Base keeps its floor.
    expect(h.manager.targets().base).toBe(1);
  });
});

describe("warm pool manager reconcile", () => {
  it("creates pods from the profile catalog, bounded per pass", async () => {
    const h = harness({ env: { WARM_POOL_SIZE: "3", WARM_POOL_BASE_MIN: "2" } });
    await h.claim("python");
    await h.reconcile();
    // At most two creates in one pass.
    expect(h.creates).toHaveLength(2);
    expect(h.pods).toHaveLength(2);
    await h.reconcile();
    expect(h.creates).toHaveLength(3);
    expect(h.creates.map((spec) => spec.runtime)).toEqual(["base", "base", "python"]);
    // Every pod pulls by digest, and a language profile pulls its own image.
    for (const spec of h.creates) {
      expect(spec.image).toBe(
        `ghcr.io/example/guest@${spec.runtime === "python" ? digestPython : digestBase}`,
      );
    }
    expect(h.creates[2]?.imageDigest).toBe(digestPython);
  });

  it("passes the profile to the guest env and leaves base empty", async () => {
    const h = harness({ env: { WARM_POOL_SIZE: "2", WARM_POOL_BASE_MIN: "1" } });
    await h.claim("python");
    await h.reconcile();
    const byRuntime = new Map(h.creates.map((spec) => [spec.runtime, spec]));
    expect(byRuntime.get("base")?.runtimeProfile).toBe("");
    expect(byRuntime.get("python")?.runtimeProfile).toBe("python");
  });

  it("drains pods of a profile this controller no longer runs", async () => {
    const h = harness({ env: { WARM_POOL_SIZE: "1", WARM_POOL_BASE_MIN: "1" } });
    h.pods.push(warmPod("ruby", "whatever", digestBase, { warmId: "cccccccccccc" }));
    await h.reconcile();
    expect(h.deletes).toContain("warm-cccccccccccc");
  });

  it("drains pods from before profiles existed", async () => {
    const h = harness({ env: { WARM_POOL_SIZE: "1", WARM_POOL_BASE_MIN: "1" } });
    h.pods.push(warmPod("", "whatever", digestBase, { warmId: "dddddddddddd" }));
    await h.reconcile();
    expect(h.deletes).toContain("warm-dddddddddddd");
    expect(h.creates).toHaveLength(1);
  });
});
