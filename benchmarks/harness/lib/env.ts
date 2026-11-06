/**
 * Environment capture and operator-side measurement helpers.
 *
 * Everything in this file is benchmark tooling: it reads node/container cgroups
 * through `docker exec`/`kubectl exec` because metrics-server is not installed.
 * None of this is reachable from a sandbox.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { arch, release, type } from "node:os";
import { sleep } from "./util.js";

export const KUBECTL_CONTEXT = process.env.KUBECTL_CONTEXT ?? `kind-${process.env.KIND_CLUSTER ?? "x402-sandbox"}`;
export const WORKER = process.env.BENCH_WORKER ?? "x402-sandbox-worker";
export const CONTROL_NODE = process.env.BENCH_CONTROL_NODE ?? "x402-sandbox-control-plane";
export const API_URL = process.env.API_URL ?? "http://localhost:8080";
export const NAMESPACE = "sandbox-system";
export const SANDBOX_NS = "sandbox-workloads";

export function sh(cmd: string, args: string[], input?: string): string {
  const res = spawnSync(cmd, args, { encoding: "utf8", input, maxBuffer: 32 * 1024 * 1024 });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const err = new Error(`${cmd} ${args.join(" ")} exited ${res.status}: ${(res.stderr ?? "").slice(0, 400)}`);
    (err as Error & { stderr?: string }).stderr = res.stderr ?? "";
    throw err;
  }
  return res.stdout ?? "";
}

export function kubectl(args: string[], input?: string): string {
  return sh("kubectl", ["--context", KUBECTL_CONTEXT, ...args], input);
}

export function kubectlTry(args: string[], input?: string): { ok: boolean; out: string } {
  try {
    return { ok: true, out: kubectl(args, input) };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };
    return { ok: false, out: e.stderr ?? e.stdout ?? e.message };
  }
}

export function kubectlJson<T>(args: string[]): T {
  return JSON.parse(kubectl([...args, "-o", "json"])) as T;
}

export function nodeSh(node: string, script: string): string {
  return sh("docker", ["exec", node, "sh", "-c", script]);
}

export function dockerStats(): Array<{ name: string; cpu: number; memBytes: number; memLimit: number }> {
  const out = sh("docker", ["stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"]).trim();
  return out
    .split("\n")
    .filter((line) => line.includes("x402-sandbox"))
    .map((line) => {
      const [name, cpu, mem] = line.split("\t");
      const cpuPct = Number((cpu ?? "0%").replace("%", ""));
      const [used] = (mem ?? "0").split(" / ");
      return {
        name: name!,
        cpu: Number.isFinite(cpuPct) ? cpuPct : 0,
        memBytes: parseDockerBytes(used ?? "0"),
        memLimit: parseDockerBytes((mem ?? "0").split(" / ")[1] ?? "0"),
      };
    });
}

export function parseDockerBytes(value: string): number {
  const m = /^([\d.]+)\s*([KMGTP]?i?B)$/i.exec(value.trim());
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2]!.toUpperCase();
  const mult: Record<string, number> = {
    B: 1,
    KB: 1e3,
    MB: 1e6,
    GB: 1e9,
    KIB: 1024,
    MIB: 1024 ** 2,
    GIB: 1024 ** 3,
  };
  return n * (mult[unit] ?? 1);
}

export interface NodeInfo {
  name: string;
  cpu: string;
  memory: string;
  pods: string;
  kernel: string;
  runtime: string;
  internalIp: string;
}

export function nodes(): { worker: NodeInfo; control: NodeInfo | null; allocatableRaw: Record<string, string> } {
  const list = kubectlJson<{
    items: Array<{
      metadata: { name: string };
      status: {
        capacity: Record<string, string>;
        allocatable: Record<string, string>;
        nodeInfo: { kernelVersion: string; containerRuntimeVersion: string };
        addresses: Array<{ type: string; address: string }>;
      };
    }>;
  }>(["get", "nodes"]);
  const toInfo = (item: (typeof list.items)[number]): NodeInfo => ({
    name: item.metadata.name,
    cpu: item.status.allocatable.cpu ?? "?",
    memory: item.status.allocatable.memory ?? "?",
    pods: item.status.allocatable.pods ?? "?",
    kernel: item.status.nodeInfo.kernelVersion,
    runtime: item.status.nodeInfo.containerRuntimeVersion,
    internalIp: item.status.addresses.find((a) => a.type === "InternalIP")?.address ?? "?",
  });
  const worker = list.items.find((i) => i.metadata.name === WORKER) ?? list.items[0]!;
  const control = list.items.find((i) => i.metadata.name === CONTROL_NODE) ?? null;
  return {
    worker: toInfo(worker),
    control: control ? toInfo(control) : null,
    allocatableRaw: worker.status.allocatable,
  };
}

export interface HostInfo {
  platform: string;
  arch: string;
  release: string;
  cpus: number;
  memBytes: number;
  dockerVersion: string;
  dockerCpus: number;
  dockerMemBytes: number;
  kindVersion: string;
  kubectlVersion: string;
  kvm: boolean;
  gitCommit: string;
  node: NodeInfo;
  controlNode: NodeInfo | null;
  imageIds: Record<string, string>;
  apiUrl: string;
}

function sysctl(name: string): string {
  try {
    return sh("sysctl", ["-n", name]).trim();
  } catch {
    return "";
  }
}

export function captureHost(): HostInfo {
  let dockerVersion = "unknown";
  let dockerCpus = 0;
  let dockerMemBytes = 0;
  try {
    dockerVersion = sh("docker", ["info", "--format", "{{.ServerVersion}}"]).trim();
    dockerCpus = Number(sh("docker", ["info", "--format", "{{.NCPU}}"]).trim());
    dockerMemBytes = Number(sh("docker", ["info", "--format", "{{.MemTotal}}"]).trim());
  } catch {
    /* docker unavailable */
  }
  let kindVersion = "unknown";
  try {
    kindVersion = sh("kind", ["version"]).trim().split("\n")[0]!;
  } catch {
    /* ignore */
  }
  let kubectlVersion = "unknown";
  try {
    kubectlVersion = JSON.parse(sh("kubectl", ["version", "--client", "-o", "json"])).clientVersion.gitVersion;
  } catch {
    /* ignore */
  }
  let gitCommit = "unknown";
  try {
    gitCommit = sh("git", ["rev-parse", "--short", "HEAD"]).trim();
  } catch {
    /* ignore */
  }
  const imageIds: Record<string, string> = {};
  const images = kubectlTry(["-n", SANDBOX_NS, "get", "pods", "-o", "jsonpath={range .items[*]}{.spec.containers[0].image}{'\\t'}{.status.containerStatuses[0].imageID}{'\\n'}{end}"]);
  for (const line of images.out.split("\n").filter(Boolean)) {
    const [ref, id] = line.split("\t");
    if (ref && id) imageIds[ref] = id;
  }
  const n = nodes();
  return {
    platform: `${type()} ${release()}`,
    arch: arch(),
    release: sysctl("kern.osrelease"),
    cpus: Number(sysctl("hw.ncpu")) || 0,
    memBytes: Number(sysctl("hw.memsize")) || 0,
    dockerVersion,
    dockerCpus,
    dockerMemBytes,
    kindVersion,
    kubectlVersion,
    kvm: existsSync("/dev/kvm"),
    gitCommit,
    node: n.worker,
    controlNode: n.control,
    imageIds,
    apiUrl: API_URL,
  };
}

