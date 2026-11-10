import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { admitCapacity } from "../../controller/src/capacity/admission.js";
import { availableOnNode, placementCandidates } from "../../controller/src/capacity/placement.js";
import {
  addResources,
  holdsCompute,
  type CapacityReservation,
  type CapacitySnapshot,
  type NodeCapacity,
  type ResourceVector,
  type SandboxResourceRequest,
} from "../../controller/src/capacity/types.js";

const MiB = 1024 * 1024;

const resourceArb = (max: number): fc.Arbitrary<ResourceVector> =>
  fc.record({
    cpuMillicores: fc.integer({ min: 0, max }),
    memoryBytes: fc.integer({ min: 0, max: max * MiB }),
    storageBytes: fc.integer({ min: 0, max: max * MiB }),
  });

const nodeArb: fc.Arbitrary<NodeCapacity> = fc
  .record({
    id: fc.string({ minLength: 1, maxLength: 8 }),
    allocatable: resourceArb(16_000),
    overhead: resourceArb(2_000),
    ready: fc.boolean(),
    schedulable: fc.boolean(),
  })
  .map(({ id, allocatable, overhead, ready, schedulable }) => ({
    id,
    allocatable,
    platformOverhead: {
      cpuMillicores: Math.min(overhead.cpuMillicores, allocatable.cpuMillicores),
      memoryBytes: Math.min(overhead.memoryBytes, allocatable.memoryBytes),
      storageBytes: Math.min(overhead.storageBytes, allocatable.storageBytes),
    },
    labels: { "x402.io/sandbox-pool": "true" },
    taints: [],
    ready,
    schedulable,
  }));

const reservationArb: fc.Arbitrary<CapacityReservation> = fc
  .record({
    id: fc.string({ minLength: 1, maxLength: 8 }),
    nodeId: fc.string({ minLength: 1, maxLength: 8 }),
    state: fc.constantFrom(
      "HELD" as const,
      "ALLOCATED" as const,
      "SUSPENDED" as const,
      "RELEASING" as const,
      "RELEASED" as const,
    ),
    baseline: resourceArb(4_000),
    peak: resourceArb(8_000),
    expiresAt: fc.option(fc.integer({ min: 0, max: 100_000 }), { nil: null }),
    sessionId: fc.option(fc.string(), { nil: null }),
  })
  .map((r) => ({ ...r, id: r.id, nodeId: r.nodeId }));

/**
 * Node names are unique in Kubernetes, so the model must generate unique ids:
 * the eligibility assertions resolve a decision back to a node by id, and a
 * duplicated id would make that lookup ambiguous. Collisions only get a
 * suffix; non-colliding ids stay untouched so independently generated
 * reservation nodeIds still match often enough to exercise accounting.
 */
function uniqueNodeIds(nodes: NodeCapacity[]): NodeCapacity[] {
  const seen = new Set<string>();
  return nodes.map((node) => {
    let id = node.id;
    for (let suffix = 1; seen.has(id); suffix += 1) id = `${node.id}~${suffix}`;
    seen.add(id);
    return { ...node, id };
  });
}

const snapshotArb = (nodes: fc.Arbitrary<NodeCapacity[]>) =>
  fc.record({
    nodes: nodes.map(uniqueNodeIds),
    reservations: fc.array(reservationArb, { maxLength: 20 }),
    now: fc.integer({ min: 0, max: 100_000 }),
    accounting: fc.constantFrom("baseline" as const, "peak" as const),
  });

const requestArb: fc.Arbitrary<SandboxResourceRequest> = fc
  .record({
    baseline: resourceArb(4_000),
    peak: resourceArb(8_000),
    requiredNodeId: fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: null }),
    tolerations: fc.constant(["x402.io/sandbox"]),
  })
  .map((r) => ({
    ...r,
    baseline: {
      cpuMillicores: Math.max(1, r.baseline.cpuMillicores),
      memoryBytes: Math.max(1, r.baseline.memoryBytes),
      storageBytes: Math.max(1, r.baseline.storageBytes),
    },
  }));

