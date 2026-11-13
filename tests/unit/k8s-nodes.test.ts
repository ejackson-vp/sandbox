/**
 * Node capacity mapping.
 *
 * Kubernetes schedules, this module only reports: a wrong number here makes the
 * admission model admit one pod too many, and a thrown error takes the whole
 * capacity read with it. Quantities arrive as Kubernetes strings ("3800m",
 * "16Gi") and the mapping has to degrade to zero rather than NaN, because a NaN
 * propagates silently through every sum that follows.
 *
 * The fake apiserver answers `GET /api/v1/nodes` and nothing else, so these
 * tests see the same JSON the client parses in production.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as k8s from "@kubernetes/client-node";
import { listNodes } from "../../controller/src/k8s-nodes.js";
import { FakeApiServer } from "../helpers/fake-apiserver.js";

const servers: FakeApiServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function fakeApi(): Promise<FakeApiServer> {
  const api = await FakeApiServer.start();
  servers.push(api);
  return api;
}

function nodesFor(api: FakeApiServer): ReturnType<typeof listNodes> {
  return listNodes(api.kubeConfig().makeApiClient(k8s.CoreV1Api));
}

describe("listNodes", () => {
  it("maps a ready node's allocatable quantities and labels", async () => {
    const api = await fakeApi();
    api.seedNode({
      metadata: { name: "pool-a", labels: { "x402.io/sandbox-pool": "true" } },
      spec: {},
      status: {
        conditions: [
          { type: "MemoryPressure", status: "False" },
          { type: "Ready", status: "True" },
        ],
        allocatable: {
          cpu: "3800m",
          memory: "16Gi",
          "ephemeral-storage": "100Gi",
        },
      },
    });

    await expect(nodesFor(api)).resolves.toEqual([
      {
        name: "pool-a",
        allocatableCpuMillis: 3800,
        allocatableMemoryBytes: 16 * 1024 ** 3,
        allocatableStorageBytes: 100 * 1024 ** 3,
        labels: { "x402.io/sandbox-pool": "true" },
        taints: [],
        ready: true,
        schedulable: true,
      },
    ]);

    expect(api.calls("GET", /^\/api\/v1\/nodes$/)).toHaveLength(1);
  });

  it("reads a whole-core CPU quantity as millicores", async () => {
    const api = await fakeApi();
    api.seedNode({
      metadata: { name: "pool-b" },
      spec: {},
      status: {
        conditions: [{ type: "Ready", status: "True" }],
        allocatable: { cpu: "4", memory: "512Mi", "ephemeral-storage": "20G" },
      },
    });

    const [node] = await nodesFor(api);
    expect(node?.allocatableCpuMillis).toBe(4000);
    expect(node?.allocatableMemoryBytes).toBe(512 * 1024 ** 2);
    // `G` is decimal, `Gi` is binary. Reading them as the same number would
    // over-report storage on a node that only has the SI quantity.
    expect(node?.allocatableStorageBytes).toBe(20 * 1000 ** 3);
  });

  it("reports a cordoned, unready node with its taints", async () => {
    const api = await fakeApi();
    api.seedNode({
      metadata: { name: "pool-c" },
      spec: {
        unschedulable: true,
        taints: [
          { key: "x402.io/sandbox", effect: "NoSchedule" },
          { key: "node.kubernetes.io/unreachable" },
        ],
      },
      status: {
        conditions: [{ type: "Ready", status: "False" }],
        allocatable: { cpu: "2000m", memory: "8Gi" },
      },
    });

    const [node] = await nodesFor(api);
    expect(node?.ready).toBe(false);
    expect(node?.schedulable).toBe(false);
    expect(node?.taints).toEqual([
      { key: "x402.io/sandbox", effect: "NoSchedule" },
      // A taint with no effect is NoSchedule in the API, not a missing value:
      // the capacity model has to assume it repels pods.
      { key: "node.kubernetes.io/unreachable", effect: "NoSchedule" },
    ]);
    // No ephemeral-storage quantity: zero, not NaN and not a missing field.
    expect(node?.allocatableStorageBytes).toBe(0);
  });

  it("treats a node with no status as unready with zero capacity", async () => {
    const api = await fakeApi();
    api.seedNode({ metadata: { name: "pool-d" } });

    await expect(nodesFor(api)).resolves.toEqual([
      {
        name: "pool-d",
        allocatableCpuMillis: 0,
        allocatableMemoryBytes: 0,
        allocatableStorageBytes: 0,
        labels: {},
        taints: [],
        ready: false,
        schedulable: true,
      },
    ]);
  });

  it("zeroes a quantity it cannot parse instead of admitting NaN", async () => {
    const api = await fakeApi();
    api.seedNode({
      metadata: { name: "pool-e" },
      spec: {},
      status: {
        conditions: [{ type: "Ready", status: "True" }],
        allocatable: { cpu: "lots", memory: "12Xi", "ephemeral-storage": "-1Gi" },
      },
    });

    await expect(nodesFor(api)).resolves.toMatchObject([
      {
        name: "pool-e",
        allocatableCpuMillis: 0,
        allocatableMemoryBytes: 0,
        allocatableStorageBytes: 0,
        ready: true,
      },
    ]);
  });
});