/** Node-level memory/CPU as seen by the kind node container. */
export function nodeUsage(node = WORKER): { memBytes: number; cpuUsec: number } {
  try {
    const mem = Number(nodeSh(node, "cat /sys/fs/cgroup/memory.current").trim());
    const stat = nodeSh(node, "grep '^usage_usec' /sys/fs/cgroup/cpu.stat").trim();
    const cpuUsec = Number(stat.split(/\s+/)[1] ?? 0);
    return { memBytes: Number.isFinite(mem) ? mem : 0, cpuUsec: Number.isFinite(cpuUsec) ? cpuUsec : 0 };
  } catch {
    return { memBytes: 0, cpuUsec: 0 };
  }
}

/**
 * Memory/CPU of a control-plane component container, read from its own cgroup.
 * The components run as uid 1000 with a readable /sys/fs/cgroup.
 */
export function componentUsage(label: string): { memBytes: number; cpuUsec: number; pids: number } {
  const script =
    "cat /sys/fs/cgroup/memory.current 2>/dev/null; " +
    "grep '^usage_usec' /sys/fs/cgroup/cpu.stat 2>/dev/null | awk '{print $2}'; " +
    "cat /sys/fs/cgroup/pids.current 2>/dev/null";
  const res = kubectlTry(["-n", NAMESPACE, "exec", `deploy/${label}`, "--", "sh", "-c", script]);
  if (!res.ok) return { memBytes: 0, cpuUsec: 0, pids: 0 };
  const [mem, cpu, pids] = res.out.trim().split("\n");
  return {
    memBytes: Number(mem) || 0,
    cpuUsec: Number(cpu) || 0,
    pids: Number(pids) || 0,
  };
}

