import { describe, expect, it, vi } from "vitest";
import { loadControllerConfig } from "../../controller/src/config.js";
import type { Provisioner } from "../../controller/src/k8s.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import { Provisioning } from "../../controller/src/provisioning.js";
import type { SessionRecord, Store } from "../../controller/src/store.js";
import type { WarmPoolManager } from "../../controller/src/warm-pool-manager.js";

function config() {
  return loadControllerConfig({
    ADMIN_TOKEN: "p".repeat(24),
    ROLE: "all",
    EXECUTION_MODE: "dev",
    ALLOW_INSECURE_DEV: "true",
    KUBERNETES_ENABLED: "false",
    DB_PATH: ":memory:",
    RELAY_ADMIN_TOKEN: "r".repeat(24),
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "proxy-secret-0123456789",
  });
}

function session(): SessionRecord {
  return {
    id: "sbx_ready",
    state: "PROVISIONING",
    durationSeconds: 300,
    relayTokenHash: "token-hash",
    clientPublicKey: "client-key",
    clientNonce: "client-nonce",
    paidAt: Date.now(),
    timingsJson: null,
  } as unknown as SessionRecord;
}

const attestation = {
  sessionId: "sbx_ready",
  guestPublicKey: "guest-pk",
  evidenceType: "kata-dev-no-hw-attestation",
  issuedAt: 0,
  signature: "sig",
};

function harness(state: ReturnType<typeof vi.fn>, registerCurrent = vi.fn()) {
  const store = {
    setReady: vi.fn(() => true),
    mergeTimings: vi.fn(),
    requestTermination: vi.fn(),
  } as unknown as Store;
  const relay = {
    state,
    registerCurrent,
    // Readiness must not probe health around the snapshot: that was two extra
    // mTLS round trips per pass.
    health: vi.fn(async () => {
      throw new Error("readiness must not call health()");
    }),
    claim: vi.fn(),
    purge: vi.fn(),
  } as unknown as RelayClient;
  const provisioning = new Provisioning(
    {
      cfg: config(),
      store,
      provisioner: { getPod: vi.fn(async () => null) } as unknown as Provisioner,
      relay,
      capacity: {} as never,
      snapshotter: {} as never,
      now: () => Date.now(),
      serviceAddress: vi.fn(async () => ({ host: "10.0.0.1", port: 8443 })),
    },
    {} as WarmPoolManager,
  );
  return { provisioning, store, relay };
}

describe("provisioning readiness generation", () => {
  it("marks ready from one state snapshot and one reused connection", async () => {
    const state = vi.fn(async () => ({
      registered: true,
      connected: true,
      attestation,
      pending: 0,
      generation: "relay-a",
    }));
    const { provisioning, store, relay } = harness(state);

    await provisioning.awaitReady(session());

    expect(store.setReady).toHaveBeenCalledTimes(1);
    expect(state).toHaveBeenCalledTimes(1);
    expect(state).toHaveBeenCalledWith("sbx_ready", { reuse: true });
    expect(relay.health).not.toHaveBeenCalled();
  });

  it("refuses to mark ready when the snapshot came from another generation", async () => {
    const state = vi
      .fn()
      .mockResolvedValueOnce({
        registered: false,
        connected: false,
        pending: 0,
        generation: "relay-a",
      })
      .mockResolvedValue({
        registered: true,
        connected: true,
        attestation,
        pending: 0,
        generation: "relay-b",
      });
    const registerCurrent = vi.fn(async () => ({ generation: "relay-a", attempts: 1 }));
    const { provisioning, store } = harness(state, registerCurrent);

    await provisioning.awaitReady(session());

    expect(registerCurrent).toHaveBeenCalledTimes(1);
    expect(store.setReady).not.toHaveBeenCalled();
  });

  it("retries on a fresh connection when the pooled snapshot is stale", async () => {
    const state = vi
      .fn()
      .mockResolvedValueOnce({
        registered: false,
        connected: false,
        pending: 0,
        generation: "relay-a",
      })
      // The pooled socket is still pinned to the relay being replaced.
      .mockResolvedValueOnce({
        registered: true,
        connected: true,
        attestation,
        pending: 0,
        generation: "relay-b",
      })
      .mockResolvedValue({
        registered: true,
        connected: true,
        attestation,
        pending: 0,
        generation: "relay-a",
      });
    const registerCurrent = vi.fn(async () => ({ generation: "relay-a", attempts: 1 }));
    const { provisioning, store } = harness(state, registerCurrent);

    await provisioning.awaitReady(session());

    expect(state).toHaveBeenCalledTimes(3);
    expect(state.mock.calls[1]![1]).toEqual({ reuse: true });
    expect(state.mock.calls[2]![1]).toBeUndefined();
    expect(store.setReady).toHaveBeenCalledTimes(1);
  });
});
