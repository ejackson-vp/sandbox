/**
 * The probe pod and the netprobe runner, shared by the isolation suites.
 *
 * Extracted from `network.test.ts` when the anonymous attacker suite needed the
 * same "send real packets from inside a sandbox" primitive. The pod spec is
 * security-relevant: it is the position an attacker actually gets (a guest
 * container in `sandbox-workloads`, with the same RuntimeClass and no
 * credentials), so it lives in one place rather than being copied per suite.
 *
 * `x402-netprobe` is built into the guest image and reads its cases from the
 * `PROBES` environment variable. Nothing here mocks a packet.
 */
import { clusterAvailable, deployConfig, kubectl } from "./kubectl.js";

export interface ProbeCase {
  name: string;
  kind: "tcp" | "dns" | "https-proxy" | "direct-https";
  target?: string;
  url?: string;
  proxy?: string;
  proxyToken?: string;
  hostname?: string;
  timeoutMs: number;
  expected: "allow" | "deny";
}

export interface ProbeOutcome {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

/**
 * The guest image the probe pod runs.
 *
 * The default is the local kind tag, so `make up && make security-test` is
 * unchanged. A cluster that pulls a released, digest-pinned image cannot pull
 * `x402-sandbox/guest:dev` (it is not in any registry), and the probe would sit
 * in ImagePullBackOff instead of testing a boundary. `PROBE_IMAGE`, or
 * `GUEST_IMAGE` (the variable the controller and `scripts/isolation-gate.sh`
 * already read), points the probe at the image actually under test.
 */
export const PROBE_IMAGE = defaultProbeImage();

/**
 * The image a probe pod can actually pull.
 *
 * Order: an explicit `PROBE_IMAGE`, then `GUEST_IMAGE` from the environment,
 * then the deployment's own `GUEST_IMAGE`/`GUEST_IMAGE_DIGEST` from its
 * ConfigMap, then the local kind tag. The cluster default matters: running this
 * suite against a released deployment without `GUEST_IMAGE` exported used to
 * leave the probe in ImagePullBackOff against `docker.io/x402-sandbox/guest:dev`,
 * which looks like an isolation failure and is a harness failure.
 */
function defaultProbeImage(): string {
  if (process.env.PROBE_IMAGE) return process.env.PROBE_IMAGE;
  if (process.env.GUEST_IMAGE) return process.env.GUEST_IMAGE;
  try {
    if (clusterAvailable()) {
      const image = deployConfig("GUEST_IMAGE");
      const digest = deployConfig("GUEST_IMAGE_DIGEST");
      if (image && /^sha256:[0-9a-f]{64}$/.test(digest)) return `${image}@${digest}`;
      if (image) return image;
    }
  } catch {
    // No cluster, or no ConfigMap read: fall through to the kind default.
  }
  return "x402-sandbox/guest:dev";
}

/** A guest container with the production RuntimeClass and no extra privilege. */
export function probePod(name: string): string {
  return `
apiVersion: v1
kind: Pod
metadata:
  name: ${name}
  namespace: sandbox-workloads
  labels: {x402.io/test-probe: "true"}
spec:
  runtimeClassName: x402-sandbox
  restartPolicy: Never
  automountServiceAccountToken: false
  enableServiceLinks: false
  dnsPolicy: None
  dnsConfig: {nameservers: ["127.0.0.1"], searches: [], options: []}
  nodeSelector: {x402.io/sandbox-pool: "true"}
  tolerations: [{key: x402.io/sandbox, operator: Exists, effect: NoSchedule}]
  securityContext: {runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, seccompProfile: {type: RuntimeDefault}}
  containers:
    - name: probe
      image: ${PROBE_IMAGE}
      imagePullPolicy: IfNotPresent
      command: ["/bin/sh", "-c", "sleep 900"]
      securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: ["ALL"]}}
      volumeMounts: [{name: w, mountPath: /run/x402}]
  volumes: [{name: w, emptyDir: {medium: Memory, sizeLimit: 32Mi}}]
`;
}

/** Run every case in one exec, so one pod serves a whole matrix. */
export function runProbes(
  pod: string,
  probes: ProbeCase[],
): Record<string, ProbeOutcome> {
  const payload = probes.map((probe) => ({
    name: probe.name,
    kind: probe.kind,
    target: probe.target,
    url: probe.url,
    proxy: probe.proxy,
    proxyToken: probe.proxyToken,
    hostname: probe.hostname,
    timeoutMs: probe.timeoutMs,
  }));
  const out = kubectl([
    "-n",
    "sandbox-workloads",
    "exec",
    pod,
    "--",
    "env",
    `PROBES=${JSON.stringify(payload)}`,
    "/usr/local/bin/x402-netprobe",
  ]);
  const results = JSON.parse(out.trim().split("\n").pop() ?? "[]") as ProbeOutcome[];
  return Object.fromEntries(results.map((result) => [result.name, result]));
}
