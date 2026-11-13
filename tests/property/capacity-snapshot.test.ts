/**
 * Snapshot construction invariants.
 *
 * The builder is the only place Kubernetes observations and durable rows become
 * the immutable input the pure model decides on. Three rules there are easy to
 * get wrong and expensive when they are:
 *
 *   1. platform overhead is withheld once per node, not once per session. It is
 *      a node-level constant in the snapshot, so no reservation count can
 *      multiply it;
 *   2. a live warm pod contributes exactly one reservation. The pool is counted
 *      from the actual Kubernetes list, never from a parallel counter, so a
 *      doubled row would reserve the same pod twice on the same node;
 *   3. the node read is cached for a second while reservations are re-read every
 *      time. Caching reservations would admit against a stale set; caching nodes
 *      for longer than the cache window would hide a cordon.
 *
 * The properties below hold over arbitrary nodes, pods and active rows. They do
 * not re-assert the admission arithmetic (tests/property/capacity.test.ts does
 * that); they assert the shape that arithmetic is given.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { CapacitySnapshotBuilder } from "../../controller/src/capacity/snapshot.js";
import { requestForLimits } from "../../controller/src/capacity/types.js";
import type { ReservationRecord, ReservationStore } from "../../controller/src/capacity/reservation-store.js";
import type { NodeInfo, Provisioner, WarmPodInfo } from "../../controller/src/k8s.js";
import { controllerConfig } from "../helpers/controller-config.js";

const MiB = 1024 * 1024;

const nodeArb: fc.Arbitrary<NodeInfo> = fc.record({
  name: fc.string({ minLength: 1, maxLength: 10 }),
  allocatableCpuMillis: fc.integer({ min: 0, max: 64_000 }),
  allocatableMemoryBytes: fc.integer({ min: 0, max: 64_000 }).map((value) => value * MiB),
  allocatableStorageBytes: fc.integer({ min: 0, max: 64_000 }).map((value) => value * MiB),
  labels: fc.constant({ "x402.io/sandbox-pool": "true" }),
  taints: fc.constant([]),
  ready: fc.boolean(),
  schedulable: fc.boolean(),
});

/** One node, when a property is about something other than node variety. */
function sampleNode(name = "node-a"): NodeInfo {
  return {
    name,
    allocatableCpuMillis: 8_000,
    allocatableMemoryBytes: 8_192 * MiB,
    allocatableStorageBytes: 20_480 * MiB,
    labels: { "x402.io/sandbox-pool": "true" },
    taints: [],
    ready: true,
    schedulable: true,
  };
}

const warmPodArb: fc.Arbitrary<WarmPodInfo> = fc.record({
  name: fc.string({ minLength: 1, maxLength: 12 }),
  warmId: fc.string({ minLength: 1, maxLength: 12 }),
  poolId: fc.string({ minLength: 1, maxLength: 16 }),
  createdAt: fc.integer({ min: 0, max: 10 ** 6 }),
  phase: fc.constantFrom("Running", "Pending", "Succeeded", "Failed"),
  runtime: fc.constant("base"),
  identity: fc.string(),
  imageDigest: fc.string(),
  nodeName: fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: undefined }),
});

function snapshotHarness(options: {
  env?: NodeJS.ProcessEnv;
  nodes?: NodeInfo[];
  active?: ReservationRecord[];
  warmPods?: WarmPodInfo[] | Error;
  clock?: { now: number };
}) {
  const cfg = controllerConfig(options.env);
  const clock = options.clock ?? { now: 1_000_000 };
  const nodes = options.nodes ?? [];
  const active = options.active ?? [];
  const warmPods = options.warmPods ?? [];
  let nodeReads = 0;
  let warmReads = 0;
  const provisioner = {
    listNodes: async () => {
      nodeReads += 1;
      return nodes;
    },
    listWarmPods: async () => {
      warmReads += 1;
      if (warmPods instanceof Error) throw warmPods;
      return warmPods;
    },
  } as unknown as Provisioner;
  const reservations = {
    listActive: async () => active,
  } as unknown as ReservationStore;
  const builder = new CapacitySnapshotBuilder(cfg, reservations, provisioner);
  return {
    builder,
    cfg,
    clock,
    nodes,
    active,
    warmPods,
    nodeReads: () => nodeReads,
    warmReads: () => warmReads,
  };
}

