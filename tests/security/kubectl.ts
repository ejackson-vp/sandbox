/**
 * Small kubectl helper for cluster-backed tests.
 */
import { execFileSync } from "node:child_process";

export const CONTEXT = process.env.KUBECTL_CONTEXT ?? `kind-${process.env.KIND_CLUSTER ?? "x402-sandbox"}`;

export function kubectl(args: string[], input?: string): string {
  return execFileSync("kubectl", ["--context", CONTEXT, ...args], {
    input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

export function kubectlTry(args: string[], input?: string): { ok: boolean; out: string } {
  try {
    return { ok: true, out: kubectl(args, input) };
  } catch (err) {
    return { ok: false, out: (err as { stderr?: string; message: string }).stderr ?? (err as Error).message };
  }
}

export function kubectlJson<T>(args: string[]): T {
  return JSON.parse(kubectl([...args, "-o", "json"])) as T;
}

export function clusterAvailable(): boolean {
  const res = kubectlTry(["get", "namespace", "sandbox-system"]);
  return res.ok;
}

/** A value the deployment was configured with, read from the live ConfigMap. */
export function deployConfig(key: string): string {
  return kubectl([
    "-n",
    "sandbox-system",
    "get",
    "configmap",
    "control-config",
    "-o",
    `jsonpath={.data.${key}}`,
  ]).trim();
}

/**
 * A ready EndpointSlice address for a Service in `sandbox-system`: what the
 * deployment tells a guest to dial.
 *
 * A ClusterIP is not reachable from inside a Kata microVM. The guest has its own
 * TCP stack, so Cilium's socket/veth-level service translation never happens and
 * the VIP is routed nowhere (docs/networking.md, "Service addressing inside a
 * microVM"). The controller therefore resolves the egress proxy to an endpoint
 * address and, with `RELAY_GUEST_ADDRESS=pod`, the relay to a shard endpoint.
 * Probing the VIP tests the runc data path and reports the addressing mode as an
 * isolation failure; probe what the guest is actually given.
 */
export function serviceEndpoint(service: string): string {
  const slices = kubectlJson<{
    items: Array<{
      endpoints?: Array<{ addresses?: string[]; conditions?: { ready?: boolean } }>;
    }>;
  }>(["-n", "sandbox-system", "get", "endpointslices", "-l", `kubernetes.io/service-name=${service}`]);
  const ready = (slices.items ?? []).flatMap((slice) =>
    (slice.endpoints ?? [])
      .filter((endpoint) => endpoint.conditions?.ready !== false)
      .flatMap((endpoint) => endpoint.addresses ?? []),
  );
  if (ready.length === 0) throw new Error(`no ready endpoint address for service/${service}`);
  return ready[0]!;
}

export function applyYaml(yaml: string): void {
  kubectl(["apply", "-f", "-"], yaml);
}

export function deleteQuietly(args: string[]): void {
  kubectlTry(["delete", ...args, "--ignore-not-found", "--grace-period=0", "--force"]);
}
