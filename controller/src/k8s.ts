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
import type { SessionLimits } from "@x402s/shared";
import { log } from "./log.js";
import type { Provisioner, SandboxPodSpec, WarmPodSpec, WarmPodInfo } from "./k8s-types.js";

export type { Provisioner, SandboxPodSpec, WarmPodSpec, WarmPodInfo } from "./k8s-types.js";
export { NullProvisioner } from "./k8s-null.js";

const LABEL_APP = "app.kubernetes.io/name";
const LABEL_SESSION = "x402.io/session";
const LABEL_POOL = "x402.io/pool";
const LABEL_WARM_ID = "x402.io/warm-id";

/** Tools baked into the trusted guest image. */
export const GUEST_TOOLS = ["python3", "node", "bash", "tar", "curl", "git"];

interface PodBuild {
  name: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  runtimeClass: string;
  limits: SessionLimits;
  workspaceDir: string;
  image: string;
  deadlineSeconds: number;
  guestEnv: k8s.V1EnvVar[];
  initEnv: k8s.V1EnvVar[];
  workspacePvc?: string;
  baselineCpuMillis: number;
  baselineMemoryMiB: number;
  nodeName?: string;
}

export class KubeProvisioner implements Provisioner {
  private readonly core: k8s.CoreV1Api;

  constructor(
    private readonly namespace: string,
    private readonly controlNamespace: string,
    kubeconfig?: k8s.KubeConfig,
  ) {
    const kc = kubeconfig ?? new k8s.KubeConfig();
    if (!kubeconfig) kc.loadFromDefault();
    this.core = kc.makeApiClient(k8s.CoreV1Api);
  }

  async createPod(spec: SandboxPodSpec): Promise<{ podName: string }> {
    const podName = `sbx-${spec.sessionId.replace(/^sbx_/, "")}`;
    const devMode = spec.executionMode !== "confidential";
    const annotations: Record<string, string> = {
      "x402.io/mode": spec.executionMode,
      "x402.io/lease-seconds": String(spec.leaseSeconds),
      "x402.io/cpu-millis": String(spec.limits.cpuMillis),
      "x402.io/memory-mib": String(spec.limits.memoryMiB),
      "x402.io/disk-mib": String(spec.limits.diskMiB),
    };
    if (devMode) {
      annotations["x402.io/confidential"] = "false";
      annotations["x402.io/warning"] = "NON-CONFIDENTIAL: simulated attestation only";
    } else {
      annotations["x402.io/confidential"] = "true";
    }

    const guestEnv = [
      { name: "SESSION_ID", value: spec.sessionId },
      { name: "RELAY_URL", value: spec.relayUrl },
      { name: "CLIENT_PUBLIC_KEY", value: spec.clientPublicKey },
      { name: "CLIENT_NONCE", value: spec.clientNonce },
      { name: "LEASE_SECONDS", value: String(spec.leaseSeconds) },
      { name: "EXECUTION_MODE", value: spec.executionMode },
      { name: "GUEST_IMAGE_REF", value: spec.image },
      { name: "GUEST_IMAGE_DIGEST", value: spec.imageDigest },
      { name: "RUNTIME_CLASS", value: spec.runtimeClass },
      { name: "EGRESS_PROXY_URL", value: spec.proxyUrl },
      { name: "WORKSPACE_DIR", value: spec.workspaceDir },
      { name: "MAX_OUTPUT_BYTES", value: String(spec.limits.maxOutputBytes) },
      { name: "MAX_FILE_BYTES", value: String(spec.limits.maxFileBytes) },
      { name: "MAX_DISK_MIB", value: String(spec.limits.diskMiB) },
      { name: "MAX_COMMAND_SECONDS", value: String(spec.limits.maxCommandSeconds) },
      { name: "MAX_PROCESSES", value: String(spec.limits.maxProcesses) },
      { name: "GUEST_TOOLS", value: GUEST_TOOLS.join(",") },
      ...(spec.resume ? [{ name: "RESUME", value: "1" }] : []),
    ];

    const initEnv: k8s.V1EnvVar[] = [
      { name: "GUEST_TOKEN", value: spec.guestToken },
      { name: "PROXY_TOKEN", value: spec.proxyToken },
      { name: "WORKSPACE_DIR", value: spec.workspaceDir },
      ...(devMode
        ? [
            { name: "DEV_ATTESTATION_KEY", value: process.env.DEV_ATTESTATION_KEY ?? "" },
            { name: "DEV_ATTESTATION_KEY_ID", value: process.env.DEV_ATTESTATION_KEY_ID ?? "" },
          ]
        : []),
    ];

    const pod = this.buildPod({
      name: podName,
      labels: {
        [LABEL_APP]: "x402-sandbox",
        [LABEL_SESSION]: spec.sessionId,
        [LABEL_POOL]: "sandbox",
      },
      annotations,
      runtimeClass: spec.runtimeClass,
      limits: spec.limits,
      workspaceDir: spec.workspaceDir,
      image: spec.image,
      deadlineSeconds: Math.ceil(spec.leaseSeconds + spec.limits.maxCommandSeconds + 300),
      guestEnv,
      initEnv,
      ...(spec.workspacePvc ? { workspacePvc: spec.workspacePvc } : {}),
      baselineCpuMillis: spec.baselineCpuMillis ?? Math.max(50, Math.floor(spec.limits.cpuMillis / 4)),
      baselineMemoryMiB: spec.baselineMemoryMiB ?? Math.max(64, Math.floor(spec.limits.memoryMiB / 4)),
      ...(spec.nodeName ? { nodeName: spec.nodeName } : {}),
    });

    try {
      await this.core.createNamespacedPod({ namespace: this.namespace, body: pod });
      log.info("sandbox_pod_created", {
        podName,
        sessionId: spec.sessionId,
        runtimeClass: spec.runtimeClass,
        cpuMillis: spec.limits.cpuMillis,
        memoryMiB: spec.limits.memoryMiB,
      });
    } catch (err) {
      if ((err as { code?: number }).code === 409) {
        log.info("sandbox_pod_exists", { podName });
      } else {
        throw err;
      }
    }
    return { podName };
  }

