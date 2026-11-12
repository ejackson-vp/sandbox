import { describe, expect, it } from "vitest";
import { loadControllerConfig } from "../../controller/src/config.js";

// Low-entropy fixtures: real credentials never look like this.
const TOKENS = {
  ADMIN_TOKEN: "a".repeat(24),
  RELAY_ADMIN_TOKEN: "r".repeat(24),
  WAKE_TOKEN: "w".repeat(24),
  PROXY_TOKEN_SECRET: "p".repeat(24),
};

const DATABASE_URL = "postgres://user:pw@db:5432/sandbox";

const base = {
  ...TOKENS,
  DATABASE_URL,
  EXECUTION_MODE: "kata",
  ALLOW_INSECURE_DEV: "false",
  KUBERNETES_ENABLED: "false",
  RUNTIME_CLASS: "kata",
};

const dev = {
  ...TOKENS,
  DATABASE_URL,
  EXECUTION_MODE: "dev",
  ALLOW_INSECURE_DEV: "true",
  KUBERNETES_ENABLED: "false",
};

const PINNED = `sha256:${"c".repeat(64)}`;
const PLACEHOLDER = "sha256:unpinned-dev-image";

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

  it("requires relay mTLS material for a cluster relay", () => {
    expect(() =>
      loadControllerConfig({
        ...dev,
        ROLE: "relay",
        KUBERNETES_ENABLED: "true",
        GUEST_IMAGE_DIGEST: PINNED,
      }),
    ).toThrow(/RELAY_TLS_/);
  });

  it("requires the client certificate pair for an https relay URL", () => {
    expect(() =>
      loadControllerConfig({ ...dev, RELAY_URL: "https://relay.sandbox-system.svc:8444" }),
    ).toThrow(/RELAY_CLIENT_TLS_/);
    const cfg = loadControllerConfig({
      ...dev,
      RELAY_URL: "https://relay.sandbox-system.svc:8444",
      RELAY_CLIENT_TLS_CERT_FILE: "/relay-tls/tls.crt",
      RELAY_CLIENT_TLS_KEY_FILE: "/relay-tls/tls.key",
      RELAY_CLIENT_TLS_CA_FILE: "/relay-tls/ca.crt",
    });
    expect(cfg.relayClientTls?.caFile).toBe("/relay-tls/ca.crt");
  });

  it("rejects a partial TLS file set", () => {
    expect(() =>
      loadControllerConfig({ ...dev, RELAY_TLS_CERT_FILE: "/tls/tls.crt" }),
    ).toThrow(/must be set together/);
  });

  it("validates capacity accounting mode", () => {
    const cfg = loadControllerConfig({ ...dev, CAPACITY_ACCOUNTING: "peak" });
    expect(cfg.capacityAccounting).toBe("peak");
    expect(() =>
      loadControllerConfig({ ...dev, CAPACITY_ACCOUNTING: "sometimes" }),
    ).toThrow(/CAPACITY_ACCOUNTING/);
  });

  it("bounds the relay registration retry window", () => {
    expect(loadControllerConfig({ ...dev }).relayRegistrationTimeoutMs).toBe(5_000);
    expect(
      loadControllerConfig({ ...dev, RELAY_REGISTRATION_TIMEOUT_MS: "1500" }).relayRegistrationTimeoutMs,
    ).toBe(1_500);
    expect(() =>
      loadControllerConfig({ ...dev, RELAY_REGISTRATION_TIMEOUT_MS: "0" }),
    ).toThrow(/RELAY_REGISTRATION_TIMEOUT_MS|invalid integer/);
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

  describe("guest image pinning follows the provisioner", () => {
    it("accepts a pinned digest with Kubernetes enabled", () => {
      const cfg = loadControllerConfig({
        ...dev,
        KUBERNETES_ENABLED: "true",
        GUEST_IMAGE: "ghcr.io/example/guest:0.1.0",
        GUEST_IMAGE_DIGEST: PINNED,
      });
      expect(cfg.kubeEnabled).toBe(true);
      expect(cfg.guestImageRef).toBe(`ghcr.io/example/guest@${PINNED}`);
    });

    it("rejects the placeholder with Kubernetes enabled, even when insecure dev is on", () => {
      expect(() =>
        loadControllerConfig({
          ...dev,
          KUBERNETES_ENABLED: "true",
          GUEST_IMAGE_DIGEST: PLACEHOLDER,
        }),
      ).toThrow(/pinned sha256.*KUBERNETES_ENABLED/);
    });

    it("does not require a guest digest for a role that never provisions", () => {
      const cfg = loadControllerConfig({
        ...dev,
        ROLE: "relay",
        KUBERNETES_ENABLED: "true",
        GUEST_IMAGE_DIGEST: PLACEHOLDER,
        RELAY_TLS_CERT_FILE: "/tls/tls.crt",
        RELAY_TLS_KEY_FILE: "/tls/tls.key",
        RELAY_TLS_CA_FILE: "/tls/ca.crt",
      });
      expect(cfg.role).toBe("relay");
      expect(cfg.kubeEnabled).toBe(true);
      expect(cfg.guestImageDigest).toBe(PLACEHOLDER);
    });

    it("accepts a pinned digest with the local process provisioner", () => {
      const cfg = loadControllerConfig({
        ...dev,
        KUBERNETES_ENABLED: "false",
        GUEST_IMAGE: "ghcr.io/example/guest:0.1.0",
        GUEST_IMAGE_DIGEST: PINNED,
      });
      expect(cfg.kubeEnabled).toBe(false);
      expect(cfg.guestImageRef).toBe(`ghcr.io/example/guest@${PINNED}`);
    });

    it("accepts the placeholder with the local process provisioner", () => {
      const cfg = loadControllerConfig({
        ...dev,
        KUBERNETES_ENABLED: "false",
        GUEST_IMAGE: "x402-sandbox/guest:dev",
        GUEST_IMAGE_DIGEST: PLACEHOLDER,
      });
      expect(cfg.kubeEnabled).toBe(false);
      expect(cfg.guestImageRef).toBe("x402-sandbox/guest:dev");
    });
  });

  it("rejects a malformed digest even in dev", () => {
    expect(() =>
      loadControllerConfig({ ...dev, GUEST_IMAGE_DIGEST: "sha256:not-a-digest" }),
    ).toThrow(/GUEST_IMAGE_DIGEST/);
  });
});

