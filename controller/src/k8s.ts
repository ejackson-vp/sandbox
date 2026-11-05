/**
 * Kubernetes provisioner.
 *
 * The controller is the only component allowed to create sandbox pods. It never
 * accepts a customer-supplied PodSpec: the pod template is fixed here, uses a
 * mandatory RuntimeClass, and is labelled with the session id for reaping.
 */
import * as k8s from "@kubernetes/client-node";
import { log } from "./log.js";

export interface SandboxPodSpec {
  sessionId: string;
  durationSeconds: number;
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
  executionMode: "dev" | "kata" | "confidential";
  guestMeasurementPolicy?: string;
}

export interface Provisioner {
  createPod(spec: SandboxPodSpec): Promise<{ podName: string }>;
  deletePod(podName: string, gracePeriodSeconds?: number): Promise<void>;
  getPod(podName: string): Promise<{ phase: string; deleted: boolean; imageID?: string } | null>;
  listSandboxPods(): Promise<Array<{ name: string; sessionId: string; createdAt: number; phase: string }>>;
  getServiceAddress(name: string): Promise<{ host: string; port: number } | null>;
}

const LABEL_APP = "app.kubernetes.io/name";
const LABEL_SESSION = "x402.io/session";

export class KubeProvisioner implements Provisioner {
  private readonly core: k8s.CoreV1Api;

  constructor(
    private readonly namespace: string,
    private readonly controlNamespace: string,
    private readonly kubeconfig?: k8s.KubeConfig,
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
      "x402.io/duration-seconds": String(spec.durationSeconds),
    };
    if (devMode) {
      // Loud, machine-checkable marker so nobody mistakes this for confidential.
      annotations["x402.io/confidential"] = "false";
      annotations["x402.io/warning"] = "NON-CONFIDENTIAL: simulated attestation only";
    } else {
      annotations["x402.io/confidential"] = "true";
    }

