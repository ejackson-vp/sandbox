/**
 * Local process provisioner.
 *
 * Runs the real guest binary as a child process instead of a pod. Used by
 * `make dev-local` and the integration test suite; it exercises every control
 * plane path (lease, relay RPC, attestation, filesystem, deadlines) but does
 * NOT provide Kubernetes isolation. It is never selected when
 * KUBERNETES_ENABLED=true.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
}

export interface LocalProvisionerOptions {
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
        nodeName: "local",
      }));
  }

  async patchPodLabels(podName: string, labels: Record<string, string | null>): Promise<void> {
    const pod = this.pods.get(podName);
    if (!pod) return;
    if (labels["x402.io/session"]) pod.sessionId = labels["x402.io/session"]!;
    if (labels["x402.io/pool"] === "sandbox") pod.warm = false;
  }

  async getServiceAddress(name: string): Promise<{ host: string; port: number } | null> {
    if (name === "relay") return { host: this.opts.relayHost, port: this.opts.relayPort };
    if (name === "egress-proxy") return { host: this.opts.proxyHost, port: this.opts.proxyPort };
    return null;
  }

  diagnostics(podName: string): string | undefined {
    return this.pods.get(podName)?.stderr;
  }
}
