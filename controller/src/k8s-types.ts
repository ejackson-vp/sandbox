/**
 * Kubernetes provisioner contract and pod specs.
 */
import type { SessionLimits } from "@x402s/shared/protocol";
import type { WorkspacePvcInfo } from "./checkpoint-retention.js";

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
  /** Runtime profile name; empty/absent means the base guest image. */
  runtimeProfile?: string;
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
  /** Runtime profile this pod booted; a claim from another profile is a miss. */
  runtime: string;
  /**
   * Value for the guest's `RUNTIME_PROFILE`: the profile name, or empty for
   * `base`, whose image carries no manifest.
   */
  runtimeProfile: string;
  /** Hash of the boot identity; a claim requires an exact match. */
  identity: string;
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
  /** Runtime profile the pod booted; empty on pods from before profiles. */
  runtime: string;
  /** Empty on pods created before identity annotations existed. */
  identity: string;
  imageDigest: string;
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
  /**
   * Cheap readiness probe: throws when the provisioner cannot reach the
   * Kubernetes API (or, locally, cannot spawn the guest). Optional so test
   * doubles and future provisioners do not have to implement it.
   */
  healthCheck?(): Promise<void>;
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
  /** Labelled workspace PVCs, for orphan retention. */
  listWorkspacePvcs(): Promise<WorkspacePvcInfo[]>;
  listSandboxPods(): Promise<Array<{ name: string; sessionId: string; createdAt: number; phase: string }>>;
  listWarmPods(): Promise<WarmPodInfo[]>;
  /** Relabel a warm pod as a claimed sandbox (or update its session id). */
  patchPodLabels(podName: string, labels: Record<string, string | null>): Promise<void>;
  /** Resolve a Service to a dialable endpoint; `shard` selects one replica. */
  getServiceAddress(name: string, shard?: number, podPrefix?: string): Promise<{ host: string; port: number } | null>;
  /**
   * Resolve a Service to its ClusterIP, never to an endpoint Pod IP.
   *
   * This is the address a guest is given. A sandbox guest runs with
   * `dnsPolicy: None` and no DNS egress, so it cannot resolve a Service name,
   * and a Pod IP dies with the Pod: a relay replacement would leave every
   * guest on the shard dialling a dead address forever. The ClusterIP survives
   * Pod replacement and is DNAT'd to a live backend.
   *
   * Above one replica `shard` selects the per-shard Service named
   * `<podPrefix>-<shard>` (for example `relay-0`), which selects exactly that
   * StatefulSet Pod. At one replica `shard` is undefined and `name` is used.
   */
  getStableServiceAddress(
    name: string,
    shard?: number,
    podPrefix?: string,
  ): Promise<{ host: string; port: number } | null>;
  /** Capacity planning only; Kubernetes remains the real scheduler. */
  listNodes(): Promise<NodeInfo[]>;
}
