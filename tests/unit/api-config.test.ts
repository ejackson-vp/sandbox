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

describe("facilitator client configuration", () => {
  it("defaults to a bounded per-call timeout", () => {
    expect(loadConfig(base).facilitatorTimeoutMs).toBe(20_000);
  });

  it("requires both halves of a CDP key pair, or neither", () => {
    expect(() => loadConfig({ ...base, FACILITATOR_API_KEY_ID: "id" })).toThrow(/set together/);
    expect(() => loadConfig({ ...base, FACILITATOR_API_KEY_SECRET: "secret" })).toThrow(
      /set together/,
    );
  });

  it("refuses to send a key over plaintext", () => {
    expect(() =>
      loadConfig({
        ...base,
        FACILITATOR_URL: "http://facilitator.example.test",
        FACILITATOR_API_KEY_ID: "id",
        FACILITATOR_API_KEY_SECRET: "secret",
      }),
    ).toThrow(/https/);
  });

  it("accepts a key pair over https without exposing it on the config surface", () => {
    const cfg = loadConfig({
      ...base,
      FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
      FACILITATOR_API_KEY_ID: "id",
      FACILITATOR_API_KEY_SECRET: "secret",
    });
    expect(cfg.facilitatorApiKeyId).toBe("id");
    expect(cfg.facilitatorApiKeySecret).toBe("secret");
  });

  it("rejects a timeout outside the accepted range", () => {
    expect(() => loadConfig({ ...base, FACILITATOR_TIMEOUT_MS: "10" })).toThrow();
    expect(() => loadConfig({ ...base, FACILITATOR_TIMEOUT_MS: "999999" })).toThrow();
  });
});

describe("mainnet mode", () => {
  // The complete configuration: every mainnet assertion satisfied. Each test
  // below removes or breaks exactly one of them.
  const mainnet = {
    ...base,
    PAYMENT_MODE: "mainnet",
    NETWORK: "eip155:8453",
    PAY_TO: "0x1111111111111111111111111111111111111111",
    FACILITATOR_URL: "https://facilitator.example.test",
    PAYMENT_RPC_URL: "https://mainnet.base.org",
  };

  it("starts with a complete explicit configuration", () => {
    const cfg = loadConfig(mainnet);
    expect(cfg.paymentMode).toBe("mainnet");
    expect(cfg.network).toBe("eip155:8453");
    expect(cfg.facilitatorUrl).toBe("https://facilitator.example.test");
    expect(cfg.paymentUsdcAddress).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  it("rejects an unknown payment mode", () => {
    expect(() => loadConfig({ ...base, PAYMENT_MODE: "live" })).toThrow(/PAYMENT_MODE/);
  });

  it("refuses a mainnet network unless the mode is mainnet", () => {
    expect(() => loadConfig({ ...mainnet, PAYMENT_MODE: "testnet" })).toThrow(/mainnet/);
  });

  it("requires NETWORK explicitly", () => {
    const { NETWORK, ...rest } = mainnet;
    expect(() => loadConfig(rest)).toThrow(/NETWORK/);
  });

  it("refuses a network outside the mainnet allowlist", () => {
    expect(() =>
      loadConfig({ ...mainnet, NETWORK: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }),
    ).toThrow(/allowlist/);
    expect(() => loadConfig({ ...mainnet, NETWORK: "eip155:84532" })).toThrow(/allowlist/);
  });

  it("refuses the mock PAY_TO", () => {
    expect(() =>
      loadConfig({ ...mainnet, PAY_TO: "0x0000000000000000000000000000000000000402" }),
    ).toThrow(/real receiving address/);
  });

  it("requires a valid PAY_TO", () => {
    const { PAY_TO, ...rest } = mainnet;
    expect(() => loadConfig(rest)).toThrow(/PAY_TO/);
    expect(() => loadConfig({ ...mainnet, PAY_TO: "0xnot-an-address" })).toThrow(/PAY_TO/);
  });

  it("requires FACILITATOR_URL explicitly", () => {
    const { FACILITATOR_URL, ...rest } = mainnet;
    expect(() => loadConfig(rest)).toThrow(/FACILITATOR_URL/);
  });

  it("refuses to start without an on-chain verifier", () => {
    const { PAYMENT_RPC_URL, ...rest } = mainnet;
    expect(() => loadConfig(rest)).toThrow(/PAYMENT_RPC_URL/);
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
