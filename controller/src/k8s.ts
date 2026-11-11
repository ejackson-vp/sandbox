/**
 * Kubernetes provisioner.
 *
 * The controller is the only component allowed to create sandbox pods. It never
 * accepts a customer-supplied PodSpec: the template is fixed here, uses a
 * mandatory RuntimeClass, mirrors the purchased resource limits into real
 * Kubernetes limits, and labels the pod with the session id for reaping.
 *
 * Warm pods are the same template, booted without a session. They carry the
 * pool labels (and therefore no session id) until a claim relabels them. The
 * claim itself travels over the relay, so customer identity never appears in
 * the warm pod's environment.
 */
import * as k8s from "@kubernetes/client-node";
import { log } from "@x402s/shared/runtime";
import { annotationsFor, baselineOf, bootstrapEnvFor, buildPod, guestEnvFor } from "./k8s-pod.js";
import { WARM_IDENTITY_ANNOTATION, WARM_IMAGE_DIGEST_ANNOTATION } from "./warm-pool-identity.js";
import { listNodes } from "./k8s-nodes.js";
import type { WorkspacePvcInfo } from "./checkpoint-retention.js";
import type { NodeInfo, Provisioner, SandboxPodSpec, WarmPodSpec, WarmPodInfo } from "./k8s-types.js";

export type { NodeInfo, Provisioner, SandboxPodSpec, WarmPodSpec, WarmPodInfo } from "./k8s-types.js";
export type { WorkspacePvcInfo } from "./checkpoint-retention.js";

export { NullProvisioner } from "./k8s-null.js";

const LABEL_APP = "app.kubernetes.io/name";
const LABEL_SESSION = "x402.io/session";
const LABEL_POOL = "x402.io/pool";
const LABEL_WARM_ID = "x402.io/warm-id";

/** Tools baked into the trusted guest image. */
export const GUEST_TOOLS = ["python3", "node", "bash", "tar", "curl", "git"];

export class KubeProvisioner implements Provisioner {
  private readonly core: k8s.CoreV1Api;
  private readonly discovery: k8s.DiscoveryV1Api;

  constructor(
    private readonly namespace: string,
    private readonly controlNamespace: string,
    kubeconfig?: k8s.KubeConfig,
  ) {
    const kc = kubeconfig ?? new k8s.KubeConfig();
    if (!kubeconfig) kc.loadFromDefault();
    this.core = kc.makeApiClient(k8s.CoreV1Api);
    this.discovery = kc.makeApiClient(k8s.DiscoveryV1Api);
  }

  async healthCheck(): Promise<void> {
    // One-pod list: proves the API server is reachable and that this identity
    // can still read the namespace the controller writes to. The result is
    // cached by the readiness probe, so this is not called at probe frequency.
    await this.core.listNamespacedPod({ namespace: this.namespace, limit: 1 });
  }

  async createPod(spec: SandboxPodSpec): Promise<{ podName: string }> {
    const podName = `sbx-${spec.sessionId.replace(/^sbx_/, "")}`;
    // No hardware-evidence path exists, so the guest always needs the dev key.
    const devMode = true;
    const baseline = baselineOf(spec.limits, spec.baselineCpuMillis, spec.baselineMemoryMiB);
    const pod = buildPod(this.namespace, {
      name: podName,
      labels: {
        [LABEL_APP]: "x402-sandbox",
        [LABEL_SESSION]: spec.sessionId,
        [LABEL_POOL]: "sandbox",
      },
      annotations: annotationsFor(
        spec.executionMode,
        {
          "x402.io/lease-seconds": String(spec.leaseSeconds),
          "x402.io/cpu-millis": String(spec.limits.cpuMillis),
          "x402.io/memory-mib": String(spec.limits.memoryMiB),
          "x402.io/disk-mib": String(spec.limits.diskMiB),
        },
        "NON-CONFIDENTIAL: simulated attestation only",
      ),
      runtimeClass: spec.runtimeClass,
      limits: spec.limits,
      workspaceDir: spec.workspaceDir,
      image: spec.image,
      deadlineSeconds: Math.ceil(spec.leaseSeconds + spec.limits.maxCommandSeconds + 300),
      guestEnv: guestEnvFor(spec, GUEST_TOOLS.join(","), [
        { name: "SESSION_ID", value: spec.sessionId },
        { name: "RELAY_URL", value: spec.relayUrl },
        { name: "CLIENT_PUBLIC_KEY", value: spec.clientPublicKey },
        { name: "CLIENT_NONCE", value: spec.clientNonce },
        { name: "LEASE_SECONDS", value: String(spec.leaseSeconds) },
        ...(spec.resume ? [{ name: "RESUME", value: "1" }] : []),
      ]),
      initEnv: bootstrapEnvFor(spec, devMode),
      ...(spec.workspacePvc ? { workspacePvc: spec.workspacePvc } : {}),
      baselineCpuMillis: baseline.cpuMillis,
      baselineMemoryMiB: baseline.memoryMiB,
      ...(spec.nodeName ? { nodeName: spec.nodeName } : {}),
    });

    await this.applyPod(pod, "sandbox_pod_created", {
      podName,
      sessionId: spec.sessionId,
      runtimeClass: spec.runtimeClass,
      cpuMillis: spec.limits.cpuMillis,
      memoryMiB: spec.limits.memoryMiB,
    }, "sandbox_pod_exists");
    return { podName };
  }

