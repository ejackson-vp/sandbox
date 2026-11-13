import { describe, expect, it, vi } from "vitest";
import { loadControllerConfig } from "../../controller/src/config.js";
import type { Provisioner } from "../../controller/src/k8s.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import { Provisioning } from "../../controller/src/provisioning.js";
import type { SessionRecord } from "../../controller/src/store/models.js";
import type { PostgresStore } from "../../controller/src/store/postgres/store.js";
import type { WarmPoolManager } from "../../controller/src/warm-pool-manager.js";
import { testDatabaseUrl } from "../helpers/test-store.js";

function session(): SessionRecord {
  return {
    id: "sbx_relay_endpoint",
    state: "PAID",
    durationSeconds: 300,
    limits: {
      cpuMillis: 500,
      memoryMiB: 512,
      diskMiB: 256,
      maxOutputBytes: 1_048_576,
      maxFileBytes: 1_048_576,
      maxCommandSeconds: 300,
      maxProcesses: 64,
    },
    clientPublicKey: "client-key",
    clientNonce: "client-nonce",
    paidAt: Date.now(),
    timingsJson: null,
  } as unknown as SessionRecord;
}

describe("provisioning relay endpoint", () => {
  it("gives the guest the stable ClusterIP, not the relay Pod IP that changes on replacement", async () => {
    const cfg = loadControllerConfig({
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

    // The relay replacement moves the ready endpoint IP. The guest URL must not
    // follow it: that is exactly what stranded every session on a dead address
    // when the relay Pod was replaced.
    let podIp = "10.0.0.1";
    const serviceAddress = vi.fn(async () => ({ host: podIp, port: 8443 }));
    const stableServiceAddress = vi.fn(async () => ({ host: "10.96.0.7", port: 8443 }));
    const registerCurrent = vi.fn(async () => {
      podIp = "10.0.0.2";
      return { generation: "new", attempts: 2 };
    });
    const createPod = vi.fn(async (spec: { relayUrl: string }) => ({
      podName: "sbx-pod",
      relayUrl: spec.relayUrl,
    }));
    const store = {
      mergeTimings: vi.fn(),
      setRelayToken: vi.fn(),
    } as unknown as PostgresStore;
    const relay = { registerCurrent } as unknown as RelayClient;
    const provisioner = { createPod } as unknown as Provisioner;

    const provisioning = new Provisioning(
      {
        cfg,
        store,
        provisioner,
        relay,
        capacity: {} as never,
        snapshotter: {} as never,
        now: () => Date.now(),
        serviceAddress,
        stableServiceAddress,
      },
      {} as WarmPoolManager,
    );

    await provisioning.createPod(
      session(),
      { host: "10.0.0.1", port: 8443 },
      { host: "10.0.0.9", port: 3128 },
    );

    expect(registerCurrent).toHaveBeenCalledTimes(1);
    expect(createPod).toHaveBeenCalledTimes(1);
    expect(createPod.mock.calls[0]?.[0].relayUrl).toBe(
      "ws://10.96.0.7:8443/guest?session=sbx_relay_endpoint",
    );
    // The guest-facing address is the ClusterIP resolver; the endpoint lookup
    // (which returned the new Pod IP) is not what the URL follows.
    expect(stableServiceAddress).toHaveBeenCalledWith(cfg.relayServiceName);
    expect(serviceAddress).not.toHaveBeenCalled();
  });

  it("falls back to the caller's stable address when the Service read races", async () => {
    const cfg = loadControllerConfig({
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
    const createPod = vi.fn(async (_spec: { relayUrl: string }) => ({ podName: "sbx-pod" }));
    const serviceAddress = vi.fn(async () => ({ host: "10.0.0.1", port: 8443 }));
    const provisioning = new Provisioning(
      {
        cfg,
        store: { mergeTimings: vi.fn(), setRelayToken: vi.fn() } as unknown as PostgresStore,
        provisioner: { createPod } as unknown as Provisioner,
        relay: {
          registerCurrent: vi.fn(async () => ({ generation: "g", attempts: 1 })),
        } as unknown as RelayClient,
        capacity: {} as never,
        snapshotter: {} as never,
        now: () => Date.now(),
        serviceAddress,
        // A transient 404 on the Service read. The caller already resolved the
        // same Service's ClusterIP for the create, so that fallback is used.
        stableServiceAddress: vi.fn(async () => null),
      },
      {} as WarmPoolManager,
    );

    await provisioning.createPod(
      session(),
      { host: "10.96.0.7", port: 8443 },
      { host: "10.0.0.9", port: 3128 },
    );

    expect(createPod.mock.calls[0]![0].relayUrl).toBe(
      "ws://10.96.0.7:8443/guest?session=sbx_relay_endpoint",
    );
    // The endpoint Pod IP is never consulted for a guest URL, even as a
    // fallback.
    expect(serviceAddress).not.toHaveBeenCalled();
  });
});
