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
import { kubectl } from "./kubectl.js";

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
      image: x402-sandbox/guest:dev
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