export interface SandboxUsage {
  memCurrent: number;
  memAnon: number;
  memFile: number;
  memPeak: number;
  cpuUsec: number;
  throttledUsec: number;
  nrThrottled: number;
  pids: number;
}

/** Read the sandbox container's own cgroup counters via one SDK command. */
export function sandboxUsageCommand(): string[] {
  return [
    "bash",
    "-c",
    [
      "cat /sys/fs/cgroup/memory.current",
      "awk '/^anon /{print $2}' /sys/fs/cgroup/memory.stat",
      "awk '/^file /{print $2}' /sys/fs/cgroup/memory.stat",
      "cat /sys/fs/cgroup/memory.peak",
      "awk '/^usage_usec/{print $2}' /sys/fs/cgroup/cpu.stat",
      "awk '/^throttled_usec/{print $2}' /sys/fs/cgroup/cpu.stat",
      "awk '/^nr_throttled/{print $2}' /sys/fs/cgroup/cpu.stat",
      "cat /sys/fs/cgroup/pids.current",
    ].join("; "),
  ];
}

export function parseSandboxUsage(stdout: string): SandboxUsage {
  const [memCurrent, memAnon, memFile, memPeak, cpuUsec, throttledUsec, nrThrottled, pids] = stdout
    .trim()
    .split("\n")
    .map((v) => Number(v) || 0);
  return {
    memCurrent: memCurrent ?? 0,
    memAnon: memAnon ?? 0,
    memFile: memFile ?? 0,
    memPeak: memPeak ?? 0,
    cpuUsec: cpuUsec ?? 0,
    throttledUsec: throttledUsec ?? 0,
    nrThrottled: nrThrottled ?? 0,
    pids: pids ?? 0,
  };
}

export function apiMetrics(): Record<string, number> {
  try {
    const text = sh("curl", ["-fsS", `${API_URL}/metrics`]);
    return parseProm(text);
  } catch {
    return {};
  }
}

export function controllerMetrics(): Record<string, number> {
  const res = kubectlTry([
    "-n",
    NAMESPACE,
    "exec",
    "deploy/controller",
    "--",
    "node",
    "-e",
    "fetch('http://127.0.0.1:3001/metrics').then(r=>r.text()).then(t=>process.stdout.write(t))",
  ]);
  return res.ok ? parseProm(res.out) : {};
}

export function relayMetrics(): Record<string, number> {
  const res = kubectlTry([
    "-n",
    NAMESPACE,
    "exec",
    "deploy/relay",
    "--",
    "node",
    "-e",
    "fetch('http://127.0.0.1:8443/metrics').then(r=>r.text()).then(t=>process.stdout.write(t))",
  ]);
  return res.ok ? parseProm(res.out) : {};
}

function parseProm(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = /^([a-zA-Z_:][\w:]*)(?:\{[^}]*\})?\s+([\d.eE+-]+)$/.exec(line.trim());
    if (m) out[m[1]!] = Number(m[2]);
  }
  return out;
}

/** Delete every sandbox pod (operator cleanup after interrupted runs). */
export function sweepSandboxes(): number {
  const selector = "app.kubernetes.io/name=x402-sandbox,x402.io/pool=sandbox";
  const before = kubectlTry(["-n", SANDBOX_NS, "get", "pods", "-l", selector, "--no-headers"]).out;
  const count = before.split("\n").filter(Boolean).length;
  if (count > 0) {
    kubectlTry(["-n", SANDBOX_NS, "delete", "pods", "-l", selector, "--grace-period=0", "--force"]);
  }
  return count;
}

export function sandboxPodCount(): number {
  const out = kubectlTry([
    "-n",
    SANDBOX_NS,
    "get",
    "pods",
    "-l",
    "app.kubernetes.io/name=x402-sandbox,x402.io/pool=sandbox",
    "--no-headers",
  ]).out;
  return out.split("\n").filter(Boolean).length;
}

