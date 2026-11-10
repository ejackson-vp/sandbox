/**
 * Provisioning concurrency cap: the persisted PROVISIONING count alone is
 * stale while concurrent workers are between admission and the state write.
 */
import { describe, expect, it, vi } from "vitest";
import { loadControllerConfig } from "../../controller/src/config.js";
import type { Provisioner } from "../../controller/src/k8s.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import { Provisioning } from "../../controller/src/provisioning.js";
import type { SessionRecord, Store } from "../../controller/src/store.js";
import type { WarmPool } from "../../controller/src/warm-pool.js";

function session(id: string): SessionRecord {
  return {
    id,
    state: "PAID",
    paidAt: Date.now(),
    timingsJson: null,
  } as unknown as SessionRecord;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function harness() {
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
    MAX_CONCURRENT_PROVISIONING: "1",
  });
  const gate = deferred();
  const mergeTimings = vi.fn();
  const requestTermination = vi.fn();
  const store = {
    listNonTerminal: () => [],
    mergeTimings,
    requestTermination,
  } as unknown as Store;
  const relay = {
    isReady: async () => {
      await gate.promise;
      return false;
    },
  } as unknown as RelayClient;
  const provisioning = new Provisioning(
    {
      cfg,
      store,
      provisioner: {} as Provisioner,
      relay,
      capacity: {} as never,
      snapshotter: {} as never,
      now: () => Date.now(),
      serviceAddress: async () => null,
    },
    {} as WarmPool,
  );
  return { provisioning, mergeTimings, gate };
}

describe("provisioning slot cap", () => {
  it("holds the second provision while the first is in flight", async () => {
    const { provisioning, mergeTimings, gate } = harness();

    const first = provisioning.provision(session("sbx_first"));
    // The first call is parked in relay.isReady and holds the only slot.
    await expect(
      Promise.race([
        provisioning.provision(session("sbx_second")),
        new Promise((_, reject) => setTimeout(() => reject(new Error("second provision did not defer")), 500)),
      ]),
    ).resolves.toBeUndefined();

    expect(mergeTimings).toHaveBeenCalledWith(
      "sbx_second",
      expect.objectContaining({ provisionQueueEnteredAt: expect.any(Number) }),
    );

    gate.resolve();
    await first;
  });
});
