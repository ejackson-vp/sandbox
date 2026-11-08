/**
 * Kubernetes provisioner contract and pod specs.
 */
import type { SessionLimits } from "@x402s/shared";

export interface SandboxPodSpec {
  sessionId: string;
  leaseSeconds: number;
  limits: SessionLimits;
  clientPublicKey: string;
  clientNonce: string;
  guestToken: string;
  relayUrl: string;
  relayHost: string;
  relayPort: number;
  proxyUrl: string;
  proxyToken: string;
  image: string;
  imageDigest: string;
  runtimeClass: string;
  executionMode: "dev" | "kata";
  workspaceDir: string;
  /** Mount a persistent workspace (checkpoint/resume) instead of emptyDir. */
  workspacePvc?: string;
  /** True when this pod is a resume of a suspended session. */
  resume?: boolean;
  /** Scheduler reservation; defaults to peak/4. */
  baselineCpuMillis?: number;
  baselineMemoryMiB?: number;
  /** Pin the pod to a specific node (local-path checkpoint resume). */
  nodeName?: string;
}

export interface WarmPodSpec {
  warmId: string;
  poolId: string;
  ttlMs: number;
  limits: SessionLimits;
  guestToken: string;
  relayUrl: string;
  proxyUrl: string;
  proxyToken: string;
  image: string;
  imageDigest: string;
  runtimeClass: string;
  executionMode: "dev" | "kata";
  workspaceDir: string;
  tools: string;
}

export interface WarmPodInfo {
  name: string;
  warmId: string;
  poolId: string;
  createdAt: number;
  phase: string;
  nodeName?: string;
}

export interface NodeInfo {
  name: string;
  allocatableCpuMillis: number;
  allocatableMemoryBytes: number;
  allocatableStorageBytes: number;
  labels: Record<string, string>;
  taints: Array<{ key: string; effect: "NoSchedule" | "PreferNoSchedule" | "NoExecute" }>;
  ready: boolean;
  schedulable: boolean;
}

export interface Provisioner {
  createPod(spec: SandboxPodSpec): Promise<{ podName: string }>;
  createWarmPod(spec: WarmPodSpec): Promise<{ podName: string }>;
  createWorkspacePvc(sessionId: string, sizeMiB: number): Promise<string>;
  deleteWorkspacePvc(pvcName: string): Promise<void>;
  /** Stop the workload but keep its persistent workspace (checkpoint). */
  suspendPod(podName: string): Promise<void>;
  deletePod(podName: string, gracePeriodSeconds?: number): Promise<void>;
  getPod(podName: string): Promise<{
    phase: string;
    deleted: boolean;
    imageID?: string;
    createdAt?: number;
    scheduledAt?: number;
    startedAt?: number;
    nodeName?: string;
  } | null>;
  /** True when the node exists, is ready, and is not cordoned. */
  nodeAvailable(nodeName: string): Promise<boolean>;
  /** True when the per-session workspace PVC still exists. */
  workspacePvcExists(pvcName: string): Promise<boolean>;
  listSandboxPods(): Promise<Array<{ name: string; sessionId: string; createdAt: number; phase: string }>>;
  listWarmPods(): Promise<WarmPodInfo[]>;
  /** Relabel a warm pod as a claimed sandbox (or update its session id). */
  patchPodLabels(podName: string, labels: Record<string, string | null>): Promise<void>;
  getServiceAddress(name: string): Promise<{ host: string; port: number } | null>;
  /** Capacity planning only; Kubernetes remains the real scheduler. */
  listNodes(): Promise<NodeInfo[]>;
}
