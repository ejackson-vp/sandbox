import { describe, expect, it, vi } from "vitest";
import { loadControllerConfig } from "../../controller/src/config.js";
import type { Provisioner } from "../../controller/src/k8s.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import { Provisioning } from "../../controller/src/provisioning.js";
import type { SessionRecord } from "../../controller/src/store/models.js";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import type { WarmPoolManager } from "../../controller/src/warm-pool-manager.js";
import { testDatabaseUrl } from "../helpers/test-store.js";

function config() {
  return loadControllerConfig({
    ADMIN_TOKEN: "p".repeat(24),
    ROLE: "all",
    EXECUTION_MODE: "dev",
    ALLOW_INSECURE_DEV: "true",
    KUBERNETES_ENABLED: "false",
    DATABASE_URL: testDatabaseUrl(),
    RELAY_ADMIN_TOKEN: "r".repeat(24),
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "proxy-secret-0123456789",
  });
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "sbx_ready",
    state: "PROVISIONING",
    durationSeconds: 300,
    createdAt: Date.now(),
    maxLifetimeSeconds: null,
    relayTokenHash: "token-hash",
    clientPublicKey: "client-key",
    clientNonce: "client-nonce",
    paidAt: Date.now(),
    timingsJson: null,
    ...overrides,
  } as unknown as SessionRecord;
}

const attestation = {
  sessionId: "sbx_ready",
  guestPublicKey: "guest-pk",
  evidenceType: "kata-dev-no-hw-attestation",
  issuedAt: 0,
  signature: "sig",
};

function harness(
  state: ReturnType<typeof vi.fn>,
  registerCurrent = vi.fn(),
  now: () => number = () => Date.now(),
) {
  const store = {
    setReady: vi.fn(() => true),
    mergeTimings: vi.fn(),
    requestTermination: vi.fn(),
  } as unknown as PostgresStore;
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
      now,
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

  it("clamps the lease to the wall-clock lifetime after a forward clock step", async () => {
    // The clock stepped 70s forward while the pod was booting. Readiness is
    // recorded at the stepped time, so the purchased 60s lease would end at
    // createdAt + 130s while maxLifetimeSeconds terminates the session at
    // createdAt + 120s. Both enforcement paths must agree on the earlier bound.
    const createdAt = 1_700_000_000_000;
    const readyAt = createdAt + 70_000;
    const state = vi.fn(async () => ({
      registered: true,
      connected: true,
      attestation,
      pending: 0,
      generation: "relay-a",
    }));
    const { provisioning, store } = harness(state, vi.fn(), () => readyAt);

    await provisioning.awaitReady(
      session({ createdAt, paidAt: createdAt, durationSeconds: 60, maxLifetimeSeconds: 120 }),
    );

    expect(store.setReady).toHaveBeenCalledTimes(1);
    const calls = (store.setReady as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const [, persistedReadyAt, leaseExpiresAt] = calls[0]!;
    expect(persistedReadyAt).toBe(readyAt);
    expect(leaseExpiresAt).toBe(createdAt + 120_000);
  });

  it("keeps the purchased lease when no clock step happened", async () => {
    const createdAt = 1_700_000_000_000;
    const readyAt = createdAt + 5_000;
    const state = vi.fn(async () => ({
      registered: true,
      connected: true,
      attestation,
      pending: 0,
      generation: "relay-a",
    }));
    const { provisioning, store } = harness(state, vi.fn(), () => readyAt);

    await provisioning.awaitReady(
      session({ createdAt, paidAt: createdAt, durationSeconds: 60, maxLifetimeSeconds: 120 }),
    );

    const calls = (store.setReady as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls[0]![2]).toBe(readyAt + 60_000);
  });
});
