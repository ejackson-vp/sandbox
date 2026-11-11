/**
 * Kubernetes Pod shape for sandbox and warm-pool workloads. Keeping this out
 * of the provisioner makes the security-relevant spec independently reviewable.
 */
import * as k8s from "@kubernetes/client-node";
import type { SessionLimits } from "@x402s/shared/protocol";

export type PodEnvSpec = {
  executionMode: string;
  image: string;
  imageDigest: string;
  runtimeClass: string;
  proxyUrl: string;
  workspaceDir: string;
  guestToken: string;
  proxyToken: string;
  limits: SessionLimits;
};

export function annotationsFor(
  mode: string,
  extra: Record<string, string>,
  warning: string,
): Record<string, string> {
  return {
    "x402.io/mode": mode,
    ...extra,
    "x402.io/warning": warning,
  };
}

export function guestEnvFor(
  spec: PodEnvSpec,
  tools: string,
  extra: k8s.V1EnvVar[],
): k8s.V1EnvVar[] {
  return [
    ...extra,
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
    { name: "GUEST_TOOLS", value: tools },
  ];
}

export function bootstrapEnvFor(spec: PodEnvSpec, devMode: boolean): k8s.V1EnvVar[] {
  return [
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
}

export function baselineOf(limits: SessionLimits, cpu?: number, memory?: number) {
  return {
    cpuMillis: cpu ?? Math.max(50, Math.floor(limits.cpuMillis / 4)),
    memoryMiB: memory ?? Math.max(64, Math.floor(limits.memoryMiB / 4)),
  };
}

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

export function buildPod(namespace: string, opts: PodBuild): k8s.V1Pod {
  return {
    metadata: {
      name: opts.name,
      namespace,
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
