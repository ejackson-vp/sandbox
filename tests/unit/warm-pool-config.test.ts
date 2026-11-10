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
