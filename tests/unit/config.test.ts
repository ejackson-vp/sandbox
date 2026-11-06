import { describe, expect, it } from "vitest";
import { loadControllerConfig } from "../../controller/src/config.js";

const base = {
  ADMIN_TOKEN: "test-admin-token-0123456789",
  EXECUTION_MODE: "confidential",
  ALLOW_INSECURE_DEV: "false",
  RUNTIME_CLASS: "kata-qemu-snp",
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
});
