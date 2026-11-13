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

describe("controller mTLS", () => {
  const files = {
    CONTROLLER_TLS_CERT_FILE: "/controller/tls.crt",
    CONTROLLER_TLS_KEY_FILE: "/controller/tls.key",
    CONTROLLER_TLS_CA_FILE: "/controller/ca.crt",
  };

  it("is off when no file is set", () => {
    expect(loadConfig(base).controllerTls).toBeUndefined();
  });

  it("requires all three files, not any two", () => {
    expect(() => loadConfig({ ...base, CONTROLLER_TLS_CERT_FILE: "/controller/tls.crt" })).toThrow(
      "CONTROLLER_TLS_CERT_FILE, CONTROLLER_TLS_KEY_FILE and CONTROLLER_TLS_CA_FILE must be set together",
    );
  });

  it("requires an https CONTROLLER_URL once the files are set", () => {
    expect(() => loadConfig({ ...base, ...files })).toThrow(
      "CONTROLLER_TLS_* requires an https CONTROLLER_URL",
    );
    const cfg = loadConfig({ ...base, ...files, CONTROLLER_URL: "https://controller:3001" });
    expect(cfg.controllerTls).toEqual({
      certFile: "/controller/tls.crt",
      keyFile: "/controller/tls.key",
      caFile: "/controller/ca.crt",
    });
  });
});

describe("concurrent connection cap", () => {
  it("caps one client at 64 in-flight requests by default", () => {
    expect(loadConfig(base).maxConnectionsPerClient).toBe(64);
  });

  it("caps the process at 2048 in-flight requests by default", () => {
    expect(loadConfig(base).maxConnectionsGlobal).toBe(2_048);
  });

  it("accepts 0 as the off switch for the per-client check", () => {
    expect(loadConfig({ ...base, MAX_CONNECTIONS_PER_CLIENT: "0" }).maxConnectionsPerClient).toBe(0);
  });

  it("refuses a global cap of 0, which would refuse every request", () => {
    expect(() => loadConfig({ ...base, MAX_CONNECTIONS_GLOBAL: "0" })).toThrow(/invalid integer/);
  });

  it("refuses a negative or non-integer cap", () => {
    expect(() => loadConfig({ ...base, MAX_CONNECTIONS_PER_CLIENT: "-1" })).toThrow(/invalid integer/);
    expect(() => loadConfig({ ...base, MAX_CONNECTIONS_GLOBAL: "2.5" })).toThrow(/invalid integer/);
  });
});
