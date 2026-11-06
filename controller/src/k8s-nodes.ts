/**
 * Node capacity mapping for the controller's admission model. Kubernetes
 * remains the scheduler; this is read-only planning input.
 */
import type * as k8s from "@kubernetes/client-node";
import type { NodeInfo } from "./k8s-types.js";

function parseCpuMillis(value: string | undefined): number {
  if (!value) return 0;
  const n = Number(value.endsWith("m") ? value.slice(0, -1) : value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(value.endsWith("m") ? n : n * 1000);
}

function parseBytes(value: string | undefined): number {
  if (!value) return 0;
  const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/.exec(value);
  if (!match) return 0;
  const n = Number(match[1]);
  const unit = match[2] ?? "";
  const factor =
    unit === "Ki" ? 1024 :
    unit === "Mi" ? 1024 ** 2 :
    unit === "Gi" ? 1024 ** 3 :
    unit === "Ti" ? 1024 ** 4 :
    unit === "k" ? 1000 :
    unit === "M" ? 1000 ** 2 :
    unit === "G" ? 1000 ** 3 :
    unit === "T" ? 1000 ** 4 : 1;
  return Math.max(0, Math.round(n * factor));
}

export async function listNodes(core: k8s.CoreV1Api): Promise<NodeInfo[]> {
  const result = await core.listNode();
  return result.items.map((node) => {
    const allocatable = node.status?.allocatable ?? {};
    const ready = node.status?.conditions?.some(
      (condition) => condition.type === "Ready" && condition.status === "True",
    ) ?? false;
    return {
      name: node.metadata?.name ?? "unknown",
      allocatableCpuMillis: parseCpuMillis(allocatable.cpu),
      allocatableMemoryBytes: parseBytes(allocatable.memory),
      allocatableStorageBytes: parseBytes(allocatable["ephemeral-storage"]),
      labels: node.metadata?.labels ?? {},
      taints: (node.spec?.taints ?? []).map((taint) => ({
        key: taint.key,
        effect: (taint.effect ?? "NoSchedule") as NodeInfo["taints"][number]["effect"],
      })),
      ready,
      schedulable: node.spec?.unschedulable !== true,
    };
  });
}
