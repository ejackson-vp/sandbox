import { describe, expect, it } from "vitest";
import { loadConfig } from "../../api/src/config.js";

const base = {
  PAYMENT_MODE: "mock",
  ALLOW_INSECURE_DEV: "true",
  // Deliberately low-entropy: these are test fixtures, and the secret scanner
  // is right to flag anything that looks like a real credential.
  CONTROLLER_ADMIN_TOKEN: "a".repeat(32),
  CAPABILITY_SECRET: "b".repeat(32),
};

describe("api config guards", () => {
  it("accepts a complete mock configuration", () => {
    const cfg = loadConfig(base);
    expect(cfg.paymentMode).toBe("mock");
    expect(cfg.capabilitySecret).not.toBe(cfg.controllerAdminToken);
  });

  it("requires CAPABILITY_SECRET instead of falling back to the admin token", () => {
    const { CAPABILITY_SECRET, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow(/CAPABILITY_SECRET/);
  });

  it("rejects reusing the admin token as the capability secret", () => {
    expect(() =>
      loadConfig({ ...base, CAPABILITY_SECRET: base.CONTROLLER_ADMIN_TOKEN }),
    ).toThrow(/must differ/i);
  });

  it("requires a controller admin token", () => {
    const { CONTROLLER_ADMIN_TOKEN, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow(/CONTROLLER_ADMIN_TOKEN/);
  });

  it("strips a trailing slash from PUBLIC_BASE_URL", () => {
    const cfg = loadConfig({ ...base, PUBLIC_BASE_URL: "https://sandbox.example.ts.net/" });
    expect(cfg.publicBaseUrl).toBe("https://sandbox.example.ts.net");
  });

  it("rejects a non-http PUBLIC_BASE_URL", () => {
    expect(() => loadConfig({ ...base, PUBLIC_BASE_URL: "ftp://example.test" })).toThrow(
      /PUBLIC_BASE_URL/,
    );
  });

  it("keeps the header timeout below the request timeout by default", () => {
    const cfg = loadConfig(base);
    expect(cfg.httpHeadersTimeoutMs).toBeLessThan(cfg.httpRequestTimeoutMs);
    expect(cfg.httpRequestTimeoutMs).toBe(60_000);
  });

  it("honours explicit HTTP timeouts", () => {
    const cfg = loadConfig({
      ...base,
      HTTP_HEADERS_TIMEOUT_MS: "5000",
      HTTP_REQUEST_TIMEOUT_MS: "30000",
    });
    expect(cfg.httpHeadersTimeoutMs).toBe(5_000);
    expect(cfg.httpRequestTimeoutMs).toBe(30_000);
  });
});