  async createWarmPod(spec: WarmPodSpec): Promise<{ podName: string }> {
    const podName = `warm-${spec.warmId}`;
    // No hardware-evidence path exists, so the guest always needs the dev key.
    const devMode = true;
    const baseline = baselineOf(spec.limits);
    const pod = buildPod(this.namespace, {
      name: podName,
      labels: {
        [LABEL_APP]: "x402-sandbox",
        [LABEL_POOL]: "warm",
        [LABEL_WARM_ID]: spec.warmId,
      },
      annotations: annotationsFor(
        spec.executionMode,
        {
          "x402.io/warm-pool": "true",
          [WARM_IDENTITY_ANNOTATION]: spec.identity,
          [WARM_IMAGE_DIGEST_ANNOTATION]: spec.imageDigest,
          "x402.io/cpu-millis": String(spec.limits.cpuMillis),
          "x402.io/memory-mib": String(spec.limits.memoryMiB),
          "x402.io/disk-mib": String(spec.limits.diskMiB),
        },
        "NON-CONFIDENTIAL: warm pool, simulated attestation only",
      ),
      runtimeClass: spec.runtimeClass,
      limits: spec.limits,
      workspaceDir: spec.workspaceDir,
      image: spec.image,
      // Backstop only: a claimed warm pod may serve any lease up to the
      // platform maximum, so keep the pod alive well past the pool TTL.
      deadlineSeconds: Math.ceil(spec.ttlMs / 1000) + 3600,
      guestEnv: guestEnvFor(spec, spec.tools, [
        { name: "WARM_MODE", value: "true" },
        { name: "POOL_ID", value: spec.poolId },
        { name: "RELAY_URL", value: spec.relayUrl },
        { name: "WARM_TTL_SECONDS", value: String(Math.ceil(spec.ttlMs / 1000)) },
      ]),
      initEnv: bootstrapEnvFor(spec, devMode),
      baselineCpuMillis: baseline.cpuMillis,
      baselineMemoryMiB: baseline.memoryMiB,
    });

    await this.applyPod(pod, "warm_pod_created", {
      podName,
      poolId: spec.poolId,
      cpuMillis: spec.limits.cpuMillis,
      memoryMiB: spec.limits.memoryMiB,
    }, "warm_pod_exists");
    return { podName };
  }

  private async applyPod(
    pod: k8s.V1Pod,
    createdEvent: string,
    fields: Record<string, unknown>,
    existsEvent: string,
  ): Promise<void> {
    try {
      await this.core.createNamespacedPod({ namespace: this.namespace, body: pod });
      log.info(createdEvent, fields);
    } catch (err) {
      if ((err as { code?: number }).code === 409) {
        log.info(existsEvent, { podName: pod.metadata?.name });
      } else {
        throw err;
      }
    }
  }

  async createWorkspacePvc(sessionId: string, sizeMiB: number): Promise<string> {
    const name = `x402-ws-${sessionId.replace(/^sbx_/, "")}`;
    const pvc: k8s.V1PersistentVolumeClaim = {
      metadata: {
        name,
        namespace: this.namespace,
        labels: { "x402.io/session": sessionId, "x402.io/pool": "workspace" },
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: process.env.WORKSPACE_STORAGE_CLASS ?? "standard",
        resources: { requests: { storage: `${Math.max(64, sizeMiB + 64)}Mi` } },
      },
    };
    try {
      await this.core.createNamespacedPersistentVolumeClaim({ namespace: this.namespace, body: pvc });
      log.info("workspace_pvc_created", { pvcName: name, sessionId });
    } catch (err) {
      if ((err as { code?: number }).code !== 409) throw err;
    }
    return name;
  }

