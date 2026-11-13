/**
 * Resolve the workload that owns a control-plane target.
 *
 * The relay is a StatefulSet (stable identity and its own service); the API and
 * controller are Deployments. The fault harness used to hardcode
 * `deploy/<target>`, so every relay kill died on
 * `deployments.apps "relay" not found` before it could measure convergence.
 */
import { execFileSync } from "node:child_process";

function exists(namespace: string, kind: string, target: string): boolean {
  try {
    execFileSync("kubectl", ["-n", namespace, "get", kind, target, "-o", "name"], {
      encoding: "utf8",
      // Probing the wrong kind is expected; kubectl's "not found" line on
      // stderr is not a harness error and polluted the fault logs.
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export function workloadRef(namespace: string, target: string): string {
  for (const kind of ["deploy", "statefulset"] as const) {
    if (exists(namespace, kind, target)) return `${kind}/${target}`;
  }
  throw new Error(`no Deployment or StatefulSet named ${target} in ${namespace}`);
}
