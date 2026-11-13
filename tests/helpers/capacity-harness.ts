/**
 * A capacity service wired to a fake reservation store and a fake cluster.
 *
 * The eventual assertions are about what the service asks of its ports and how
 * it reads the snapshot back. The store reproduces the SQL side: admission is
 * the real pure model, `listActive` filters RELEASED rows, and every write
 * records the call so a test can compare a whole decision sequence against a
 * reference.
 */
import fc from "fast-check";
import { CapacityService } from "../../controller/src/capacity/service.js";
import { admitCapacity } from "../../controller/src/capacity/admission.js";
import {
  type ReservationState,
  type ResourceVector,
  type SandboxResourceRequest,
} from "../../controller/src/capacity/types.js";
import type {
  ReservationAdmission,
  ReservationRecord,
  ReservationStore,
} from "../../controller/src/capacity/reservation-store.js";
import type { NodeInfo, Provisioner } from "../../controller/src/k8s.js";
import type { SessionRecord } from "../../controller/src/store/models.js";
import type { CapacityStore } from "../../controller/src/store/ports.js";
import { controllerConfig } from "./controller-config.js";

export const MiB = 1024 * 1024;
export const NOW = Date.now();

const resourceArb = (max: number): fc.Arbitrary<ResourceVector> =>
  fc.record({
    cpuMillicores: fc.integer({ min: 0, max }),
    memoryBytes: fc.integer({ min: 0, max: max * MiB }),
    storageBytes: fc.integer({ min: 0, max: max * MiB }),
  });

export const RESERVATION_STATES: ReservationState[] = [
  "HELD",
  "ALLOCATED",
  "SUSPENDED",
  "RELEASING",
  "RELEASED",
];

export interface NodeShape {
  id: string;
  cpu: number;
  memoryMiB: number;
  storageMiB: number;
  ready: boolean;
  schedulable: boolean;
  labelled: boolean;
}

export const nodeShapeArb: fc.Arbitrary<NodeShape> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 8 }),
  cpu: fc.integer({ min: 1_000, max: 16_000 }),
  memoryMiB: fc.integer({ min: 1_024, max: 32_768 }),
  storageMiB: fc.integer({ min: 1_024, max: 65_536 }),
  ready: fc.boolean(),
  schedulable: fc.boolean(),
  labelled: fc.boolean(),
});

/**
 * A cluster of one to four nodes with distinct ids.
 *
 * Distinct because the id is the key the store counts a reservation under. Two
 * shapes that happen to share a name collapse into one row, and the test's
 * per-node arithmetic then disagrees with a service that is behaving correctly.
 * That is a fixture collision, not a bug, but it fails about one run in six and
 * a red run nobody can reproduce is worse than no test.
 */
export const nodeShapesArb: fc.Arbitrary<NodeShape[]> = fc.uniqueArray(nodeShapeArb, {
  selector: (shape) => shape.id,
  minLength: 1,
  maxLength: 4,
});

export function nodeInfo(shape: NodeShape): NodeInfo {
  return {
    name: shape.id,
    allocatableCpuMillis: shape.cpu,
    allocatableMemoryBytes: shape.memoryMiB * MiB,
    allocatableStorageBytes: shape.storageMiB * MiB,
    labels: shape.labelled ? { "x402.io/sandbox-pool": "true" } : {},
    taints: [],
    ready: shape.ready,
    schedulable: shape.schedulable,
  };
}

export const reservationArb = (nodeIds: string[]): fc.Arbitrary<ReservationRecord> =>
  fc
    .record({
      id: fc.string({ minLength: 1, maxLength: 8 }),
      state: fc.constantFrom(...RESERVATION_STATES),
      nodeIndex: fc.integer({ min: 0, max: Math.max(0, nodeIds.length - 1) }),
      baseline: resourceArb(2_000),
      peak: resourceArb(4_000),
      podName: fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: null }),
      sessionId: fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: null }),
      expiresAt: fc.option(fc.integer({ min: 0, max: 10 ** 12 }), { nil: null }),
      updatedAt: fc.constant(NOW),
    })
    .map((row) => ({
      ...row,
      nodeId: nodeIds[row.nodeIndex] ?? "node-a",
      paymentKey: null,
      specHash: null,
      createdAt: NOW,
      expiresAt: null,
    }));