/** A live reservation row; only the fields the snapshot copies matter here. */
function reservation(id: string, nodeId: string): ReservationRecord {
  return {
    id,
    paymentKey: null,
    sessionId: null,
    specHash: null,
    nodeId,
    podName: null,
    state: "ALLOCATED",
    baseline: { cpuMillicores: 100, memoryBytes: 64 * MiB, storageBytes: 256 * MiB },
    peak: { cpuMillicores: 400, memoryBytes: 256 * MiB, storageBytes: 256 * MiB },
    expiresAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("node capacity is a per-node observation", () => {
  it("withholds the configured overhead on every node and never scales it with reservations", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(nodeArb, { maxLength: 6 }),
        fc.integer({ min: 0, max: 32_000 }),
        fc.integer({ min: 0, max: 32_000 }),
        async (nodes, cpuOverride, memoryOverride) => {
          const h = snapshotHarness({
            env: {
              CAPACITY_NODE_CPU_MILLICORES: String(cpuOverride),
              CAPACITY_NODE_MEMORY_MIB: String(memoryOverride),
            },
            nodes,
          });
          const mapped = await h.builder.loadNodes(h.clock.now);
          const overhead = {
            cpuMillicores: h.cfg.capacityPlatformOverhead.cpuMillicores,
            memoryBytes: h.cfg.capacityPlatformOverhead.memoryMiB * MiB,
            storageBytes: h.cfg.capacityPlatformOverhead.storageMiB * MiB,
          };
          expect(mapped).toHaveLength(nodes.length);
          for (const [index, node] of mapped.entries()) {
            const raw = nodes[index]!;
            expect(node.id).toBe(raw.name);
            expect(node.labels).toEqual(raw.labels);
            expect(node.taints).toEqual(raw.taints);
            expect(node.ready).toBe(raw.ready);
            expect(node.schedulable).toBe(raw.schedulable);
            // Identical on every node, whatever the reservation count.
            expect(node.platformOverhead).toEqual(overhead);
            expect(node.allocatable.cpuMillicores).toBe(
              cpuOverride > 0
                ? Math.min(raw.allocatableCpuMillis, cpuOverride)
                : raw.allocatableCpuMillis,
            );
            expect(node.allocatable.memoryBytes).toBe(
              memoryOverride > 0
                ? Math.min(raw.allocatableMemoryBytes, memoryOverride * MiB)
                : raw.allocatableMemoryBytes,
            );
            // Storage has no override: the node's own allocatable is the truth.
            expect(node.allocatable.storageBytes).toBe(raw.allocatableStorageBytes);
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it("serves a node read from cache inside a second and re-reads after it", async () => {
    const clock = { now: 1_000_000 };
    const h = snapshotHarness({ nodes: [sampleNode()], clock });
    // Prime the cache.
    await h.builder.loadNodes(clock.now);
    expect(h.nodeReads()).toBe(1);
    clock.now += 999;
    await h.builder.loadNodes(clock.now);
    expect(h.nodeReads()).toBe(1);
    clock.now += 1;
    await h.builder.loadNodes(clock.now);
    expect(h.nodeReads()).toBe(2);
  });

  it("treats disabled capacity as one synthetic node and never lists a cluster node", async () => {
    const h = snapshotHarness({
      env: { CAPACITY_ENABLED: "false" },
      nodes: [sampleNode()],
    });
    const mapped = await h.builder.loadNodes(h.clock.now);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]!.platformOverhead).toEqual({ cpuMillicores: 0, memoryBytes: 0, storageBytes: 0 });
    expect(mapped[0]!.ready).toBe(true);
    expect(mapped[0]!.schedulable).toBe(true);
    expect(h.nodeReads()).toBe(0);
  });
});

describe("warm pods are reservations read from the namespace", () => {
  it("adds exactly one reservation per live warm pod, and none for terminal pods", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(warmPodArb, { maxLength: 10 }),
        fc.array(nodeArb, { minLength: 1, maxLength: 4 }),
        async (pods, nodes) => {
          const h = snapshotHarness({
            env: { WARM_POOL_SIZE: "4", WARM_POOL_TIER: "short" },
            nodes,
            warmPods: pods,
            active: [reservation("durable-1", nodes[0]!.name)],
          });
          const snapshot = await h.builder.snapshotWithWarm();
          const live = pods.filter((pod) => pod.phase !== "Succeeded" && pod.phase !== "Failed");
          expect(snapshot.reservations).toHaveLength(1 + live.length);

          const warm = snapshot.reservations.slice(1);
          expect(warm.map((row) => row.id)).toEqual(live.map((pod) => `warm_${pod.warmId}`));
          const tier = h.cfg.tiers[h.cfg.warmPoolTier];
          const request = requestForLimits({
            cpuMillis: tier.cpuMillis,
            memoryMiB: tier.memoryMiB,
            diskMiB: tier.diskMiB,
          });
          for (const [index, row] of warm.entries()) {
            const pod = live[index]!;
            expect(row.state).toBe("ALLOCATED");
            expect(row.nodeId).toBe(pod.nodeName ?? nodes[0]!.name);
            expect(row.baseline).toEqual(request.baseline);
            expect(row.peak).toEqual(request.peak);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it("adds no warm reservation when the pool is off, even with pods left behind", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(warmPodArb, { minLength: 1, maxLength: 6 }), async (pods) => {
        const h = snapshotHarness({
          env: { WARM_POOL_SIZE: "0" },
          nodes: [sampleNode()],
          warmPods: pods,
        });
        const snapshot = await h.builder.snapshotWithWarm();
        expect(snapshot.reservations).toHaveLength(0);
        // Pool off means the listing is not even needed.
        expect(h.warmReads()).toBe(0);
      }),
      { numRuns: 20 },
    );
  });

  it("treats a failed warm listing as no warm pods, never as a failed snapshot", async () => {
    const h = snapshotHarness({
      env: { WARM_POOL_SIZE: "4" },
      nodes: [sampleNode()],
      warmPods: new Error("apiserver said no"),
    });
    const snapshot = await h.builder.snapshotWithWarm();
    expect(snapshot.reservations).toEqual([]);
  });
});
