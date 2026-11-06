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

/** Compute is held for every state except SUSPENDED and RELEASED. */
export function holdsCompute(state: ReservationState): boolean {
  return state === "HELD" || state === "ALLOCATED" || state === "RELEASING";
}

export interface CapacityReservation {
  id: string;
  sessionId: string | null;
  nodeId: string;
  state: ReservationState;
  /** Guaranteed scheduling reservation. */
  baseline: ResourceVector;
  /** Burst ceiling. Tracked for reporting, not separately admitted today. */
  peak: ResourceVector;
  expiresAt: number | null;
}

export interface NodeTaint {
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
  | "insufficient_storage";

export interface ReservationPlan {
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

export interface CapacitySummary {
  accounting: AccountingMode;
  nodes: Array<{
    id: string;
    allocatable: ResourceVector;
    reserved: ResourceVector;
    available: ResourceVector;
    eligible: boolean;
  }>;
  reservations: {
    total: number;
    held: number;
    allocated: number;
    suspended: number;
    releasing: number;
  };
  reserved: ResourceVector;
  available: ResourceVector;
}

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