export class FakeReservations implements ReservationStore {
  public readonly rows: ReservationRecord[] = [];
  public readonly admitCalls: Array<{ snapshotNow: number; request: SandboxResourceRequest; opts: unknown }> = [];
  public readonly attachCalls: Array<{ paymentKey: string; sessionId: string; specHash: string; request: SandboxResourceRequest }> = [];
  public readonly resumeCalls: Array<{ sessionId: string; request: SandboxResourceRequest }> = [];
  public readonly releasePaymentCalls: string[] = [];
  public readonly suspendCalls: string[] = [];
  public readonly reassertCalls: string[] = [];
  public readonly beginReleaseCalls: Array<{ sessionId: string; podName: string | null }> = [];
  public readonly confirmReleaseCalls: string[] = [];
  public readonly releaseSessionCalls: string[] = [];
  public readonly updatePodCalls: Array<{ sessionId: string; podName: string | null }> = [];
  public readonly pinNodeCalls: Array<{ sessionId: string; nodeId: string }> = [];

  async admit(
    snapshot: { now: number },
    request: SandboxResourceRequest,
    opts: { paymentKey?: string; sessionId?: string; specHash?: string; ttlMs?: number; state?: "HELD" | "ALLOCATED" } = {},
  ): Promise<ReservationAdmission> {
    this.admitCalls.push({ snapshotNow: snapshot.now, request, opts });
    const decision = admitCapacity(snapshot as never, request);
    if (!decision.admitted) return decision;
    const row: ReservationRecord = {
      id: `res_${this.rows.length}`,
      paymentKey: opts.paymentKey ?? null,
      sessionId: opts.sessionId ?? null,
      specHash: opts.specHash ?? null,
      nodeId: decision.nodeId,
      podName: null,
      state: opts.state ?? "HELD",
      baseline: request.baseline,
      peak: request.peak,
      expiresAt: opts.ttlMs ? snapshot.now + opts.ttlMs : null,
      createdAt: snapshot.now,
      updatedAt: snapshot.now,
    };
    this.rows.push(row);
    return { admitted: true, reservation: row };
  }