describe("transport security", () => {
  const files = {
    TLS_CERT_FILE: "/tls/tls.crt",
    TLS_KEY_FILE: "/tls/tls.key",
    TLS_CA_FILE: "/tls/ca.crt",
  };

  it("takes the public listener certificate set as three files or none", () => {
    const cfg = loadControllerConfig({ ...dev, CONTROLLER_TLS_PORT: "8443", ...files });
    expect(cfg.tlsPort).toBe(8_443);
    expect(cfg.tlsCertFile).toBe("/tls/tls.crt");
    expect(cfg.tlsKeyFile).toBe("/tls/tls.key");
    expect(cfg.tlsCaFile).toBe("/tls/ca.crt");
    expect(() => loadControllerConfig({ ...dev, TLS_CERT_FILE: "/tls/tls.crt" })).toThrow(
      "TLS_CERT_FILE, TLS_KEY_FILE and TLS_CA_FILE must be set together",
    );
  });

  it("requires the listener port and the certificate set to agree", () => {
    expect(() => loadControllerConfig({ ...dev, CONTROLLER_TLS_PORT: "8443" })).toThrow(
      "CONTROLLER_TLS_PORT requires TLS_CERT_FILE, TLS_KEY_FILE and TLS_CA_FILE",
    );
    expect(() => loadControllerConfig({ ...dev, ...files })).toThrow(
      "TLS_CERT_FILE/TLS_KEY_FILE/TLS_CA_FILE require CONTROLLER_TLS_PORT",
    );
  });

  it("keeps the prefixes independent", () => {
    const cfg = loadControllerConfig({
      ...dev,
      RELAY_TLS_CERT_FILE: "/relay/tls.crt",
      RELAY_TLS_KEY_FILE: "/relay/tls.key",
      RELAY_TLS_CA_FILE: "/relay/ca.crt",
    });
    expect(cfg.relayTls).toEqual({
      certFile: "/relay/tls.crt",
      keyFile: "/relay/tls.key",
      caFile: "/relay/ca.crt",
    });
    expect(cfg.tlsPort).toBeUndefined();
    expect(cfg.tlsCertFile).toBeUndefined();
  });
});

describe("leader election config", () => {
  const cluster = {
    ...TOKENS,
    DATABASE_URL,
    EXECUTION_MODE: "dev",
    ALLOW_INSECURE_DEV: "true",
    KUBERNETES_ENABLED: "true",
    GUEST_IMAGE_DIGEST: PINNED,
  };

  it("elects a leader in a cluster and takes its identity from the pod name", () => {
    const cfg = loadControllerConfig({ ...cluster, POD_NAME: "controller-abc-1" });
    expect(cfg.leaderElection).toBe(true);
    expect(cfg.leaderIdentity).toBe("controller-abc-1");
    expect(cfg.leaderLeaseName).toBe("controller-leader");
  });

  it("honours LEADER_ELECTION=off as the escape hatch", () => {
    const cfg = loadControllerConfig({ ...cluster, LEADER_ELECTION: "off" });
    expect(cfg.leaderElection).toBe(false);
  });

  it("never elects without an API server to hold the lease", () => {
    // Solo is the only correct answer: there is no Lease object to win.
    const cfg = loadControllerConfig({ ...dev, LEADER_ELECTION: "on" });
    expect(cfg.kubeEnabled).toBe(false);
    expect(cfg.leaderElection).toBe(false);
  });

  it("falls back to the host name when POD_NAME is absent", () => {
    const cfg = loadControllerConfig({ ...cluster });
    expect(cfg.leaderIdentity.length).toBeGreaterThan(0);
    expect(cfg.leaderIdentity).not.toBe("controller-abc-1");
  });
});

describe("store backend selection", () => {
  it("carries the database URL", () => {
    const cfg = loadControllerConfig({
      ...dev,
      DATABASE_URL: "postgres://user:pw@db:5432/sandbox",
    });
    expect(cfg.databaseUrl).toBe("postgres://user:pw@db:5432/sandbox");
  });
});
