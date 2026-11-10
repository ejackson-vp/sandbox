import { describe, expect, it, vi } from "vitest";
import { loadControllerConfig } from "../../controller/src/config.js";
import type { Provisioner } from "../../controller/src/k8s.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import { Provisioning } from "../../controller/src/provisioning.js";
import type { SessionRecord, Store } from "../../controller/src/store.js";
import type { WarmPool } from "../../controller/src/warm-pool.js";

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
  it("re-resolves the relay after registration before creating the pod", async () => {
    const cfg = loadControllerConfig({
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

    let relayAddress = { host: "10.0.0.1", port: 8443 };
    const serviceAddress = vi.fn(async (name: string) => {
      if (name === cfg.relayServiceName) return relayAddress;
      return { host: "10.0.0.9", port: 3128 };
    });
    const registerCurrent = vi.fn(async () => {
      // Simulate a relay replacement accepted by the registration retry loop.
      relayAddress = { host: "10.0.0.2", port: 8443 };
      return { generation: "new", attempts: 2 };
    });
    const createPod = vi.fn(async (spec: { relayUrl: string }) => ({ podName: "sbx-pod", relayUrl: spec.relayUrl }));
    const store = {
      mergeTimings: vi.fn(),
      setRelayToken: vi.fn(),
    } as unknown as Store;
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
      },
      {} as WarmPool,
    );

    await provisioning.createPod(
      session(),
      { host: "10.0.0.1", port: 8443 },
      { host: "10.0.0.9", port: 3128 },
    );

    expect(registerCurrent).toHaveBeenCalledTimes(1);
    expect(createPod).toHaveBeenCalledTimes(1);
    expect(createPod.mock.calls[0]![0].relayUrl).toBe("ws://10.0.0.2:8443/guest?session=sbx_relay_endpoint");
    expect(serviceAddress).toHaveBeenCalledWith(cfg.relayServiceName);
  });
});