describe("pure capacity admission", () => {
  it("always returns a total decision without mutating inputs", () => {
    fc.assert(
      fc.property(snapshotArb(fc.array(nodeArb, { maxLength: 3 })), requestArb, (snapshot, request) => {
        const before = JSON.stringify(snapshot);
        const decision = admitCapacity(snapshot, request);
        expect(decision.admitted === true || decision.admitted === false).toBe(true);
        expect(JSON.stringify(snapshot)).toBe(before);
      }),
      { numRuns: 500 },
    );
  });

  it("never admits a node that is ineligible or violates affinity", () => {
    fc.assert(
      fc.property(snapshotArb(fc.array(nodeArb, { maxLength: 3 })), requestArb, (snapshot, request) => {
        const decision = admitCapacity(snapshot, request);
        if (!decision.admitted) return;
        const node = snapshot.nodes.find((n) => n.id === decision.nodeId);
        expect(node).toBeDefined();
        expect(node!.ready).toBe(true);
        expect(node!.schedulable).toBe(true);
        expect(node!.labels["x402.io/sandbox-pool"]).toBe("true");
        if (request.requiredNodeId) expect(decision.nodeId).toBe(request.requiredNodeId);
      }),
      { numRuns: 500 },
    );
  });

  it("never over-allocates baseline on the selected node", () => {
    fc.assert(
      fc.property(snapshotArb(fc.array(nodeArb, { maxLength: 3 })), requestArb, (snapshot, request) => {
        const decision = admitCapacity(snapshot, request);
        if (!decision.admitted) return;
        const node = snapshot.nodes.find((n) => n.id === decision.nodeId)!;
        const reserved = snapshot.reservations
          .filter((r) => r.nodeId === decision.nodeId && r.state !== "RELEASED")
          .reduce(
            (sum, r) => {
              // Storage is charged from the same accounting vector as compute.
              // A suspended reservation drops CPU/memory but keeps storage.
              const committed = snapshot.accounting === "peak" ? r.peak : r.baseline;
              return addResources(
                sum,
                holdsCompute(r.state)
                  ? committed
                  : {
                      cpuMillicores: 0,
                      memoryBytes: 0,
                      storageBytes: committed.storageBytes,
                    },
              );
            },
            { cpuMillicores: 0, memoryBytes: 0, storageBytes: 0 },
          );
        const need = snapshot.accounting === "peak" ? request.peak : request.baseline;
        const used = addResources(addResources(node.platformOverhead, reserved), need);
        expect(used.cpuMillicores).toBeLessThanOrEqual(node.allocatable.cpuMillicores);
        expect(used.memoryBytes).toBeLessThanOrEqual(node.allocatable.memoryBytes);
        expect(used.storageBytes).toBeLessThanOrEqual(node.allocatable.storageBytes);
      }),
      { numRuns: 500 },
    );
  });

  it("is deterministic and independent of reservation order", () => {
    fc.assert(
      fc.property(snapshotArb(fc.array(nodeArb, { maxLength: 3 })), requestArb, (snapshot, request) => {
        const a = admitCapacity(snapshot, request);
        const b = admitCapacity(
          { ...snapshot, reservations: [...snapshot.reservations].reverse() },
          request,
        );
        expect(a).toEqual(b);
      }),
      { numRuns: 500 },
    );
  });

  it("adding a compute reservation cannot increase available capacity", () => {
    fc.assert(
      fc.property(
        snapshotArb(fc.array(nodeArb, { maxLength: 2 })),
        fc.array(reservationArb, { maxLength: 5 }),
        (snapshot, extra) => {
          const node = snapshot.nodes[0];
          if (!node) return;
          const before = availableOnNode(node, snapshot.reservations, snapshot.now);
          const after = availableOnNode(node, [...snapshot.reservations, ...extra], snapshot.now);
          expect(after.cpuMillicores).toBeLessThanOrEqual(before.cpuMillicores);
          expect(after.memoryBytes).toBeLessThanOrEqual(before.memoryBytes);
          expect(after.storageBytes).toBeLessThanOrEqual(before.storageBytes);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("increasing a request cannot turn a rejection into an admission", () => {
    fc.assert(
      fc.property(snapshotArb(fc.array(nodeArb, { maxLength: 2 })), requestArb, (snapshot, request) => {
        fc.pre(!admitCapacity(snapshot, request).admitted);
        const bigger: SandboxResourceRequest = {
          ...request,
          baseline: addResources(request.baseline, {
            cpuMillicores: 1,
            memoryBytes: 1,
            storageBytes: 1,
          }),
        };
        expect(admitCapacity(snapshot, bigger).admitted).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it("suspended reservations release compute but retain storage", () => {
    fc.assert(
      fc.property(snapshotArb(fc.array(nodeArb, { minLength: 1, maxLength: 1 })), (snapshot) => {
        const node = snapshot.nodes[0]!;
        const base: CapacityReservation = {
          id: "r1",
          sessionId: "s1",
          nodeId: node.id,
          state: "ALLOCATED",
          baseline: { cpuMillicores: 100, memoryBytes: 64 * MiB, storageBytes: 256 * MiB },
          peak: { cpuMillicores: 400, memoryBytes: 256 * MiB, storageBytes: 256 * MiB },
          expiresAt: null,
        };
        const running = availableOnNode(node, [base], snapshot.now);
        const suspended = availableOnNode(node, [{ ...base, state: "SUSPENDED" }], snapshot.now);
        expect(suspended.cpuMillicores).toBeGreaterThanOrEqual(running.cpuMillicores);
        expect(suspended.memoryBytes).toBeGreaterThanOrEqual(running.memoryBytes);
        expect(suspended.storageBytes).toBe(running.storageBytes);
      }),
      { numRuns: 300 },
    );
  });

  it("respects node affinity and reports a retryable rejection", () => {
    fc.assert(
      fc.property(snapshotArb(fc.array(nodeArb, { minLength: 1, maxLength: 3 })), (snapshot) => {
        const decision = admitCapacity(snapshot, {
          baseline: { cpuMillicores: 10, memoryBytes: MiB, storageBytes: MiB },
          peak: { cpuMillicores: 20, memoryBytes: 2 * MiB, storageBytes: MiB },
          requiredNodeId: "does-not-exist",
        });
        expect(decision.admitted).toBe(false);
        if (!decision.admitted) {
          expect(decision.reason).toBe("node_affinity_unavailable");
          expect(decision.retryable).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("peak accounting rejects when baseline accounting admits", () => {
    const node: NodeCapacity = {
      id: "node",
      allocatable: { cpuMillicores: 1_000, memoryBytes: 512 * MiB, storageBytes: 10_240 * MiB },
      platformOverhead: { cpuMillicores: 0, memoryBytes: 0, storageBytes: 0 },
      labels: { "x402.io/sandbox-pool": "true" },
      taints: [],
      ready: true,
      schedulable: true,
    };
    const request: SandboxResourceRequest = {
      baseline: { cpuMillicores: 100, memoryBytes: 128 * MiB, storageBytes: 256 * MiB },
      peak: { cpuMillicores: 1_000, memoryBytes: 513 * MiB, storageBytes: 256 * MiB },
    };
    expect(admitCapacity({ nodes: [node], reservations: [], now: 0, accounting: "baseline" }, request).admitted).toBe(true);
    expect(admitCapacity({ nodes: [node], reservations: [], now: 0, accounting: "peak" }, request).admitted).toBe(false);
  });

  it("rejects a peak request that would over-allocate storage by one byte (seed 1935550885)", () => {
    // Regression for issue #68. fast-check seed 1935550885 shrank to this case:
    // the existing HELD reservation reserves 1 byte of peak storage while its
    // baseline storage is 0. Admission charged baseline storage for existing
    // reservations but peak storage for the request, so it admitted the full
    // allocatable storage on top of the reserved byte (5478233296 > 5478233295).
    const node: NodeCapacity = {
      id: "node",
      allocatable: { cpuMillicores: 0, memoryBytes: 0, storageBytes: 5_478_233_295 },
      platformOverhead: { cpuMillicores: 0, memoryBytes: 0, storageBytes: 0 },
      labels: { "x402.io/sandbox-pool": "true" },
      taints: [],
      ready: true,
      schedulable: true,
    };
    const held: CapacityReservation = {
      id: "held",
      sessionId: null,
      nodeId: "node",
      state: "HELD",
      baseline: { cpuMillicores: 0, memoryBytes: 0, storageBytes: 0 },
      peak: { cpuMillicores: 0, memoryBytes: 0, storageBytes: 1 },
      expiresAt: null,
    };
    const request: SandboxResourceRequest = {
      baseline: { cpuMillicores: 1, memoryBytes: 1, storageBytes: 1 },
      peak: { cpuMillicores: 0, memoryBytes: 0, storageBytes: 5_478_233_295 },
    };
    const snapshot: CapacitySnapshot = {
      nodes: [node],
      reservations: [held],
      now: 0,
      accounting: "peak",
    };

    const decision = admitCapacity(snapshot, request);
    expect(decision.admitted).toBe(false);
    if (!decision.admitted) expect(decision.reason).toBe("insufficient_storage");
  });

  it("orders equal-score nodes bytewise, not by locale", () => {
    const resources = { cpuMillicores: 1_000, memoryBytes: 1_024 * MiB, storageBytes: 1_024 * MiB };
    const node = (id: string): NodeCapacity => ({
      id,
      allocatable: resources,
      platformOverhead: { cpuMillicores: 0, memoryBytes: 0, storageBytes: 0 },
      labels: { "x402.io/sandbox-pool": "true" },
      taints: [],
      ready: true,
      schedulable: true,
    });
    const request: SandboxResourceRequest = {
      baseline: { cpuMillicores: 100, memoryBytes: 128 * MiB, storageBytes: 128 * MiB },
      peak: { cpuMillicores: 100, memoryBytes: 128 * MiB, storageBytes: 128 * MiB },
    };
    const candidates = placementCandidates({
      nodes: [node("a"), node("B")],
      reservations: [],
      now: 0,
      accounting: "baseline",
    }, request);
    // "B" (0x42) sorts before "a" (0x61) bytewise; localeCompare disagrees.
    expect(candidates.map((candidate) => candidate.node.id)).toEqual(["B", "a"]);
  });

  it("placement candidates are sorted deterministically by score", () => {
    fc.assert(
      fc.property(snapshotArb(fc.array(nodeArb, { maxLength: 3 })), requestArb, (snapshot, request) => {
        const candidates = placementCandidates(snapshot, request);
        for (let i = 1; i < candidates.length; i += 1) {
          const prev = candidates[i - 1]!;
          const next = candidates[i]!;
          expect(
            prev.score < next.score ||
              (prev.score === next.score && prev.node.id <= next.node.id),
          ).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});
