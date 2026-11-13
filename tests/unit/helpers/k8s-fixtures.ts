/**
 * Specs and wire-shape readers for the provisioner tests.
 *
 * Split out of `k8s-provisioner.test.ts` only to keep that file under the
 * structural line budget. The values here are deliberately boring: a test that
 * cares about one field overrides it, so a change to a default in
 * `k8s-pod.ts` shows up as a failure in the test that pins it rather than as a
 * diff in ten fixtures.
 */
import { KubeProvisioner, type SandboxPodSpec, type WarmPodSpec } from "../../../controller/src/k8s.js";
import type { SessionLimits } from "@x402s/shared/protocol";
import type { FakeApiServer } from "../../helpers/fake-apiserver.js";

export const NAMESPACE = "sandbox-workloads";
export const CONTROL_NAMESPACE = "sandbox-system";

export function provisioner(api: FakeApiServer): KubeProvisioner {
  return new KubeProvisioner(NAMESPACE, CONTROL_NAMESPACE, api.kubeConfig());
}

export function limits(overrides: Partial<SessionLimits> = {}): SessionLimits {
  return {
    cpuMillis: 1500,
    memoryMiB: 2048,
    diskMiB: 1024,
    maxOutputBytes: 1_048_576,
    maxFileBytes: 33_554_432,
    maxCommandSeconds: 120,
    maxProcesses: 64,
    ...overrides,
  };
}

export function sandboxSpec(overrides: Partial<SandboxPodSpec> = {}): SandboxPodSpec {
  return {
    sessionId: "sbx_0123456789abcdef",
    leaseSeconds: 600,
    limits: limits(),
    clientPublicKey: "client-public-key",
    clientNonce: "client-nonce",
    guestToken: "guest-token",
    relayUrl: "wss://relay.internal:8443",
    relayHost: "relay",
    relayPort: 8443,
    proxyUrl: "http://egress-proxy:3128",
    proxyToken: "proxy-token",
    image: "registry.internal/x402-guest:dev",
    imageDigest: "sha256:guest",
    runtimeClass: "kata-fc",
    executionMode: "kata",
    workspaceDir: "/workspace",
    ...overrides,
  };
}

export function warmSpec(overrides: Partial<WarmPodSpec> = {}): WarmPodSpec {
  return {
    warmId: "warm0a1b2c3d",
    poolId: "pool-a",
    ttlMs: 60_000,
    limits: limits(),
    guestToken: "guest-token",
    relayUrl: "wss://relay.internal:8443",
    proxyUrl: "http://egress-proxy:3128",
    proxyToken: "proxy-token",
    image: "registry.internal/x402-guest:dev",
    imageDigest: "sha256:guest",
    runtime: "base",
    runtimeProfile: "",
    identity: "identity-hash",
    runtimeClass: "kata-fc",
    executionMode: "kata",
    workspaceDir: "/workspace",
    tools: "python3,node",
    ...overrides,
  };
}

/** The Pod as JSON, which is the shape the apiserver stores and schedules. */
export interface SentContainer {
  name: string;
  image: string;
  env: Array<{ name: string; value?: string }>;
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
}

export interface SentVolume {
  name: string;
  emptyDir?: { medium?: string; sizeLimit?: string };
  persistentVolumeClaim?: { claimName?: string };
}

export interface SentPod {
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
  };
  spec: {
    runtimeClassName: string;
    activeDeadlineSeconds: number;
    dnsPolicy: string;
    automountServiceAccountToken: boolean;
    nodeSelector: Record<string, string>;
    affinity?: {
      nodeAffinity?: {
        requiredDuringSchedulingIgnoredDuringExecution?: {
          nodeSelectorTerms?: Array<{ matchFields?: Array<{ key: string; values?: string[] }> }>;
        };
      };
    };
    containers: SentContainer[];
    initContainers: SentContainer[];
    volumes: SentVolume[];
  };
}

export function createdPod(api: FakeApiServer): SentPod {
  const [request] = api.calls("POST", /\/pods$/);
  if (!request) throw new Error("the provisioner created no pod");
  return request.body as SentPod;
}

export function container(pod: SentPod, name: string): SentContainer {
  const found = [...pod.spec.containers, ...pod.spec.initContainers].find(
    (candidate) => candidate.name === name,
  );
  if (!found) throw new Error(`the sent pod has no ${name} container`);
  return found;
}

export function envOf(pod: SentPod, name: string): Record<string, string> {
  return Object.fromEntries(
    container(pod, name).env.map((entry) => [entry.name, entry.value ?? ""]),
  );
}