  async deleteWorkspacePvc(pvcName: string): Promise<void> {
    try {
      await this.core.deleteNamespacedPersistentVolumeClaim({ name: pvcName, namespace: this.namespace });
      log.info("workspace_pvc_deleted", { pvcName });
    } catch (err) {
      if ((err as { code?: number }).code === 404) return;
      throw err;
    }
  }

  async suspendPod(podName: string): Promise<void> {
    // The workspace PVC is retained; only the compute goes away. Wait for the
    // pod to be fully gone before the resume path reuses the same name.
    await this.deletePod(podName, 0);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const pod = await this.getPod(podName).catch(() => null);
      if (!pod) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`pod ${podName} did not terminate in time`);
  }

  async deletePod(podName: string, gracePeriodSeconds = 0): Promise<void> {
    try {
      await this.core.deleteNamespacedPod({ name: podName, namespace: this.namespace, gracePeriodSeconds });
      log.info("sandbox_pod_deleted", { podName });
    } catch (err) {
      if ((err as { code?: number }).code === 404) return;
      throw err;
    }
  }

  async getPod(podName: string): Promise<{
    phase: string;
    deleted: boolean;
    imageID?: string;
    createdAt?: number;
    scheduledAt?: number;
    startedAt?: number;
  } | null> {
    try {
      const pod = await this.core.readNamespacedPod({ name: podName, namespace: this.namespace });
      const statuses = pod.status?.containerStatuses ?? [];
      const scheduled = pod.status?.conditions?.find((c) => c.type === "PodScheduled")?.lastTransitionTime;
      const started = statuses.find((s) => s.name === "guest")?.state?.running?.startedAt
        ?? statuses[0]?.state?.running?.startedAt;
      const ms = (value: unknown): number | undefined => {
        if (!value) return undefined;
        const t = new Date(value as string).getTime();
        return Number.isFinite(t) ? t : undefined;
      };
      return {
        phase: pod.status?.phase ?? "Unknown",
        deleted: Boolean(pod.metadata?.deletionTimestamp),
        imageID: statuses[0]?.imageID,
        createdAt: ms(pod.metadata?.creationTimestamp),
        scheduledAt: ms(scheduled),
        startedAt: ms(started),
        ...(pod.spec?.nodeName ? { nodeName: pod.spec.nodeName } : {}),
      };
    } catch (err) {
      if ((err as { code?: number }).code === 404) return null;
      throw err;
    }
  }

  async nodeAvailable(nodeName: string): Promise<boolean> {
    try {
      const node = await this.core.readNode({ name: nodeName });
      if (node.spec?.unschedulable) return false;
      const ready = node.status?.conditions?.find((c) => c.type === "Ready");
      return ready?.status === "True";
    } catch (err) {
      if ((err as { code?: number }).code === 404) return false;
      throw err;
    }
  }

  async workspacePvcExists(pvcName: string): Promise<boolean> {
    try {
      await this.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace: this.namespace });
      return true;
    } catch (err) {
      if ((err as { code?: number }).code === 404) return false;
      throw err;
    }
  }

  async listWorkspacePvcs(): Promise<WorkspacePvcInfo[]> {
    const res = await this.core.listNamespacedPersistentVolumeClaim({
      namespace: this.namespace,
      labelSelector: `${LABEL_POOL}=workspace`,
    });
    return (res.items ?? []).map((pvc) => ({
      name: pvc.metadata?.name ?? "",
      sessionId: pvc.metadata?.labels?.[LABEL_SESSION] ?? "",
      createdAt: pvc.metadata?.creationTimestamp
        ? new Date(pvc.metadata.creationTimestamp).getTime()
        : 0,
      deleting: Boolean(pvc.metadata?.deletionTimestamp),
    }));
  }

  async listSandboxPods(): Promise<Array<{ name: string; sessionId: string; createdAt: number; phase: string }>> {
    const res = await this.core.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: `${LABEL_APP}=x402-sandbox,${LABEL_POOL}=sandbox`,
    });
    return (res.items ?? []).map((pod) => ({
      name: pod.metadata?.name ?? "",
      sessionId: pod.metadata?.labels?.[LABEL_SESSION] ?? "",
      createdAt: pod.metadata?.creationTimestamp ? new Date(pod.metadata.creationTimestamp).getTime() : 0,
      phase: pod.status?.phase ?? "Unknown",
    }));
  }

  async listWarmPods(): Promise<WarmPodInfo[]> {
    const res = await this.core.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: `${LABEL_APP}=x402-sandbox,${LABEL_POOL}=warm`,
    });
    return (res.items ?? []).map((pod) => {
      const warmId = pod.metadata?.labels?.[LABEL_WARM_ID] ?? "";
      return {
        name: pod.metadata?.name ?? "",
        warmId,
        poolId: `warm_${warmId}`,
        createdAt: pod.metadata?.creationTimestamp ? new Date(pod.metadata.creationTimestamp).getTime() : 0,
        phase: pod.status?.phase ?? "Unknown",
        identity: pod.metadata?.annotations?.[WARM_IDENTITY_ANNOTATION] ?? "",
        imageDigest: pod.metadata?.annotations?.[WARM_IMAGE_DIGEST_ANNOTATION] ?? "",
        ...(pod.spec?.nodeName ? { nodeName: pod.spec.nodeName } : {}),
      };
    });
  }

  async patchPodLabels(podName: string, labels: Record<string, string | null>): Promise<void> {
    // The generated client defaults to application/json-patch+json, so send
    // explicit operations rather than a merge-patch object.
    const escape = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");
    const ops = Object.entries(labels).map(([key, value]) =>
      value === null
        ? { op: "remove", path: `/metadata/labels/${escape(key)}` }
        : { op: "add", path: `/metadata/labels/${escape(key)}`, value },
    );
    await this.core.patchNamespacedPod({
      name: podName,
      namespace: this.namespace,
      body: ops as unknown as k8s.V1Pod,
    });
    log.info("sandbox_pod_relabeled", { podName, labels: Object.keys(labels).join(",") });
  }

  listNodes(): Promise<NodeInfo[]> {
    return listNodes(this.core);
  }

  /**
   * Resolve a Service to an address a sandbox can actually dial.
   *
   * Returns a ready endpoint address, not the ClusterIP. A Kata sandbox runs its
   * own kernel, so Cilium's eBPF service translation never sees its packets: a
   * ClusterIP is simply an unroutable address inside the microVM, and connects
   * hang until timeout. Pod IPs are routed normally, so an endpoint works.
   *
   * Falls back to the ClusterIP only when no endpoint is ready, which preserves
   * the previous behaviour for container runtimes that can use it.
   *
   * `shard` selects one replica of a StatefulSet behind a headless Service. The
   * endpoint hostname is the StatefulSet pod name (`relay-0`), which is not
   * derived from the Service name: a sharded lookup reads `relay-headless`, and
   * its endpoints are still named `relay-0`. Match the ordinal suffix, not
   * `${name}-${shard}`, which would look for `relay-headless-0`. The suffix
   * cannot collide because `-1` does not suffix `-11`.
   * There is no ClusterIP fallback on this path: a ClusterIP load-balances
   * across replicas, which is the misrouting the shard prevents.
   * A shard with no ready endpoint resolves to null.
   */
  async getServiceAddress(
    name: string,
    shard?: number,
    podPrefix?: string,
  ): Promise<{ host: string; port: number } | null> {
    try {
      const svc = await this.core.readNamespacedService({ name, namespace: this.controlNamespace });
      const port = svc.spec?.ports?.[0]?.port;
      if (!port) return null;

      const slices = await this.discovery.listNamespacedEndpointSlice({
        namespace: this.controlNamespace,
        labelSelector: `kubernetes.io/service-name=${name}`,
      });
      const ready = (slices.items ?? [])
        .flatMap((slice) => slice.endpoints ?? [])
        .filter((endpoint) => endpoint.conditions?.ready !== false);

      if (shard !== undefined) {
        // Endpoint hostnames are the StatefulSet pod names (`relay-0`), which
        // come from the workload, not from the headless Service
        // (`relay-headless`). Match the workload prefix exactly, so an endpoint
        // from another workload cannot be mistaken for this shard.
        const hostname = `${podPrefix ?? name}-${shard}`;
        const shardIp = ready
          .filter((endpoint) => endpoint.hostname === hostname)
          .flatMap((endpoint) => endpoint.addresses ?? [])[0];
        return shardIp ? { host: shardIp, port } : null;
      }

      const endpointIp = ready.flatMap((endpoint) => endpoint.addresses ?? [])[0];
      if (endpointIp) return { host: endpointIp, port };

      const ip = svc.spec?.clusterIP;
      if (!ip || ip === "None") return null;
      return { host: ip, port };
    } catch (err) {
      if ((err as { code?: number }).code === 404) return null;
      throw err;
    }
  }
}

/** Used by unit tests only; cannot create workloads. */