/** Per-session checkpoint PVCs. */
export function workspacePvcCount(): number {
  const out = kubectlTry([
    "-n",
    SANDBOX_NS,
    "get",
    "pvc",
    "-l",
    "x402.io/pool=workspace",
    "--no-headers",
  ]).out;
  return out.split("\n").filter(Boolean).length;
}

/** Idle pool pods (not session pods). */
export function warmPodCount(): number {
  const out = kubectlTry([
    "-n",
    SANDBOX_NS,
    "get",
    "pods",
    "-l",
    "app.kubernetes.io/name=x402-sandbox,x402.io/pool=warm",
    "--no-headers",
  ]).out;
  return out.split("\n").filter(Boolean).length;
}

export function podFor(sessionId: string): { phase: string; ready: boolean } | null {
  const res = kubectlTry([
    "-n",
    SANDBOX_NS,
    "get",
    "pod",
    `sbx-${sessionId.replace(/^sbx_/, "")}`,
    "-o",
    "jsonpath={.status.phase}{\"\\t\"}{.status.containerStatuses[0].ready}",
  ]);
  if (!res.ok) return null;
  const [phase, ready] = res.out.split("\t");
  return { phase: phase ?? "Unknown", ready: ready === "true" };
}

export async function waitForNoSandboxPods(timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (sandboxPodCount() === 0) return true;
    await sleep(200);
  }
  return false;
}

export async function waitForPodGone(sessionId: string, timeoutMs = 60_000): Promise<number | null> {
  const started = Date.now();
  while (Date.now() < started + timeoutMs) {
    if (!podFor(sessionId)) return Date.now() - started;
    await sleep(100);
  }
  return null;
}

/** Allocated requests on the worker (what the scheduler can fit). */
export function allocatedRequests(): { cpuMillis: number; memoryBytes: number; pods: number } {
  const out = kubectlTry(["describe", "node", WORKER]).out;
  const allocatable = kubectlJson<{ status: { allocatable: Record<string, string> } }>(["get", "node", WORKER]).status
    .allocatable;
  // `kubectl describe node` prints:
  //   cpu                250m (1%)   1 (7%)
  //   memory             128Mi (1%)  512Mi (6%)
  const cpu = /^\s*cpu\s+([\d.]+)(m?)\s+\(/m.exec(out);
  const mem = /^\s*memory\s+([\d.]+)(Ki|Mi|Gi)\s+\(/m.exec(out);
  const pods = /^\s*pods\s+(\d+)\s+\(/m.exec(out);
  const memUnits = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3 } as const;
  return {
    cpuMillis: cpu ? Number(cpu[1]) * (cpu[2] === "m" ? 1 : 1000) : 0,
    memoryBytes: mem ? Number(mem[1]) * (memUnits[mem[2] as "Ki" | "Mi" | "Gi"] ?? 1) : 0,
    pods: pods ? Number(pods[1]) : 0,
    allocatableCpuMillis: Number(String(allocatable.cpu ?? "0").replace("m", "")) * (String(allocatable.cpu ?? "").endsWith("m") ? 1 : 1000),
    allocatableMemoryBytes: parseK8sQuantity(allocatable.memory ?? "0"),
    allocatablePods: Number(allocatable.pods ?? 0),
  } as { cpuMillis: number; memoryBytes: number; pods: number };
}

export function parseK8sQuantity(value: string): number {
  const m = /^([\d.]+)(Ki|Mi|Gi|K|M|G)?$/.exec(value.trim());
  if (!m) return 0;
  const n = Number(m[1]);
  const units: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, K: 1e3, M: 1e6, G: 1e9 };
  return n * (m[2] ? units[m[2]] ?? 1 : 1);
}

/** Remove the guest image from the worker's containerd (cold-start tests). */
export function evictImageFromWorker(ref: string): { ok: boolean; out: string } {
  try {
    const out = sh("docker", ["exec", WORKER, "crictl", "rmi", ref]);
    return { ok: true, out };
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    return { ok: false, out: e.stderr ?? e.message };
  }
}

export function workerHasImage(ref: string): boolean {
  try {
    const out = sh("docker", ["exec", WORKER, "crictl", "images", "-q", ref]).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}
