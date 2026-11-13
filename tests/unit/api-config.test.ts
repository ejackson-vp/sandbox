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

describe("chain verification configuration", () => {
  const testnet = {
    ...base,
    PAYMENT_MODE: "testnet",
    PAY_TO: "0x1111111111111111111111111111111111111111",
  };

  it("is off unless PAYMENT_RPC_URL is set", () => {
    expect(loadConfig(testnet).paymentRpcUrl).toBeUndefined();
  });

  it("accepts an absolute http(s) RPC URL and defaults the USDC contract", () => {
    const cfg = loadConfig({ ...testnet, PAYMENT_RPC_URL: "https://mainnet.base.org" });
    expect(cfg.paymentRpcUrl).toBe("https://mainnet.base.org");
    expect(cfg.paymentUsdcAddress).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  });

  it("rejects a non-http RPC URL", () => {
    expect(() => loadConfig({ ...testnet, PAYMENT_RPC_URL: "ws://rpc.invalid" })).toThrow(
      /PAYMENT_RPC_URL/,
    );
  });

  it("rejects a malformed USDC override", () => {
    expect(() =>
      loadConfig({ ...testnet, PAYMENT_RPC_URL: "https://rpc.invalid", PAYMENT_USDC_ADDRESS: "0x1234" }),
    ).toThrow(/PAYMENT_USDC_ADDRESS/);
  });

  it("accepts a USDC override for a network with no default", () => {
    const cfg = loadConfig({
      ...testnet,
      NETWORK: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      PAYMENT_RPC_URL: "https://rpc.invalid",
      PAYMENT_USDC_ADDRESS: "0x2222222222222222222222222222222222222222",
    });
    expect(cfg.paymentUsdcAddress).toBe("0x2222222222222222222222222222222222222222");
  });

  it("requires an explicit USDC address on a network with no default", () => {
    expect(() =>
      loadConfig({
        ...testnet,
        NETWORK: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        PAYMENT_RPC_URL: "https://rpc.invalid",
      }),
    ).toThrow(/PAYMENT_USDC_ADDRESS/);
  });

  it("ignores the RPC URL on the mock path", () => {
    // The mock scheme never uses a nonce on chain, so a configured verifier
    // would refuse every mock payment. It is not built there.
    const cfg = loadConfig({ ...base, PAYMENT_RPC_URL: "https://rpc.invalid" });
    expect(cfg.paymentMode).toBe("mock");
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