    const pod: k8s.V1Pod = {
      metadata: {
        name: podName,
        namespace: this.namespace,
        labels: {
          [LABEL_APP]: "x402-sandbox",
          [LABEL_SESSION]: spec.sessionId,
          "x402.io/pool": "sandbox",
        },
        annotations,
      },
      spec: {
        runtimeClassName: spec.runtimeClass,
        restartPolicy: "Never",
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        hostNetwork: false,
        hostPID: false,
        hostIPC: false,
        // Deliberately no usable DNS: the only nameserver is loopback, where
        // nothing listens. Customers reach the public internet only through the
        // egress proxy, which resolves names itself. NetworkPolicy also denies
        // all DNS traffic as defence in depth.
        dnsPolicy: "None",
        dnsConfig: { nameservers: ["127.0.0.1"], searches: [], options: [] },
        nodeSelector: { "x402.io/sandbox-pool": "true" },
        tolerations: [{ key: "x402.io/sandbox", operator: "Exists", effect: "NoSchedule" }],
        // Backstop only: the controller has an independent, shorter deadline.
        activeDeadlineSeconds: Math.ceil(spec.durationSeconds + 150),
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
            image: spec.image,
            imagePullPolicy: "IfNotPresent",
            command: ["/usr/local/bin/x402-guest", "bootstrap"],
            env: [
              { name: "GUEST_TOKEN", value: spec.guestToken },
              { name: "PROXY_TOKEN", value: spec.proxyToken },
              ...(devMode
                ? [
                    { name: "DEV_ATTESTATION_KEY", value: process.env.DEV_ATTESTATION_KEY ?? "" },
                    { name: "DEV_ATTESTATION_KEY_ID", value: process.env.DEV_ATTESTATION_KEY_ID ?? "" },
                  ]
                : []),
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
            volumeMounts: [{ name: "workspace", mountPath: "/run/x402" }],
          },
        ],
        containers: [
          {
            name: "guest",
            image: spec.image,
            imagePullPolicy: "IfNotPresent",
            command: ["/usr/local/bin/x402-guest", "run"],
            env: [
              { name: "SESSION_ID", value: spec.sessionId },
              { name: "RELAY_URL", value: spec.relayUrl },
              { name: "CLIENT_PUBLIC_KEY", value: spec.clientPublicKey },
              { name: "CLIENT_NONCE", value: spec.clientNonce },
              { name: "EXEC_DURATION_SECONDS", value: String(spec.durationSeconds) },
              { name: "EXECUTION_MODE", value: spec.executionMode },
              { name: "GUEST_IMAGE_REF", value: spec.image },
              { name: "GUEST_IMAGE_DIGEST", value: spec.imageDigest },
              { name: "RUNTIME_CLASS", value: spec.runtimeClass },
              { name: "EGRESS_PROXY_URL", value: spec.proxyUrl },
              { name: "MAX_OUTPUT_BYTES", value: "65536" },
            ],
            securityContext: {
              allowPrivilegeEscalation: false,
              privileged: false,
              readOnlyRootFilesystem: true,
              runAsNonRoot: true,
              runAsUser: 65532,
              capabilities: { drop: ["ALL"] },
            },
            resources: {
              requests: { cpu: "100m", memory: "128Mi", "ephemeral-storage": "16Mi" },
              limits: { cpu: "500m", memory: "512Mi", "ephemeral-storage": "64Mi" },
            },
            volumeMounts: [
              { name: "workspace", mountPath: "/run/x402" },
              { name: "tmp", mountPath: "/tmp" },
            ],
          },
        ],
        volumes: [
          { name: "workspace", emptyDir: { medium: "Memory", sizeLimit: "32Mi" } },
          { name: "tmp", emptyDir: { medium: "Memory", sizeLimit: "32Mi" } },
        ],
      },
    };

    try {
      await this.core.createNamespacedPod({ namespace: this.namespace, body: pod });
      log.info("sandbox_pod_created", { podName, sessionId: spec.sessionId, runtimeClass: spec.runtimeClass });
    } catch (err) {
      const status = (err as { code?: number }).code;
      if (status === 409) {
        log.info("sandbox_pod_exists", { podName });
      } else {
        throw err;
      }
    }
    return { podName };
  }

  async deletePod(podName: string, gracePeriodSeconds = 0): Promise<void> {
    try {
      await this.core.deleteNamespacedPod({ name: podName, namespace: this.namespace, gracePeriodSeconds });
      log.info("sandbox_pod_deleted", { podName });
    } catch (err) {
      const status = (err as { code?: number }).code;
      if (status === 404) return;
      throw err;
    }
  }

  async getPod(podName: string): Promise<{ phase: string; deleted: boolean; imageID?: string } | null> {
    try {
      const pod = await this.core.readNamespacedPod({ name: podName, namespace: this.namespace });
      const statuses = pod.status?.containerStatuses ?? [];
      return {
        phase: pod.status?.phase ?? "Unknown",
        deleted: Boolean(pod.metadata?.deletionTimestamp),
        imageID: statuses[0]?.imageID,
      };
    } catch (err) {
      if ((err as { code?: number }).code === 404) return null;
      throw err;
    }
  }

  async listSandboxPods(): Promise<Array<{ name: string; sessionId: string; createdAt: number; phase: string }>> {
    const res = await this.core.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: `${LABEL_APP}=x402-sandbox`,
    });
    return (res.items ?? []).map((pod) => ({
      name: pod.metadata?.name ?? "",
      sessionId: pod.metadata?.labels?.[LABEL_SESSION] ?? "",
      createdAt: pod.metadata?.creationTimestamp ? new Date(pod.metadata.creationTimestamp).getTime() : 0,
      phase: pod.status?.phase ?? "Unknown",
    }));
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
export class NullProvisioner implements Provisioner {
  async createPod(): Promise<{ podName: string }> {
    throw new Error("NullProvisioner cannot create pods");
  }
  async deletePod(): Promise<void> {}
  async getPod(): Promise<null> {
    return null;
  }
  async listSandboxPods(): Promise<[]> {
    return [];
  }
  async getServiceAddress(): Promise<null> {
    return null;
  }
}