  async attachToSession(
    _snapshot: unknown,
    request: SandboxResourceRequest,
    paymentKey: string,
    sessionId: string,
    specHash: string,
  ): Promise<ReservationAdmission> {
    this.attachCalls.push({ paymentKey, sessionId, specHash, request });
    const row = this.rows.find((candidate) => candidate.sessionId === sessionId);
    if (row) {
      row.state = "ALLOCATED";
      return { admitted: true, reservation: row };
    }
    const created: ReservationRecord = {
      id: `res_attach_${this.rows.length}`,
      paymentKey,
      sessionId,
      specHash,
      nodeId: "node-a",
      podName: null,
      state: "ALLOCATED",
      baseline: request.baseline,
      peak: request.peak,
      expiresAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.rows.push(created);
    return { admitted: true, reservation: created };
  }

  async resume(
    _snapshot: unknown,
    request: SandboxResourceRequest,
    sessionId: string,
  ): Promise<ReservationAdmission> {
    this.resumeCalls.push({ sessionId, request });
    const row = this.rows.find((candidate) => candidate.sessionId === sessionId);
    if (row) row.state = "ALLOCATED";
    return row
      ? { admitted: true, reservation: row }
      : { admitted: false, reason: "no_eligible_nodes", retryable: true, requested: request.baseline };
  }

  async releasePayment(paymentKey: string): Promise<boolean> {
    this.releasePaymentCalls.push(paymentKey);
    return true;
  }

  async suspendSession(sessionId: string): Promise<boolean> {
    this.suspendCalls.push(sessionId);
    const row = this.rows.find((candidate) => candidate.sessionId === sessionId);
    if (row) row.state = "SUSPENDED";
    return true;
  }

  async reassertAllocated(sessionId: string): Promise<boolean> {
    this.reassertCalls.push(sessionId);
    return true;
  }

  async beginRelease(sessionId: string, podName: string | null): Promise<boolean> {
    this.beginReleaseCalls.push({ sessionId, podName });
    const row = this.rows.find((candidate) => candidate.sessionId === sessionId);
    if (row) row.state = "RELEASING";
    return true;
  }

  async confirmRelease(sessionId: string): Promise<boolean> {
    this.confirmReleaseCalls.push(sessionId);
    const row = this.rows.find((candidate) => candidate.sessionId === sessionId);
    if (row) row.state = "RELEASED";
    return true;
  }

  async releaseSession(sessionId: string): Promise<boolean> {
    this.releaseSessionCalls.push(sessionId);
    const row = this.rows.find((candidate) => candidate.sessionId === sessionId);
    if (row) row.state = "RELEASED";
    return true;
  }

  async updatePod(sessionId: string, podName: string | null): Promise<void> {
    this.updatePodCalls.push({ sessionId, podName });
  }

  async pinNode(sessionId: string, nodeId: string): Promise<boolean> {
    this.pinNodeCalls.push({ sessionId, nodeId });
    return true;
  }

  async listActive(): Promise<ReservationRecord[]> {
    return this.rows.filter((row) => row.state !== "RELEASED");
  }

  async listReleasing(): Promise<ReservationRecord[]> {
    return this.rows.filter((row) => row.state === "RELEASING");
  }

  async getBySession(sessionId: string): Promise<ReservationRecord | null> {
    return this.rows.find((row) => row.sessionId === sessionId) ?? null;
  }

  async getByPayment(paymentKey: string): Promise<ReservationRecord | null> {
    return this.rows.find((row) => row.paymentKey === paymentKey) ?? null;
  }

  async reapExpiredHolds(now: number): Promise<number> {
    let count = 0;
    for (const row of this.rows) {
      if (row.state === "HELD" && row.expiresAt !== null && row.expiresAt <= now) {
        row.state = "RELEASED";
        count += 1;
      }
    }
    return count;
  }
}

export interface HarnessOptions {
  env?: NodeJS.ProcessEnv;
  nodes?: NodeInfo[];
  rows?: ReservationRecord[];
  sessions?: Map<string, SessionRecord>;
  pods?: Map<string, boolean>;
}

export function harness(options: HarnessOptions = {}) {
  const cfg = controllerConfig(options.env);
  const reservations = new FakeReservations();
  reservations.rows.push(...(options.rows ?? []));
  const nodes = options.nodes ?? [
    {
      name: "node-a",
      allocatableCpuMillis: 8_000,
      allocatableMemoryBytes: 16_384 * MiB,
      allocatableStorageBytes: 32_768 * MiB,
      labels: { "x402.io/sandbox-pool": "true" },
      taints: [],
      ready: true,
      schedulable: true,
    },
  ];
  const sessions = options.sessions ?? new Map<string, SessionRecord>();
  const pods = options.pods ?? new Map<string, boolean>();
  const provisioner = {
    listNodes: async () => nodes,
    listWarmPods: async () => [],
    getPod: async (name: string) => (pods.get(name) ? { phase: "Running", deleted: false } : null),
  } as unknown as Provisioner;
  const store = {
    getSession: async (id: string) => sessions.get(id) ?? null,
    reservations,
  } as unknown as CapacityStore;
  const service = new CapacityService({ cfg, store, provisioner, reservations });
  return { cfg, reservations, nodes, sessions, pods, service };
}

export function record(id: string, state: ReservationState, nodeId = "node-a"): ReservationRecord {
  return {
    id,
    paymentKey: null,
    sessionId: null,
    specHash: null,
    nodeId,
    podName: null,
    state,
    baseline: { cpuMillicores: 100, memoryBytes: 64 * MiB, storageBytes: 256 * MiB },
    peak: { cpuMillicores: 400, memoryBytes: 256 * MiB, storageBytes: 256 * MiB },
    expiresAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