  async createWarmPod(spec: WarmPodSpec): Promise<{ podName: string }> {
    const podName = `warm-${spec.warmId}`;
    const devMode = spec.executionMode !== "confidential";
    const annotations: Record<string, string> = {
      "x402.io/mode": spec.executionMode,
      "x402.io/warm-pool": "true",
      "x402.io/cpu-millis": String(spec.limits.cpuMillis),
      "x402.io/memory-mib": String(spec.limits.memoryMiB),
      "x402.io/disk-mib": String(spec.limits.diskMiB),
    };
    if (devMode) {
      annotations["x402.io/confidential"] = "false";
      annotations["x402.io/warning"] = "NON-CONFIDENTIAL: warm pool, simulated attestation only";
    } else {
      annotations["x402.io/confidential"] = "true";
    }

    const guestEnv: k8s.V1EnvVar[] = [
      { name: "WARM_MODE", value: "true" },
      { name: "POOL_ID", value: spec.poolId },
      { name: "RELAY_URL", value: spec.relayUrl },
      { name: "WARM_TTL_SECONDS", value: String(Math.ceil(spec.ttlMs / 1000)) },
      { name: "EXECUTION_MODE", value: spec.executionMode },
      { name: "GUEST_IMAGE_REF", value: spec.image },
      { name: "GUEST_IMAGE_DIGEST", value: spec.imageDigest },
      { name: "RUNTIME_CLASS", value: spec.runtimeClass },
      { name: "EGRESS_PROXY_URL", value: spec.proxyUrl },
      { name: "WORKSPACE_DIR", value: spec.workspaceDir },
      { name: "MAX_OUTPUT_BYTES", value: String(spec.limits.maxOutputBytes) },
      { name: "MAX_FILE_BYTES", value: String(spec.limits.maxFileBytes) },
      { name: "MAX_DISK_MIB", value: String(spec.limits.diskMiB) },
      { name: "MAX_COMMAND_SECONDS", value: String(spec.limits.maxCommandSeconds) },
      { name: "MAX_PROCESSES", value: String(spec.limits.maxProcesses) },
      { name: "GUEST_TOOLS", value: spec.tools },
    ];

    const initEnv: k8s.V1EnvVar[] = [
      { name: "GUEST_TOKEN", value: spec.guestToken },
      { name: "PROXY_TOKEN", value: spec.proxyToken },
      { name: "WORKSPACE_DIR", value: spec.workspaceDir },
      ...(devMode
        ? [
            { name: "DEV_ATTESTATION_KEY", value: process.env.DEV_ATTESTATION_KEY ?? "" },
            { name: "DEV_ATTESTATION_KEY_ID", value: process.env.DEV_ATTESTATION_KEY_ID ?? "" },
          ]
        : []),
    ];

    const pod = this.buildPod({
      name: podName,
      labels: {
        [LABEL_APP]: "x402-sandbox",
        [LABEL_POOL]: "warm",
        [LABEL_WARM_ID]: spec.warmId,
      },
      annotations,
      runtimeClass: spec.runtimeClass,
      limits: spec.limits,
      workspaceDir: spec.workspaceDir,
      image: spec.image,
      // Backstop only: a claimed warm pod may serve any lease up to the
      // platform maximum, so keep the pod alive well past the pool TTL. The
      // controller still enforces the purchased lease independently.
      deadlineSeconds: Math.ceil(spec.ttlMs / 1000) + 3600,
      guestEnv,
      initEnv,
      baselineCpuMillis: Math.max(50, Math.floor(spec.limits.cpuMillis / 4)),
      baselineMemoryMiB: Math.max(64, Math.floor(spec.limits.memoryMiB / 4)),
    });

    try {
      await this.core.createNamespacedPod({ namespace: this.namespace, body: pod });
      log.info("warm_pod_created", {
        podName,
        poolId: spec.poolId,
        cpuMillis: spec.limits.cpuMillis,
        memoryMiB: spec.limits.memoryMiB,
      });
    } catch (err) {
      if ((err as { code?: number }).code === 409) {
        log.info("warm_pod_exists", { podName });
      } else {
        throw err;
      }
    }
    return { podName };
  }

