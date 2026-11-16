/**
 * Local process provisioner.
 *
 * Runs the real guest binary as a child process instead of a pod. Used by
 * `make dev-local` and the integration test suite; it exercises every control
 * plane path (lease, relay RPC, attestation, filesystem, deadlines) but does
 * NOT provide Kubernetes isolation. It is never selected when
 * KUBERNETES_ENABLED=true.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
/** Stopped ("T") or running state of a pid, via ps. Empty on error. */
function processStateOf(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim()[0] ?? "";
  } catch {
    return "";
  }
}

import { join } from "node:path";
import type { WorkspacePvcInfo } from "./checkpoint-retention.js";
import type { NodeInfo, Provisioner, SandboxPodSpec, WarmPodInfo, WarmPodSpec } from "./k8s.js";
import { GUEST_TOOLS } from "./k8s.js";

interface LocalPod {
  name: string;
  sessionId: string;
  proc: ChildProcess;
  createdAt: number;
  phase: string;
  workDir: string;
  stderr: string;
  warm: boolean;
  warmId?: string;
  identity?: string;
  imageDigest?: string;
  runtime?: string;
}

interface LocalProvisionerOptions {
  binary: string;
  relayHost: string;
  relayPort: number;
  proxyHost: string;
  proxyPort: number;
  workRoot?: string;
}

export class LocalProvisioner implements Provisioner {
  private readonly pods = new Map<string, LocalPod>();
  private readonly workRoot: string;

  constructor(private readonly opts: LocalProvisionerOptions) {
    this.workRoot = opts.workRoot ?? join(tmpdir(), "x402-local-sandboxes");
    mkdirSync(this.workRoot, { recursive: true });
  }

  async healthCheck(): Promise<void> {
    // A local provisioner is only as ready as the guest binary it spawns.
    accessSync(this.opts.binary, constants.X_OK);
  }

  async createPod(spec: SandboxPodSpec): Promise<{ podName: string }> {
    const podName = `local-${spec.sessionId}`;
    const existing = this.pods.get(podName);
    if (existing && existing.phase !== "Succeeded" && existing.phase !== "Failed") {
      return { podName };
    }
    if (existing) this.pods.delete(podName);
    const workDir = join(this.workRoot, spec.sessionId);
    const workspace = join(workDir, "workspace");
    mkdirSync(workspace, { recursive: true });

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SESSION_ID: spec.sessionId,
      RELAY_URL: spec.relayUrl,
      GUEST_TOKEN: spec.guestToken,
      CLIENT_PUBLIC_KEY: spec.clientPublicKey,
      CLIENT_NONCE: spec.clientNonce,
      LEASE_SECONDS: String(spec.leaseSeconds),
      EXECUTION_MODE: spec.executionMode,
      RUNTIME_CLASS: spec.runtimeClass,
      ...(spec.runtimeProfile ? { RUNTIME_PROFILE: spec.runtimeProfile } : {}),
      GUEST_IMAGE_DIGEST: spec.imageDigest,
      WORKSPACE_DIR: workspace,
      X402_SANDBOX_DIR: workDir,
      MAX_OUTPUT_BYTES: String(spec.limits.maxOutputBytes),
      MAX_FILE_BYTES: String(spec.limits.maxFileBytes),
      MAX_DISK_MIB: String(spec.limits.diskMiB),
      MAX_COMMAND_SECONDS: String(spec.limits.maxCommandSeconds),
      MAX_PROCESSES: String(spec.limits.maxProcesses),
      GUEST_TOOLS: GUEST_TOOLS.join(","),
      DEV_ATTESTATION_KEY: process.env.DEV_ATTESTATION_KEY ?? "",
      DEV_ATTESTATION_KEY_ID: process.env.DEV_ATTESTATION_KEY_ID ?? "",
      EGRESS_PROXY_URL: `http://${this.opts.proxyHost}:${this.opts.proxyPort}`,
      PROXY_TOKEN: spec.proxyToken,
      ...(spec.resume ? { RESUME: "1" } : {}),
      LOG_LEVEL: process.env.GUEST_LOG_LEVEL ?? "warn",
    };

