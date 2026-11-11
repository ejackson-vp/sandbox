import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../controller/src/store.js";
import { CapacityService } from "../../controller/src/capacity/service.js";
import { loadControllerConfig } from "../../controller/src/config.js";
import type { Provisioner } from "../../controller/src/k8s.js";
import type { CapacitySnapshot } from "../../controller/src/capacity/types.js";

const MiB = 1024 * 1024;
const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "x402-faults-"));
  dirs.push(dir);
  const store = new Store(join(dir, "controller.db"));
  stores.push(store);
  return store;
}

function node(): CapacitySnapshot["nodes"][number] {
  return {
    id: "node-a",
    allocatable: { cpuMillicores: 1_000, memoryBytes: 1_024 * MiB, storageBytes: 10_240 * MiB },
    platformOverhead: { cpuMillicores: 0, memoryBytes: 0, storageBytes: 0 },
    labels: { "x402.io/sandbox-pool": "true" },
    taints: [],
    ready: true,
    schedulable: true,
  };
}

function snapshot(): CapacitySnapshot {
  return { nodes: [node()], reservations: [], now: Date.now(), accounting: "baseline" };
}

const request = {
  baseline: { cpuMillicores: 100, memoryBytes: 128 * MiB, storageBytes: 256 * MiB },
  peak: { cpuMillicores: 500, memoryBytes: 512 * MiB, storageBytes: 256 * MiB },
};

describe("reservation fault recovery", () => {
  it("persists a hold across a controller restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-restart-"));
    dirs.push(dir);
    const dbPath = join(dir, "controller.db");
    const first = new Store(dbPath);
    expect((await first.reservations.admit(snapshot(), request, {
      paymentKey: "a".repeat(64),
      specHash: "a".repeat(64),
      ttlMs: 60_000,
    })).admitted).toBe(true);
    first.close();

    const second = new Store(dbPath);
    stores.push(second);
    expect((await second.reservations.getByPayment("a".repeat(64)))?.state).toBe("HELD");
    expect((await second.reservations.attachToSession(
      snapshot(),
      request,
      "a".repeat(64),
      "sbx_restart",
      "a".repeat(64),
    )).admitted).toBe(true);
  });

  it("does not release RELEASING capacity while the Pod still exists", async () => {
    const store = freshStore();
    let pod: { phase: string; deleted: boolean } | null = { phase: "Running", deleted: false };
    const fake = {
      async listNodes() {
        return [{
          name: "node-a",
          allocatableCpuMillis: 1_000,
          allocatableMemoryBytes: 1_024 * MiB,
          allocatableStorageBytes: 10_240 * MiB,
          labels: { "x402.io/sandbox-pool": "true" },
          taints: [],
          ready: true,
          schedulable: true,
        }];
      },
      async listWarmPods() {
        return [];
      },
      async getPod() {
        return pod;
      },
    } as unknown as Provisioner;
    const cfg = loadControllerConfig({
      ADMIN_TOKEN: "a".repeat(24),
      RELAY_ADMIN_TOKEN: "r".repeat(24),
      WAKE_TOKEN: "w".repeat(24),
      PROXY_TOKEN_SECRET: "p".repeat(24),
      EXECUTION_MODE: "dev",
      ALLOW_INSECURE_DEV: "true",
      KUBERNETES_ENABLED: "false",
    });
    const capacity = new CapacityService({ cfg, store, provisioner: fake });

    expect((await store.reservations.admit(snapshot(), request, {
      sessionId: "sbx_db_fail",
      state: "ALLOCATED",
    })).admitted).toBe(true);
    await store.reservations.updatePod("sbx_db_fail", "pod-1");
    expect(await store.reservations.beginRelease("sbx_db_fail", "pod-1")).toBe(true);

    await capacity.reap();
    expect((await store.reservations.getBySession("sbx_db_fail"))?.state).toBe("RELEASING");
    pod = null;
    await capacity.reap();
    expect((await store.reservations.getBySession("sbx_db_fail"))?.state).toBe("RELEASED");
  });

  it("keeps a held reservation available until its TTL expires", async () => {
    const store = freshStore();
    const now = Date.now();
    expect((await store.reservations.admit(snapshot(), request, {
      paymentKey: "b".repeat(64),
      specHash: "b".repeat(64),
      ttlMs: 10_000,
    })).admitted).toBe(true);
    expect(await store.reservations.reapExpiredHolds(now + 5_000)).toBe(0);
    expect((await store.reservations.getByPayment("b".repeat(64)))?.state).toBe("HELD");
    expect(await store.reservations.reapExpiredHolds(now + 11_000)).toBe(1);
    expect((await store.reservations.getByPayment("b".repeat(64)))?.state).toBe("RELEASED");
  });
});