  private buildPod(opts: PodBuild): k8s.V1Pod {
    return {
      metadata: {
        name: opts.name,
        namespace: this.namespace,
        labels: opts.labels,
        annotations: opts.annotations,
      },
      spec: {
        runtimeClassName: opts.runtimeClass,
        restartPolicy: "Never",
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        hostNetwork: false,
        hostPID: false,
        hostIPC: false,
        // Deliberately no usable DNS: the only nameserver is loopback, where
        // nothing listens. Customers reach the public internet through the
        // egress proxy, which resolves names itself.
        dnsPolicy: "None",
        dnsConfig: { nameservers: ["127.0.0.1"], searches: [], options: [] },
        nodeSelector: { "x402.io/sandbox-pool": "true" },
        ...(opts.nodeName
          ? {
              affinity: {
                nodeAffinity: {
                  requiredDuringSchedulingIgnoredDuringExecution: {
                    nodeSelectorTerms: [
                      {
                        matchFields: [
                          { key: "metadata.name", operator: "In", values: [opts.nodeName] },
                        ],
                      },
                    ],
                  },
                },
              },
            }
          : {}),
        tolerations: [{ key: "x402.io/sandbox", operator: "Exists", effect: "NoSchedule" }],
        // Backstop only: the controller enforces the lease independently.
        activeDeadlineSeconds: opts.deadlineSeconds,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 65532,
          runAsGroup: 65532,
          fsGroup: 65532,
          seccompProfile: { type: "RuntimeDefault" },
        },
        initContainers: [
          {
            // Moves the relay token and (dev-only) attestation key into a
            // mode-0400 file that the guest reads and deletes before any
            // customer payload arrives. Secrets never appear in the main
            // container's environment.
            name: "bootstrap",
            image: opts.image,
            imagePullPolicy: "IfNotPresent",
            command: ["/usr/local/bin/x402-guest", "bootstrap"],
            env: [
              ...opts.initEnv,
            ],
            securityContext: {
              allowPrivilegeEscalation: false,
              privileged: false,
              readOnlyRootFilesystem: true,
              runAsNonRoot: true,
              runAsUser: 65532,
              capabilities: { drop: ["ALL"] },
            },
            resources: { limits: { cpu: "100m", memory: "64Mi", "ephemeral-storage": "8Mi" } },
            volumeMounts: [
              { name: "runtime", mountPath: "/run/x402" },
              { name: "workspace", mountPath: opts.workspaceDir },
            ],
          },
        ],
        containers: [
          {
            name: "guest",
            image: opts.image,
            imagePullPolicy: "IfNotPresent",
            command: ["/usr/local/bin/x402-guest", "run"],
            env: opts.guestEnv,
            securityContext: {
              allowPrivilegeEscalation: false,
              privileged: false,
              readOnlyRootFilesystem: true,
              runAsNonRoot: true,
              runAsUser: 65532,
              capabilities: { drop: ["ALL"] },
            },
            resources: {
              requests: {
                cpu: `${opts.baselineCpuMillis}m`,
                memory: `${opts.baselineMemoryMiB}Mi`,
                "ephemeral-storage": "16Mi",
              },
              limits: {
                cpu: `${opts.limits.cpuMillis}m`,
                memory: `${opts.limits.memoryMiB}Mi`,
                "ephemeral-storage": `${opts.limits.diskMiB + 64}Mi`,
              },
            },
            volumeMounts: [
              { name: "runtime", mountPath: "/run/x402" },
              { name: "workspace", mountPath: opts.workspaceDir },
              { name: "tmp", mountPath: "/tmp" },
            ],
          },
        ],
        volumes: [
          opts.workspacePvc
            ? { name: "workspace", persistentVolumeClaim: { claimName: opts.workspacePvc } }
            : {
                name: "workspace",
                emptyDir: { medium: "Memory", sizeLimit: `${opts.limits.diskMiB + 32}Mi` },
              },
          // Bootstrap credentials live outside the customer workspace and are
          // deleted by the guest before any operation runs.
          { name: "runtime", emptyDir: { medium: "Memory", sizeLimit: "8Mi" } },
          { name: "tmp", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } },
        ],
      },
    };
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

  async getServiceAddress(name: string): Promise<{ host: string; port: number } | null> {
    try {
      const svc = await this.core.readNamespacedService({ name, namespace: this.controlNamespace });
      const ip = svc.spec?.clusterIP;
      const port = svc.spec?.ports?.[0]?.port;
      if (!ip || ip === "None" || !port) return null;
      return { host: ip, port };
    } catch (err) {
      if ((err as { code?: number }).code === 404) return null;
      throw err;
    }
  }
}

/** Used by unit tests only; cannot create workloads. */
