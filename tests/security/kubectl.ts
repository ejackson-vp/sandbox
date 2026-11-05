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

export function applyYaml(yaml: string): void {
  kubectl(["apply", "-f", "-"], yaml);
}

export function deleteQuietly(args: string[]): void {
  kubectlTry(["delete", ...args, "--ignore-not-found", "--grace-period=0", "--force"]);
}
