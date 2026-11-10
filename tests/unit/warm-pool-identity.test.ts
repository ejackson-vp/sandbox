import { describe, expect, it } from "vitest";
import { warmPoolIdentity } from "../../controller/src/warm-pool-identity.js";
import { digestBase, digestNode, digestPython, harness, warmPod } from "./helpers/warm-pool-fixtures.js";

const limits = { cpuMillis: 500, memoryMiB: 512, diskMiB: 256 };

function identityFor(
  h: ReturnType<typeof harness>,
  profile: string,
): string {
  const pool = h.manager.poolFor(profile);
  if (!pool) throw new Error(`missing pool ${profile}`);
  return pool.identity();
}

describe("warm pool identity", () => {
  it("does not claim a pod from an older image/config", async () => {
    const h = harness();
    h.pods.push(warmPod("base", "stale-identity", digestNode));
    expect(await h.claim()).toBe(false);
    expect(h.claims).toHaveLength(0);
  });

  it("drains a pod whose identity differs from the current config", async () => {
    const h = harness();
    h.pods.push(warmPod("base", "stale-identity", digestBase));
    await h.reconcile();
    expect(h.deletes).toEqual(["warm-aaaaaaaaaaaa"]);
  });

  it("claims a pod carrying the current identity", async () => {
    const h = harness();
    h.pods.push(warmPod("base", identityFor(h, "base"), digestBase));
    expect(await h.claim()).toBe(true);
    expect(h.claims).toHaveLength(1);
    expect(h.claims[0]?.claim.imageDigest).toBe(digestBase);
  });

  it("never gives one warm pod to two concurrent claims", async () => {
    const h = harness();
    h.pods.push(warmPod("base", identityFor(h, "base"), digestBase));
    const results = await Promise.all([
      h.claim(undefined, { id: "sbx_first" }),
      h.claim(undefined, { id: "sbx_second" }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(h.claims).toHaveLength(1);
  });

  it("keeps a matching pod during reconcile", async () => {
    const h = harness({ env: { WARM_POOL_SIZE: "1", WARM_POOL_BASE_MIN: "1" } });
    h.pods.push(warmPod("base", identityFor(h, "base"), digestBase));
    await h.reconcile();
    expect(h.deletes).toEqual([]);
  });
});

describe("profile-aware identity", () => {
  it("treats a pool pod from another profile as a miss, not a claim", async () => {
    const h = harness();
    // A perfectly valid python pod, sitting where a base session is asking.
    h.pods.push(warmPod("python", identityFor(h, "python"), digestPython));
    expect(await h.claim()).toBe(false);
    expect(h.claims).toHaveLength(0);
    // The pod is not touched either: python claims can still use it.
    expect(h.deletes).toEqual([]);
  });

  it("refuses to claim across profiles at the pool level", async () => {
    const h = harness();
    const pythonPool = h.manager.poolFor("python");
    const basePool = h.manager.poolFor("base");
    expect(pythonPool?.profile.name).toBe("python");
    const outcome = await pythonPool!.tryClaim(
      h.session("base"),
      { host: "relay", port: 8443 },
      { host: "proxy", port: 3128 },
      h.clock.now,
    );
    expect(outcome).toBe("miss_profile");
    // And the base pool refuses a python session even though it is the default.
    expect(
      await basePool!.tryClaim(
        h.session("python"),
        { host: "relay", port: 8443 },
        { host: "proxy", port: 3128 },
        h.clock.now,
      ),
    ).toBe("miss_profile");
  });

  it("carries the profile on the claim and empties it for base", async () => {
    const h = harness();
    h.pods.push(warmPod("python", identityFor(h, "python"), digestPython));
    h.pods.push(warmPod("base", identityFor(h, "base"), digestBase, { warmId: "bbbbbbbbbbbb" }));
    expect(await h.claim("python", { id: "sbx_python" })).toBe(true);
    expect(await h.claim(undefined, { id: "sbx_base" })).toBe(true);
    expect(h.claims[0]?.claim.runtime).toBe("python");
    // Base has no manifest to load, so the claim must not name one.
    expect(h.claims[1]?.claim.runtime).toBe("");
  });
});

describe("warmPoolIdentity", () => {
  const base = {
    runtime: "python",
    imageDigest: digestPython,
    runtimeClass: "x402-sandbox",
    executionMode: "dev",
    workspaceDir: "/workspace",
    limits,
  };

  it("changes when the image digest changes", () => {
    expect(warmPoolIdentity({ ...base, imageDigest: digestNode })).not.toBe(
      warmPoolIdentity(base),
    );
  });

  it("changes when the runtime profile changes", () => {
    expect(warmPoolIdentity({ ...base, runtime: "node" })).not.toBe(warmPoolIdentity(base));
  });

  it("changes when the runtime class changes", () => {
    expect(warmPoolIdentity({ ...base, runtimeClass: "other" })).not.toBe(warmPoolIdentity(base));
  });

  it("changes when the pod-shaped limits change", () => {
    expect(
      warmPoolIdentity({ ...base, limits: { ...limits, memoryMiB: limits.memoryMiB + 1 } }),
    ).not.toBe(warmPoolIdentity(base));
  });
});
