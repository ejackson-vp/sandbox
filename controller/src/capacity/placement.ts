/**
 * Deterministic placement intent. Kubernetes still schedules the Pod; this is
 * the controller's capacity-planning decision, not a guarantee.
 */
import {
  accountedResources,
  subtractResources,
  type CapacityReservation,
  type CapacitySnapshot,
  type NodeCapacity,
  type ResourceVector,
  type SandboxResourceRequest,
  type AccountingMode,
} from "./types.js";

const SANDBOX_POOL_LABEL = "x402.io/sandbox-pool";
const DEFAULT_TOLERATIONS = ["x402.io/sandbox"];

function isNodeEligible(
  node: NodeCapacity,
  request: SandboxResourceRequest,
): boolean {
  if (!node.ready || !node.schedulable) return false;
  if (node.labels[SANDBOX_POOL_LABEL] !== "true") return false;
  if (request.requiredNodeId && node.id !== request.requiredNodeId) return false;
  const tolerations = new Set(request.tolerations ?? DEFAULT_TOLERATIONS);
  return node.taints.every(
    (taint) =>
      taint.effect === "PreferNoSchedule" ||
      tolerations.has(taint.key),
  );
}

function reservedOnNode(
  reservations: readonly CapacityReservation[],
  nodeId: string,
  now: number,
  accounting: AccountingMode = "baseline",
): ResourceVector {
  let cpu = 0;
  let memory = 0;
  let storage = 0;
  for (const reservation of reservations) {
    if (reservation.nodeId !== nodeId) continue;
    if (reservation.state === "RELEASED") continue;
    if (reservation.state === "HELD" && reservation.expiresAt !== null && reservation.expiresAt <= now) {
      continue;
    }
    // All three dimensions come from the same accounting vector. Storage used
    // to always charge baseline here, which let a peak-mode request that fit
    // the request peak be admitted against existing reservations charged at
    // baseline storage, over-allocating by the difference (issue #68).
    //
    // Compute follows holdsCompute(): SUSPENDED, and a RELEASING row that came
    // from SUSPENDED, charge storage only. A release that still names its Pod
    // keeps charging compute until the Pod is gone (issue #72).
    const committed = accountedResources(reservation, accounting);
    cpu += committed.cpuMillicores;
    memory += committed.memoryBytes;
    storage += committed.storageBytes;
  }
  return { cpuMillicores: cpu, memoryBytes: memory, storageBytes: storage };
}

export function availableOnNode(
  node: NodeCapacity,
  reservations: readonly CapacityReservation[],
  now: number,
  accounting: AccountingMode = "baseline",
): ResourceVector {
  const reserved = reservedOnNode(reservations, node.id, now, accounting);
  const available = subtractResources(
    subtractResources(node.allocatable, node.platformOverhead),
    reserved,
  );
  return {
    cpuMillicores: Math.max(0, available.cpuMillicores),
    memoryBytes: Math.max(0, available.memoryBytes),
    storageBytes: Math.max(0, available.storageBytes),
  };
}

export interface PlacementCandidate {
  node: NodeCapacity;
  available: ResourceVector;
  score: number;
}

function utilization(node: NodeCapacity, used: ResourceVector): number {
  const ratios = [
    node.allocatable.cpuMillicores > 0 ? used.cpuMillicores / node.allocatable.cpuMillicores : 0,
    node.allocatable.memoryBytes > 0 ? used.memoryBytes / node.allocatable.memoryBytes : 0,
    node.allocatable.storageBytes > 0 ? used.storageBytes / node.allocatable.storageBytes : 0,
  ];
  return Math.max(...ratios);
}

export function placementCandidates(
  snapshot: CapacitySnapshot,
  request: SandboxResourceRequest,
): PlacementCandidate[] {
  return snapshot.nodes
    .filter((node) => isNodeEligible(node, request))
    .map((node) => {
      const available = availableOnNode(node, snapshot.reservations, snapshot.now, snapshot.accounting);
      const used = subtractResources(node.allocatable, available);
      return { node, available, score: utilization(node, used) };
    })
    .sort((a, b) =>
      a.score - b.score ||
      (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0));
}

export function noEligibleNodeReason(
  snapshot: CapacitySnapshot,
  request: SandboxResourceRequest,
): "no_nodes" | "node_affinity_unavailable" | "no_eligible_nodes" {
  if (snapshot.nodes.length === 0) return "no_nodes";
  if (request.requiredNodeId && !snapshot.nodes.some((node) => node.id === request.requiredNodeId)) {
    return "node_affinity_unavailable";
  }
  return "no_eligible_nodes";
}
