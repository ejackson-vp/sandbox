import { describe, expect, it } from "vitest";
import { loadControllerConfig } from "../../controller/src/config.js";

const baseEnv: NodeJS.ProcessEnv = {
  ADMIN_TOKEN: "a".repeat(24),
  RELAY_ADMIN_TOKEN: "r".repeat(24),
  WAKE_TOKEN: "w".repeat(24),
  PROXY_TOKEN_SECRET: "p".repeat(24),
  EXECUTION_MODE: "dev",
  ALLOW_INSECURE_DEV: "true",
  KUBERNETES_ENABLED: "false",
};

describe("warm pool configuration", () => {
  it("is off by default", () => {
    const cfg = loadControllerConfig(baseEnv);
    expect(cfg.warmPoolSize).toBe(0);
    expect(cfg.warmPoolTier).toBe("short");
    expect(cfg.warmClaimTimeoutMs).toBeGreaterThan(0);
  });

  it("parses an explicit pool size and tier", () => {
    const cfg = loadControllerConfig({
      ...baseEnv,
      WARM_POOL_SIZE: "4",
      WARM_POOL_TIER: "standard",
      WARM_POOL_TTL_MS: "120000",
    });
    expect(cfg.warmPoolSize).toBe(4);
    expect(cfg.warmPoolTier).toBe("standard");
    expect(cfg.warmPoolTtlMs).toBe(120_000);
  });

  it("rejects an unknown pool tier", () => {
    expect(() => loadControllerConfig({ ...baseEnv, WARM_POOL_TIER: "gigantic" })).toThrow(/WARM_POOL_TIER/);
  });
});

describe("runtime profile catalog", () => {
  const pinned = `sha256:${"b".repeat(64)}`;

  it("always includes base from the guest image", () => {
    const cfg = loadControllerConfig({
      ...baseEnv,
      GUEST_IMAGE: "ghcr.io/example/guest:0.1.0",
      GUEST_IMAGE_DIGEST: pinned,
    });
    expect(cfg.runtimeProfiles.base).toEqual({
      name: "base",
      image: "ghcr.io/example/guest:0.1.0",
      digest: pinned,
      imageRef: `ghcr.io/example/guest@${pinned}`,
    });
    expect(Object.keys(cfg.runtimeProfiles)).toEqual(["base"]);
  });

  it("parses RUNTIME_PROFILES JSON into pinned image references", () => {
    const cfg = loadControllerConfig({
      ...baseEnv,
      GUEST_IMAGE_DIGEST: pinned,
      RUNTIME_PROFILES: JSON.stringify({
        python: { image: "ghcr.io/example/guest:0.1.0-python", digest: pinned },
      }),
    });
    expect(cfg.runtimeProfiles.python).toEqual({
      name: "python",
      image: "ghcr.io/example/guest:0.1.0-python",
      digest: pinned,
      imageRef: `ghcr.io/example/guest@${pinned}`,
    });
  });

  it("rejects malformed catalogs", () => {
    const env = { ...baseEnv, GUEST_IMAGE_DIGEST: pinned };
    expect(() => loadControllerConfig({ ...env, RUNTIME_PROFILES: "{not json" })).toThrow(
      /RUNTIME_PROFILES must be valid JSON/,
    );
    expect(() => loadControllerConfig({ ...env, RUNTIME_PROFILES: "[]" })).toThrow(
      /RUNTIME_PROFILES must be a JSON object/,
    );
    expect(() =>
      loadControllerConfig({ ...env, RUNTIME_PROFILES: JSON.stringify({ Python: { image: "x", digest: pinned } }) }),
    ).toThrow(/profile name "Python"/);
    expect(() =>
      loadControllerConfig({
        ...env,
        RUNTIME_PROFILES: JSON.stringify({ python: { image: "", digest: pinned } }),
      }),
    ).toThrow(/RUNTIME_PROFILES\.python\.image/);
    expect(() =>
      loadControllerConfig({
        ...env,
        RUNTIME_PROFILES: JSON.stringify({ "python-x": { image: `ghcr.io/example/guest@${pinned}`, digest: pinned } }),
      }),
    ).toThrow(/must not embed a digest/);
  });

  it("does not let RUNTIME_PROFILES shadow base", () => {
    expect(() =>
      loadControllerConfig({
        ...baseEnv,
        GUEST_IMAGE_DIGEST: pinned,
        RUNTIME_PROFILES: JSON.stringify({ base: { image: "ghcr.io/evil/guest:1", digest: pinned } }),
      }),
    ).toThrow(/must not redefine base/);
  });

  it("applies the guest digest rules to every profile", () => {
    // Unpinned profile digests are rejected exactly like an unpinned guest.
    expect(() =>
      loadControllerConfig({
        ...baseEnv,
        GUEST_IMAGE_DIGEST: pinned,
        RUNTIME_PROFILES: JSON.stringify({ python: { image: "ghcr.io/example/guest:1", digest: "sha256:short" } }),
      }),
    ).toThrow(/RUNTIME_PROFILES\.python\.digest/);
  });

  it("requires pinned profile digests when insecure dev is off", () => {
    expect(() =>
      loadControllerConfig({
        ...baseEnv,
        ALLOW_INSECURE_DEV: "false",
        GUEST_IMAGE_DIGEST: pinned,
        RUNTIME_PROFILES: JSON.stringify({
          python: { image: "ghcr.io/example/guest:1", digest: "sha256:dev-unpinned-image" },
        }),
      }),
    ).toThrow(/RUNTIME_PROFILES\.python\.digest must be a pinned sha256 digest/);
  });
});

describe("elastic warm pool configuration", () => {
  it("defaults the base minimum to the whole budget", () => {
    const cfg = loadControllerConfig({ ...baseEnv, WARM_POOL_SIZE: "6" });
    expect(cfg.warmPoolBaseMin).toBe(6);
    expect(cfg.warmPoolGrowthStep).toBe(1);
    expect(cfg.warmPoolCooldownMs).toBe(15_000);
    expect(cfg.warmPoolIdleDrainMs).toBe(60_000);
    expect(cfg.warmPoolDemandWindowMs).toBe(120_000);
  });

  it("reserves a base minimum inside the shared budget", () => {
    const cfg = loadControllerConfig({
      ...baseEnv,
      WARM_POOL_SIZE: "6",
      WARM_POOL_BASE_MIN: "2",
      WARM_POOL_GROWTH_STEP: "2",
    });
    expect(cfg.warmPoolBaseMin).toBe(2);
    expect(cfg.warmPoolGrowthStep).toBe(2);
  });

  it("refuses a base minimum larger than the budget", () => {
    expect(() =>
      loadControllerConfig({ ...baseEnv, WARM_POOL_SIZE: "2", WARM_POOL_BASE_MIN: "3" }),
    ).toThrow(/WARM_POOL_BASE_MIN/);
  });
});