    const proc = spawn(this.opts.binary, ["run"], { env, stdio: ["ignore", "ignore", "pipe"] });
    const pod: LocalPod = {
      name: podName,
      sessionId: spec.sessionId,
      proc,
      createdAt: Date.now(),
      phase: "Running",
      workDir,
      stderr: "",
      warm: false,
    };
    proc.stderr?.on("data", (chunk: Buffer) => {
      // Bounded tail for diagnostics only; guest logs never contain customer
      // code, file contents or output.
      pod.stderr = (pod.stderr + chunk.toString()).slice(-4096);
    });
    proc.on("exit", () => {
      pod.phase = "Succeeded";
    });
    this.pods.set(podName, pod);
    return { podName };
  }

  async createWarmPod(spec: WarmPodSpec): Promise<{ podName: string }> {
    const podName = `local-warm-${spec.warmId}`;
    const workDir = join(this.workRoot, `warm-${spec.warmId}`);
    const workspace = join(workDir, "workspace");
    mkdirSync(workspace, { recursive: true });

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      WARM_MODE: "true",
      POOL_ID: spec.poolId,
      RELAY_URL: spec.relayUrl,
      WARM_TTL_SECONDS: String(Math.ceil(spec.ttlMs / 1000)),
      GUEST_TOKEN: spec.guestToken,
      EXECUTION_MODE: spec.executionMode,
      RUNTIME_CLASS: spec.runtimeClass,
      ...(spec.runtimeProfile ? { RUNTIME_PROFILE: spec.runtimeProfile } : {}),
      GUEST_IMAGE_DIGEST: spec.imageDigest,
      WORKSPACE_DIR: workspace,
      X402_SANDBOX_DIR: workDir,
      MAX_OUTPUT_BYTES: String(spec.limits.maxOutputBytes),
      MAX_FILE_BYTES: String(spec.limits.maxFileBytes),
      MAX_DISK_MIB: String(spec.limits.diskMiB),
      MAX_COMMAND_SECONDS: String(spec.limits.maxCommandSeconds),
      MAX_PROCESSES: String(spec.limits.maxProcesses),
      GUEST_TOOLS: spec.tools,
      DEV_ATTESTATION_KEY: process.env.DEV_ATTESTATION_KEY ?? "",
      DEV_ATTESTATION_KEY_ID: process.env.DEV_ATTESTATION_KEY_ID ?? "",
      EGRESS_PROXY_URL: spec.proxyUrl,
      PROXY_TOKEN: spec.proxyToken,
      LOG_LEVEL: process.env.GUEST_LOG_LEVEL ?? "warn",
    };

    const proc = spawn(this.opts.binary, ["run"], { env, stdio: ["ignore", "ignore", "pipe"] });
    const pod: LocalPod = {
      name: podName,
      sessionId: "",
      proc,
      createdAt: Date.now(),
      phase: "Running",
      workDir,
      stderr: "",
      warm: true,
      warmId: spec.warmId,
      identity: spec.identity,
      imageDigest: spec.imageDigest,
      runtime: spec.runtime,
    };
    proc.stderr?.on("data", (chunk: Buffer) => {
      pod.stderr = (pod.stderr + chunk.toString()).slice(-4096);
    });
    proc.on("exit", () => {
      pod.phase = "Succeeded";
    });
    this.pods.set(podName, pod);
    return { podName };
  }

  async createWorkspacePvc(sessionId: string, _sizeMiB: number): Promise<string> {
    return `local-ws-${sessionId.replace(/^sbx_/, "")}`;
  }

  async deleteWorkspacePvc(pvcName: string): Promise<void> {
    const sessionId = pvcName.replace(/^local-ws-/, "sbx_");
    rmSync(join(this.workRoot, sessionId), { recursive: true, force: true });
  }

  async suspendPod(podName: string): Promise<void> {
    const pod = this.pods.get(podName);
    if (!pod) return;
    if (pod.proc.exitCode === null) pod.proc.kill("SIGKILL");
    pod.phase = "Suspended";
    this.pods.delete(podName);
    // Keep workDir for the resume.
  }

  async deletePod(podName: string): Promise<void> {
    const pod = this.pods.get(podName);
    if (!pod) return;
    if (pod.proc.exitCode === null) pod.proc.kill("SIGKILL");
    pod.phase = "Succeeded";
    this.pods.delete(podName);
    rmSync(pod.workDir, { recursive: true, force: true });
  }

  async listNodes(): Promise<NodeInfo[]> {
    const mib = 1024 * 1024;
    return [{
      name: "local",
      allocatableCpuMillis: Number(process.env.CAPACITY_LOCAL_CPU_MILLICORES ?? 14_000),
      allocatableMemoryBytes: Number(process.env.CAPACITY_LOCAL_MEMORY_MIB ?? 4_096) * mib,
      allocatableStorageBytes: Number(process.env.CAPACITY_LOCAL_STORAGE_MIB ?? 20_480) * mib,
      labels: { "x402.io/sandbox-pool": "true" },
      taints: [],
      ready: true,
      schedulable: true,
    }];
  }

  async nodeAvailable(): Promise<boolean> {
    return true;
  }

  async workspacePvcExists(pvcName: string): Promise<boolean> {
    const sessionId = pvcName.replace(/^local-ws-/, "sbx_");
    return existsSync(join(this.workRoot, sessionId, "workspace"));
  }

  async listWorkspacePvcs(): Promise<WorkspacePvcInfo[]> {
    // Local mode keeps each session's workspace under workRoot/<session>/workspace.
    // There is no controller-owned PVC object, so the directory mtime is the age.
    if (!existsSync(this.workRoot)) return [];
    const out: WorkspacePvcInfo[] = [];
    for (const sessionId of readdirSync(this.workRoot)) {
      if (!sessionId.startsWith("sbx_")) continue;
      const dir = join(this.workRoot, sessionId, "workspace");
      if (!existsSync(dir)) continue;
      let createdAt = 0;
      try {
        const stat = statSync(dir);
        createdAt = stat.birthtimeMs || stat.mtimeMs;
      } catch {
        /* raced with deletion; leave the age unknown */
      }
      out.push({
        name: `local-ws-${sessionId.replace(/^sbx_/, "")}`,
        sessionId,
        createdAt,
        deleting: false,
      });
    }
    return out;
  }

  async getPod(podName: string): Promise<{
    phase: string;
    deleted: boolean;
    createdAt?: number;
    scheduledAt?: number;
    startedAt?: number;
    nodeName?: string;
  } | null> {
    const pod = this.pods.get(podName);
    if (!pod) return null;
    return {
      phase: pod.phase,
      deleted: false,
      createdAt: pod.createdAt,
      scheduledAt: pod.createdAt,
      startedAt: pod.createdAt,
    };
  }

  async listSandboxPods(): Promise<Array<{ name: string; sessionId: string; createdAt: number; phase: string }>> {
    return [...this.pods.values()]
      .filter((p) => !p.warm)
      .map((p) => ({
        name: p.name,
        sessionId: p.sessionId,
        createdAt: p.createdAt,
        phase: p.phase,
        nodeName: "local",
      }));
  }

  async listWarmPods(): Promise<WarmPodInfo[]> {
    return [...this.pods.values()]
      .filter((p) => p.warm && p.warmId)
      .map((p) => ({
        name: p.name,
        warmId: p.warmId!,
        poolId: `warm_${p.warmId}`,
        createdAt: p.createdAt,
        phase: p.phase,
        runtime: p.runtime ?? "",
        identity: p.identity ?? "",
        imageDigest: p.imageDigest ?? "",
        nodeName: "local",
      }));
  }

  async patchPodLabels(podName: string, labels: Record<string, string | null>): Promise<void> {
    const pod = this.pods.get(podName);
    if (!pod) return;
    if (labels["x402.io/session"]) pod.sessionId = labels["x402.io/session"]!;
    if (labels["x402.io/pool"] === "sandbox") pod.warm = false;
  }

  /**
   * Local mode has no Service or Pod IP: each data plane is one process on a
   * fixed host and port, which is as stable as it gets and survives a restart
   * of that process. Sharding does not exist here.
   */
  async getStableServiceAddress(
    name: string,
    shard?: number,
    podPrefix?: string,
  ): Promise<{ host: string; port: number } | null> {
    return this.getServiceAddress(name, shard, podPrefix);
  }

  async getServiceAddress(name: string, _shard?: number, _podPrefix?: string): Promise<{ host: string; port: number } | null> {
    // Local process mode has one of each service and no sharding.
    if (name === "relay") return { host: this.opts.relayHost, port: this.opts.relayPort };
    if (name === "egress-proxy") return { host: this.opts.proxyHost, port: this.opts.proxyPort };
    return null;
  }

  /**
   * Test/dev hook: deliver a signal to a running guest process. Used to make
   * "a frame forwarded but not yet observed" deterministic (`SIGSTOP`), which
   * is not otherwise reproducible without a real network fault.
   */
  signalPod(podName: string, signal: NodeJS.Signals): boolean {
    const pod = this.pods.get(podName);
    if (!pod || pod.proc.exitCode !== null) return false;
    const sent = pod.proc.kill(signal);
    const pid = pod.proc.pid;
    if (!sent || signal !== "SIGSTOP" || !pid) return sent;
    // SIGSTOP is asynchronous: kill returns once the signal is queued, not once
    // the guest has stopped. A caller that forwards a frame immediately after
    // can race the delivery, and the guest executes a frame the test believes is
    // still unread. This hook exists to make "forwarded but not yet observed"
    // deterministic, so it is only useful once the stop is observable. Poll for
    // state T and fail closed on timeout rather than report a stop that did not
    // happen.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (processStateOf(pid) === "T") return true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    throw new Error(`guest ${podName} did not stop within 2s of SIGSTOP`);
  }

  diagnostics(podName: string): string | undefined {
    return this.pods.get(podName)?.stderr;
  }
}
