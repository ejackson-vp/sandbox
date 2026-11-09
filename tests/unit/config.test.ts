import { describe, expect, it } from "vitest";
import { loadControllerConfig } from "../../controller/src/config.js";

const base = {
  ADMIN_TOKEN: "test-admin-token-0123456789",
  EXECUTION_MODE: "kata",
  ALLOW_INSECURE_DEV: "false",
  RUNTIME_CLASS: "kata",
};

describe("production config guards", () => {
  it("requires a pinned image digest when insecure dev is off", () => {
    expect(() =>
      loadControllerConfig({ ...base, GUEST_IMAGE_DIGEST: "sha256:dev-unpinned-image" }),
    ).toThrow(/GUEST_IMAGE_DIGEST/);
  });

  it("validates capacity accounting mode", () => {
    const cfg = loadControllerConfig({
      ADMIN_TOKEN: "test-admin-token-0123456789",
      EXECUTION_MODE: "dev",
      ALLOW_INSECURE_DEV: "true",
      CAPACITY_ACCOUNTING: "peak",
    });
    expect(cfg.capacityAccounting).toBe("peak");
    expect(() =>
      loadControllerConfig({
        ADMIN_TOKEN: "test-admin-token-0123456789",
        EXECUTION_MODE: "dev",
        ALLOW_INSECURE_DEV: "true",
        CAPACITY_ACCOUNTING: "sometimes",
      }),
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
      ADMIN_TOKEN: "test-admin-token-0123456789",
      EXECUTION_MODE: "dev",
      ALLOW_INSECURE_DEV: "true",
      GUEST_IMAGE: "ghcr.io/example/guest:0.1.0",
      GUEST_IMAGE_DIGEST: digest,
    });
    expect(cfg.guestImageRef).toBe(`ghcr.io/example/guest@${digest}`);
  });

  it("keeps the tag when the dev placeholder digest is used", () => {
    const cfg = loadControllerConfig({
      ADMIN_TOKEN: "test-admin-token-0123456789",
      EXECUTION_MODE: "dev",
      ALLOW_INSECURE_DEV: "true",
      GUEST_IMAGE: "x402-sandbox/guest:dev",
      GUEST_IMAGE_DIGEST: "sha256:dev-unpinned-image",
    });
    expect(cfg.guestImageRef).toBe("x402-sandbox/guest:dev");
  });

  it("rejects a malformed digest even in dev", () => {
    expect(() =>
      loadControllerConfig({
        ADMIN_TOKEN: "test-admin-token-0123456789",
        EXECUTION_MODE: "dev",
        ALLOW_INSECURE_DEV: "true",
        GUEST_IMAGE_DIGEST: "sha256:not-a-digest",
      }),
    ).toThrow(/GUEST_IMAGE_DIGEST/);
  });
});
