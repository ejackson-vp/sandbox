/**
 * Snapshot builder: Kubernetes node capacity + durable reservations + warm
 * pods, with a short node cache. No admission policy lives here.
 */
import type { ControllerConfig } from "../config.js";
import type { Provisioner } from "../k8s.js";
import type { Store } from "../store.js";
import { requestForLimits, ZERO_RESOURCES, type CapacitySnapshot, type NodeCapacity, type ReservationState } from "./types.js";
import type { ReservationRecord } from "./reservations.js";

const MIB = 1024 * 1024;

export class CapacitySnapshotBuilder {
  private nodeCache: { nodes: NodeCapacity[]; at: number } | null = null;

  constructor(
    private readonly cfg: ControllerConfig,
    private readonly store: Store,
    private readonly provisioner: Provisioner,
  ) {}

  async loadNodes(now: number): Promise<NodeCapacity[]> {
    if (!this.cfg.capacityEnabled) {
      return [{
        id: "disabled",
        allocatable: {
          cpuMillicores: 1_000_000,
          memoryBytes: 1_000_000 * MIB,
          storageBytes: 1_000_000 * MIB,
        },
        platformOverhead: ZERO_RESOURCES,
        labels: { "x402.io/sandbox-pool": "true" },
        taints: [],
        ready: true,
        schedulable: true,
      }];
    }
    if (this.nodeCache && now - this.nodeCache.at < 1_000) return this.nodeCache.nodes;
    const nodes = await this.provisioner.listNodes();
    const mapped: NodeCapacity[] = nodes.map((node) => ({
      id: node.name,
      allocatable: {
        cpuMillicores:
          this.cfg.capacityNodeCpuOverrideMillis > 0
            ? Math.min(node.allocatableCpuMillis, this.cfg.capacityNodeCpuOverrideMillis)
            : node.allocatableCpuMillis,
        memoryBytes:
          this.cfg.capacityNodeMemoryOverrideMiB > 0
            ? Math.min(node.allocatableMemoryBytes, this.cfg.capacityNodeMemoryOverrideMiB * MIB)
            : node.allocatableMemoryBytes,
        storageBytes: node.allocatableStorageBytes,
      },
      platformOverhead: {
        cpuMillicores: this.cfg.capacityPlatformOverhead.cpuMillicores,
        memoryBytes: this.cfg.capacityPlatformOverhead.memoryMiB * MIB,
        storageBytes: this.cfg.capacityPlatformOverhead.storageMiB * MIB,
      },
      labels: node.labels,
      taints: node.taints,
      ready: node.ready,
      schedulable: node.schedulable,
    }));
    this.nodeCache = { nodes: mapped, at: now };
    return mapped;
  }

  private async warmReservationsForSnapshot(
    nodes: NodeCapacity[],
    now: number,
  ): Promise<ReservationRecord[]> {
    if (this.cfg.warmPoolSize === 0) return [];
    let warmPods;
    try {
      warmPods = await this.provisioner.listWarmPods();
    } catch {
      return [];
    }
    if (warmPods.length === 0) return [];
    const tier = this.cfg.tiers[this.cfg.warmPoolTier];
    if (!tier) return [];
    const request = requestForLimits({
      cpuMillis: tier.cpuMillis,
      memoryMiB: tier.memoryMiB,
      diskMiB: tier.diskMiB,
    });
    const fallbackNode = nodes[0]?.id ?? "unassigned";
    return warmPods
      .filter((pod) => pod.phase !== "Succeeded" && pod.phase !== "Failed")
      .map((pod) => ({
        id: `warm_${pod.warmId}`,
        paymentKey: null,
        sessionId: null,
        specHash: null,
        nodeId: pod.nodeName ?? fallbackNode,
        podName: pod.name,
        state: "ALLOCATED" as ReservationState,
        baseline: request.baseline,
        peak: request.peak,
        expiresAt: null,
        createdAt: pod.createdAt,
        updatedAt: now,
      }));
  }

  async snapshotWithWarm(): Promise<CapacitySnapshot> {
    const now = Date.now();
    const nodes = await this.loadNodes(now);
    const reservations = this.store.reservations.listActive();
    const warm = await this.warmReservationsForSnapshot(nodes, now);
    return { nodes, reservations: [...reservations, ...warm], now, accounting: this.cfg.capacityAccounting };
  }
}
