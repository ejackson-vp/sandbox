/**
 * Pure capacity admission. No network, no Kubernetes, no SQLite, no clock.
 */
import {
  fitsWithin,
  hasNonNegativeResources,
  type AdmissionDecision,
  type AdmissionRejectionReason,
  type CapacitySnapshot,
  type SandboxResourceRequest,
} from "./types.js";
import {
  noEligibleNodeReason,
  placementCandidates,
  type PlacementCandidate,
} from "./placement.js";

function reject(
  reason: AdmissionRejectionReason,
  request: SandboxResourceRequest,
): AdmissionDecision {
  return {
    admitted: false,
    reason,
    retryable: reason !== "invalid_request",
    requested: request.baseline,
  };
}

function insufficientReason(
  candidates: readonly PlacementCandidate[],
  request: SandboxResourceRequest,
): AdmissionRejectionReason {
  let cpu = false;
  let memory = false;
  let storage = false;
  for (const candidate of candidates) {
    if (candidate.available.cpuMillicores < request.baseline.cpuMillicores) cpu = true;
    if (candidate.available.memoryBytes < request.baseline.memoryBytes) memory = true;
    if (candidate.available.storageBytes < request.baseline.storageBytes) storage = true;
  }
  if (memory) return "insufficient_memory";
  if (cpu) return "insufficient_cpu";
  if (storage) return "insufficient_storage";
  return "no_eligible_nodes";
}

/**
 * Least-allocated placement: choose the eligible node with the lowest
 * post-placement utilization, breaking ties by node id. This spreads load and
 * avoids piling every session onto the first worker; first-fit would pack more
 * tightly but makes a single hot node more likely under burst.
 */
export function admitCapacity(
  snapshot: CapacitySnapshot,
  request: SandboxResourceRequest,
): AdmissionDecision {
  if (
    !hasNonNegativeResources(request.baseline) ||
    !hasNonNegativeResources(request.peak) ||
    request.baseline.cpuMillicores === 0 &&
      request.baseline.memoryBytes === 0 &&
      request.baseline.storageBytes === 0
  ) {
    return reject("invalid_request", request);
  }

  const candidates = placementCandidates(snapshot, request);
  if (candidates.length === 0) {
    return reject(noEligibleNodeReason(snapshot, request), request);
  }

  const selected = candidates.find((candidate) =>
    fitsWithin(request.baseline, candidate.available),
  );
  if (!selected) {
    return reject(insufficientReason(candidates, request), request);
  }

  return {
    admitted: true,
    nodeId: selected.node.id,
    reservation: {
      nodeId: selected.node.id,
      baseline: request.baseline,
      peak: request.peak,
      state: "HELD",
    },
    availableAfter: {
      cpuMillicores: selected.available.cpuMillicores - request.baseline.cpuMillicores,
      memoryBytes: selected.available.memoryBytes - request.baseline.memoryBytes,
      storageBytes: selected.available.storageBytes - request.baseline.storageBytes,
    },
  };
}
