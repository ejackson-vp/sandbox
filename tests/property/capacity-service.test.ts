/**
 * Summary and expiry accounting.
 *
 * `summary()` is what an operator reads and what the gauges publish. Its
 * invariant is arithmetic, not policy: every active reservation contributes
 * once, per-node reserves add up to the total, and each node's available is the
 * node's allocatable minus one platform-overhead deduction minus its reserves.
 * A second accumulation that drifts, or an overhead charged per reservation,
 * shows up here immediately.
 *
 * The second property is the hold TTL: once a hold expires it stops counting,
 * `reap` releases the durable row, and running the reaper again must not return
 * the same capacity twice.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { availableOnNode } from "../../controller/src/capacity/placement.js";
import {
  accountedResources,
  addResources,
  ZERO_RESOURCES,
} from "../../controller/src/capacity/types.js";
import {
  MiB,
  NOW,
  harness,
  record,
  reservationArb,
  nodeInfo,
  nodeShapeArb,
} from "../helpers/capacity-harness.js";

describe("summary reports one accounting, not two", () => {
  it("counts every reservation once and withholds overhead once per node", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(nodeShapeArb, { minLength: 1, maxLength: 4 }),
        fc.array(reservationArb([]), { maxLength: 8 }),
        async (nodeShapes, rows) => {
          const nodes = nodeShapes.map(nodeInfo);
          const nodeIds = nodes.map((node) => node.name);
          // Reassign rows to real nodes; the arbitrary generator only needs ids.
          const assigned = rows.map((row, index) => ({
            ...row,
            id: `res_${index}`,
            nodeId: nodeIds[index % nodeIds.length]!,
            createdAt: NOW,
            updatedAt: NOW,
          }));
          const h = harness({ nodes, rows: assigned });
          const summary = await h.service.summary();

          const accounted = assigned.filter((row) => row.state !== "RELEASED");
          const expectedReserved = accounted.reduce(
            (sum, row) => addResources(sum, accountedResources(row, h.cfg.capacityAccounting)),
            ZERO_RESOURCES,
          );
          expect(summary.reserved).toEqual(expectedReserved);
          // The total is the sum of the parts, so no row is counted twice and
          // no row is dropped between the two views.
          const perNode = summary.nodes.reduce(
            (sum, node) => addResources(sum, node.reserved),
            ZERO_RESOURCES,
          );
          expect(perNode).toEqual(expectedReserved);

          for (const node of summary.nodes) {
            const nodeRows = accounted.filter((row) => row.nodeId === node.id);
            const expectedNodeReserved = nodeRows.reduce(
              (sum, row) => addResources(sum, accountedResources(row, h.cfg.capacityAccounting)),
              ZERO_RESOURCES,
            );
            expect(node.reserved).toEqual(expectedNodeReserved);
            const expectedAvailable = availableOnNode(
              {
                id: node.id,
                allocatable: node.allocatable,
                platformOverhead: node.platformOverhead,
                labels: {},
                taints: [],
                ready: true,
                schedulable: true,
              },
              assigned,
              NOW,
              h.cfg.capacityAccounting,
            );
            expect(node.available).toEqual(expectedAvailable);
            // The configured headroom is a node constant, applied once.
            expect(node.platformOverhead).toEqual({
              cpuMillicores: h.cfg.capacityPlatformOverhead.cpuMillicores,
              memoryBytes: h.cfg.capacityPlatformOverhead.memoryMiB * MiB,
              storageBytes: h.cfg.capacityPlatformOverhead.storageMiB * MiB,
            });
            expect(node.eligible).toBe(
              nodes.find((candidate) => candidate.name === node.id)!.ready &&
                nodes.find((candidate) => candidate.name === node.id)!.schedulable &&
                nodes.find((candidate) => candidate.name === node.id)!.labels["x402.io/sandbox-pool"] === "true",
            );
          }

          // Only eligible nodes contribute to the pool-wide available figure.
          const expectedAvailable = summary.nodes
            .filter((node) => node.eligible)
            .reduce((sum, node) => addResources(sum, node.available), ZERO_RESOURCES);
          expect(summary.available).toEqual(expectedAvailable);
          for (const vector of [summary.reserved, summary.available]) {
            expect(vector.cpuMillicores).toBeGreaterThanOrEqual(0);
            expect(vector.memoryBytes).toBeGreaterThanOrEqual(0);
            expect(vector.storageBytes).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it("does not count a released row, and counts a suspended row's storage only", async () => {
    const h = harness({
      rows: [
        { ...record("allocated", "ALLOCATED") },
        { ...record("suspended", "SUSPENDED", "node-a"), podName: null },
        { ...record("released", "RELEASED") },
      ],
    });
    const summary = await h.service.summary();
    const suspended = accountedResources({ ...record("suspended", "SUSPENDED"), podName: null }, "baseline");
    expect(summary.reserved).toEqual(
      addResources(accountedResources(record("allocated", "ALLOCATED"), "baseline"), suspended),
    );
    expect(suspended.cpuMillicores).toBe(0);
    expect(suspended.memoryBytes).toBe(0);
    expect(suspended.storageBytes).toBe(record("suspended", "SUSPENDED").baseline.storageBytes);
    // RELEASED rows are absent from the active snapshot `summary` reports on.
    expect(summary.reservations).toEqual({
      total: 2,
      held: 0,
      allocated: 1,
      suspended: 1,
      releasing: 0,
    });
  });
});

describe("an expired hold returns capacity once", () => {
  it("frees the hold on the first reap and nothing more on the second", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 50, max: 2_000 }),
        fc.integer({ min: 1, max: 1_000 }),
        async (cpu, memoryMiB) => {
          const h = harness();
          const spec = {
            limits: { cpuMillis: cpu, memoryMiB, diskMiB: 128 },
            baseline: { cpuMillis: 50, memoryMiB: 64 },
          };
          const held = await h.service.hold("payment", "spec", spec);
          if (!held.admitted) {
            // The first request may legitimately exceed the node; nothing to reap.
            expect(h.reservations.rows).toHaveLength(0);
            return;
          }
          const before = await h.service.summary();
          const node = {
            id: h.nodes[0]!.name,
            allocatable: {
              cpuMillicores: h.nodes[0]!.allocatableCpuMillis,
              memoryBytes: h.nodes[0]!.allocatableMemoryBytes,
              storageBytes: h.nodes[0]!.allocatableStorageBytes,
            },
            platformOverhead: {
              cpuMillicores: h.cfg.capacityPlatformOverhead.cpuMillicores,
              memoryBytes: h.cfg.capacityPlatformOverhead.memoryMiB * MiB,
              storageBytes: h.cfg.capacityPlatformOverhead.storageMiB * MiB,
            },
            labels: {},
            taints: [],
            ready: true,
            schedulable: true,
          };
          const baseline = availableOnNode(node, [], NOW, h.cfg.capacityAccounting);
          expect(before.available).toEqual(
            availableOnNode(node, h.reservations.rows, NOW, h.cfg.capacityAccounting),
          );

          // Simulate the clock moving past the hold's TTL: the row is the only
          // thing the reaper reads, so its expiry is enough for this property.
          h.reservations.rows[0]!.expiresAt = 0;
          const afterExpiry = await h.service.summary();
          // The model already stops charging an expired hold; reaping only
          // makes the durable row agree with that.
          expect(afterExpiry.available).toEqual(baseline);

          await h.service.reap();
          expect(h.reservations.rows[0]!.state).toBe("RELEASED");
          const afterReap = await h.service.summary();
          expect(afterReap.available).toEqual(baseline);

          await h.service.reap();
          expect(h.reservations.rows.filter((row) => row.state === "RELEASED")).toHaveLength(1);
          const afterSecondReap = await h.service.summary();
          expect(afterSecondReap.available).toEqual(baseline);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe("the preflight and attach paths reach the model without writing a hold", () => {
  it("admits a preflight and leaves the reservation table untouched", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000 }),
        fc.integer({ min: 1, max: 2_048 }),
        async (cpuMillis, memoryMiB) => {
          const h = harness();
          const decision = await h.service.preflight({
            limits: { cpuMillis, memoryMiB, diskMiB: 128 },
          });
          expect(decision.admitted).toBe(true);
          // Preflight is a question, not a reservation.
          expect(h.reservations.rows).toHaveLength(0);
          expect(h.reservations.admitCalls).toHaveLength(0);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("passes payment, session and spec hash to attach unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 16 }),
        fc.string({ minLength: 1, maxLength: 16 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        async (paymentKey, sessionId, specHash) => {
          const h = harness();
          const spec = { limits: { cpuMillis: 500, memoryMiB: 512, diskMiB: 256 } };
          const admission = await h.service.attach(paymentKey, sessionId, specHash, spec);
          expect(admission.admitted).toBe(true);
          expect(h.reservations.attachCalls[0]).toMatchObject({ paymentKey, sessionId, specHash });
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe("the service forwards every reservation operation", () => {
  it("returns the adapter's answer for each one-argument call", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 16 }),
        fc.string({ minLength: 1, maxLength: 16 }),
        async (sessionId, nodeId) => {
          const h = harness();
          expect(await h.service.releasePayment(sessionId)).toBe(true);
          expect(await h.service.suspend(sessionId)).toBe(true);
          expect(await h.service.reassertAllocated(sessionId)).toBe(true);
          expect(await h.service.releaseSession(sessionId)).toBe(true);
          expect(await h.service.pinSessionNode(sessionId, nodeId)).toBe(true);
          await h.service.updatePod(sessionId, "pod-1");
          await h.service.updatePod(sessionId, "pod-2");
          expect(await h.service.getReservation("nobody")).toBeNull();

          expect(h.reservations.releasePaymentCalls).toEqual([sessionId]);
          expect(h.reservations.suspendCalls).toEqual([sessionId]);
          expect(h.reservations.reassertCalls).toEqual([sessionId]);
          expect(h.reservations.releaseSessionCalls).toEqual([sessionId]);
          expect(h.reservations.pinNodeCalls).toEqual([{ sessionId, nodeId }]);
          expect(h.reservations.updatePodCalls).toEqual([
            { sessionId, podName: "pod-1" },
            { sessionId, podName: "pod-2" },
          ]);
        },
      ),
      { numRuns: 10 },
    );
  });
});
