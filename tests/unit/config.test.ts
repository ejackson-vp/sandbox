import { describe, expect, it } from "vitest";
import { loadControllerConfig } from "../../controller/src/config.js";

// Low-entropy fixtures: real credentials never look like this.
const TOKENS = {
  ADMIN_TOKEN: "a".repeat(24),
  RELAY_ADMIN_TOKEN: "r".repeat(24),
  WAKE_TOKEN: "w".repeat(24),
  PROXY_TOKEN_SECRET: "p".repeat(24),
};

const base = {
  ...TOKENS,
  EXECUTION_MODE: "kata",
  ALLOW_INSECURE_DEV: "false",
  RUNTIME_CLASS: "kata",
};

const dev = { ...TOKENS, EXECUTION_MODE: "dev", ALLOW_INSECURE_DEV: "true" };

describe("production config guards", () => {
  it("requires a pinned image digest when insecure dev is off", () => {
    expect(() =>
      loadControllerConfig({ ...base, GUEST_IMAGE_DIGEST: "sha256:dev-unpinned-image" }),
    ).toThrow(/GUEST_IMAGE_DIGEST/);
  });

  it("rejects a credential that reuses the admin token", () => {
    expect(() =>
      loadControllerConfig({ ...dev, WAKE_TOKEN: TOKENS.ADMIN_TOKEN }),
    ).toThrow(/key separation/i);
  });

  it("rejects a missing credential instead of falling back", () => {
    const { PROXY_TOKEN_SECRET, ...withoutProxy } = dev;
    void PROXY_TOKEN_SECRET;
    expect(() => loadControllerConfig(withoutProxy)).toThrow(/PROXY_TOKEN_SECRET/);
  });

  it("requires only the tokens a role actually uses", () => {
    const proxy = loadControllerConfig({
      ...dev,
      ROLE: "proxy",
      PROXY_TOKEN_SECRET: "p".repeat(24),
      RELAY_ADMIN_TOKEN: undefined,
      WAKE_TOKEN: undefined,
    });
    expect(proxy.role).toBe("proxy");
    const relay = loadControllerConfig({
      ...dev,
      ROLE: "relay",
      RELAY_ADMIN_TOKEN: "r".repeat(24),
      WAKE_TOKEN: "w".repeat(24),
      PROXY_TOKEN_SECRET: undefined,
    });
    expect(relay.role).toBe("relay");
  });

  it("validates capacity accounting mode", () => {
    const cfg = loadControllerConfig({ ...dev, CAPACITY_ACCOUNTING: "peak" });
    expect(cfg.capacityAccounting).toBe("peak");
    expect(() =>
      loadControllerConfig({ ...dev, CAPACITY_ACCOUNTING: "sometimes" }),
    ).toThrow(/CAPACITY_ACCOUNTING/);
  });

  it("accepts a pinned digest", () => {
    const cfg = loadControllerConfig({
      ...base,
      GUEST_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
    });
    expect(cfg.guestImageDigest).toBe(`sha256:${"a".repeat(64)}`);
  });

  it("pulls by digest even when insecure dev mode is on", () => {
    const digest = `sha256:${"b".repeat(64)}`;
    const cfg = loadControllerConfig({
      ...dev,
      GUEST_IMAGE: "ghcr.io/example/guest:0.1.0",
      GUEST_IMAGE_DIGEST: digest,
    });
    expect(cfg.guestImageRef).toBe(`ghcr.io/example/guest@${digest}`);
  });

  it("keeps the tag when the dev placeholder digest is used", () => {
    const cfg = loadControllerConfig({
      ...dev,
      GUEST_IMAGE: "x402-sandbox/guest:dev",
      GUEST_IMAGE_DIGEST: "sha256:dev-unpinned-image",
    });
    expect(cfg.guestImageRef).toBe("x402-sandbox/guest:dev");
  });

  it("rejects a malformed digest even in dev", () => {
    expect(() =>
      loadControllerConfig({ ...dev, GUEST_IMAGE_DIGEST: "sha256:not-a-digest" }),
    ).toThrow(/GUEST_IMAGE_DIGEST/);
  });
});
