/**
 * Capacity vocabulary. All quantities are integers: millicores, bytes and
 * epoch milliseconds. No floats, no Kubernetes objects, no I/O.
 */

export interface ResourceVector {
  cpuMillicores: number;
  memoryBytes: number;
  storageBytes: number;
}

export const ZERO_RESOURCES: ResourceVector = {
  cpuMillicores: 0,
  memoryBytes: 0,
  storageBytes: 0,
};

export function addResources(a: ResourceVector, b: ResourceVector): ResourceVector {
  return {
    cpuMillicores: a.cpuMillicores + b.cpuMillicores,
    memoryBytes: a.memoryBytes + b.memoryBytes,
    storageBytes: a.storageBytes + b.storageBytes,
  };
}

export function subtractResources(a: ResourceVector, b: ResourceVector): ResourceVector {
  return {
    cpuMillicores: a.cpuMillicores - b.cpuMillicores,
    memoryBytes: a.memoryBytes - b.memoryBytes,
    storageBytes: a.storageBytes - b.storageBytes,
  };
}

export function fitsWithin(need: ResourceVector, available: ResourceVector): boolean {
  return (
    need.cpuMillicores <= available.cpuMillicores &&
    need.memoryBytes <= available.memoryBytes &&
    need.storageBytes <= available.storageBytes
  );
}

export type ReservationState = "HELD" | "ALLOCATED" | "SUSPENDED" | "RELEASING" | "RELEASED";

/**
 * Compute is held by `HELD` and `ALLOCATED`, and by `RELEASING` while it still
 * names a Pod. A release that came from an active session waits for the Pod's
 * cgroup; a release that came from `SUSPENDED` has no Pod and gave compute back
 * when it checkpointed. The reservation's `podName` records which case it is,
 * so the distinction survives a controller restart without a new column
 * (issue #72).
 */
export function holdsCompute(
  reservation: Pick<CapacityReservation, "state" | "podName">,
): boolean {
  switch (reservation.state) {
    case "HELD":
    case "ALLOCATED":
      return true;
    case "RELEASING":
      return reservation.podName !== null;
    case "SUSPENDED":
    case "RELEASED":
      return false;
  }
}

export interface CapacityReservation {
  id: string;
  sessionId: string | null;
  nodeId: string;
  state: ReservationState;
  /**
   * Pod whose deletion this reservation waits for, if any. A `SUSPENDED` row
   * and a `RELEASING` row that came from `SUSPENDED` have none.
   */
  podName: string | null;
  /** Guaranteed scheduling reservation. */
  baseline: ResourceVector;
  /** Burst ceiling. Tracked for reporting, not separately admitted today. */
  peak: ResourceVector;
  expiresAt: number | null;
}

/**
 * The part of a reservation's committed vector the node still accounts for:
 * everything it holds, or storage only once compute has been given back.
 */
export function accountedResources(
  reservation: Pick<CapacityReservation, "state" | "podName" | "baseline" | "peak">,
  accounting: AccountingMode,
): ResourceVector {
  if (reservation.state === "RELEASED") return ZERO_RESOURCES;
  const committed = accounting === "peak" ? reservation.peak : reservation.baseline;
  return holdsCompute(reservation)
    ? committed
    : { cpuMillicores: 0, memoryBytes: 0, storageBytes: committed.storageBytes };
}

interface NodeTaint {
  key: string;
  effect: "NoSchedule" | "PreferNoSchedule" | "NoExecute";
}

export interface NodeCapacity {
  id: string;
  allocatable: ResourceVector;
  /** Controller/relay/CNI/kubelet headroom withheld from sandboxes. */
  platformOverhead: ResourceVector;
  labels: Record<string, string>;
  taints: NodeTaint[];
  ready: boolean;
  schedulable: boolean;
}

export type AccountingMode = "baseline" | "peak";

export interface CapacitySnapshot {
  nodes: readonly NodeCapacity[];
  reservations: readonly CapacityReservation[];
  now: number;
  /** baseline = guarantee scheduler requests; peak = no limit overcommit. */
  accounting: AccountingMode;
}

export interface SandboxResourceRequest {
  sessionId?: string;
  specHash?: string;
  baseline: ResourceVector;
  peak: ResourceVector;
  /** Hard placement requirement, used for local-path checkpoint affinity. */
  requiredNodeId?: string | null;
  /** Tolerated taint keys. `NoSchedule`/`NoExecute` taints block otherwise. */
  tolerations?: readonly string[];
}

export type AdmissionRejectionReason =
  | "invalid_request"
  | "no_nodes"
  | "no_eligible_nodes"
  | "node_affinity_unavailable"
  | "insufficient_cpu"
  | "insufficient_memory"
  | "insufficient_storage"
  | "runtime_profile_unavailable";

interface ReservationPlan {
  nodeId: string;
  baseline: ResourceVector;
  peak: ResourceVector;
  state: "HELD";
}

export type AdmissionDecision =
  | {
      admitted: true;
      nodeId: string;
      reservation: ReservationPlan;
      availableAfter: ResourceVector;
    }
  | {
      admitted: false;
      reason: AdmissionRejectionReason;
      retryable: boolean;
      requested: ResourceVector;
    };



const MIB = 1024 * 1024;

/** Spec -> reservation request. Baseline is guaranteed; peak is the burst cap. */
export function requestForLimits(
  limits: { cpuMillis: number; memoryMiB: number; diskMiB: number },
  baseline?: { cpuMillis: number; memoryMiB: number },
): SandboxResourceRequest {
  const baselineCpu = baseline?.cpuMillis ?? Math.max(50, Math.floor(limits.cpuMillis / 4));
  const baselineMemory = baseline?.memoryMiB ?? Math.max(64, Math.floor(limits.memoryMiB / 4));
  return {
    baseline: {
      cpuMillicores: baselineCpu,
      memoryBytes: baselineMemory * MIB,
      // The PVC/emptyDir is node-local; include a small pod scratch margin.
      storageBytes: (limits.diskMiB + 128) * MIB,
    },
    peak: {
      cpuMillicores: limits.cpuMillis,
      memoryBytes: limits.memoryMiB * MIB,
      storageBytes: (limits.diskMiB + 128) * MIB,
    },
  };
}

export function requestForSession(session: {
  limits: { cpuMillis: number; memoryMiB: number; diskMiB: number };
  baselineCpuMillis: number | null;
  baselineMemoryMib: number | null;
}): SandboxResourceRequest {
  return requestForLimits(
    session.limits,
    session.baselineCpuMillis && session.baselineMemoryMib
      ? { cpuMillis: session.baselineCpuMillis, memoryMiB: session.baselineMemoryMib }
      : undefined,
  );
}

export function hasNonNegativeResources(v: ResourceVector): boolean {
  return v.cpuMillicores >= 0 && v.memoryBytes >= 0 && v.storageBytes >= 0;
}
