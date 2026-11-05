/**
 * Local process provisioner.
 *
 * Runs the real guest binary as a child process instead of a pod. Used by
 * `make dev-local` and the integration test suite; it exercises every control
 * plane path (relay, attestation, deadlines, reconciliation, cleanup) but does
 * NOT provide Kubernetes isolation. It is never selected when
 * KUBERNETES_ENABLED=true.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provisioner, SandboxPodSpec } from "./k8s.js";

interface LocalPod {
  name: string;
  sessionId: string;
  spec: SandboxPodSpec;
  proc: ChildProcess;
  createdAt: number;
  phase: string;
  stderr: string;
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
    const workDir = join(this.workRoot, spec.sessionId);
    mkdirSync(workDir, { recursive: true });

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SESSION_ID: spec.sessionId,
      RELAY_URL: spec.relayUrl,
      GUEST_TOKEN: spec.guestToken,
      CLIENT_PUBLIC_KEY: spec.clientPublicKey,
      CLIENT_NONCE: spec.clientNonce,
      EXEC_DURATION_SECONDS: String(spec.durationSeconds),
      EXECUTION_MODE: spec.executionMode,
      RUNTIME_CLASS: spec.runtimeClass,
      GUEST_IMAGE_DIGEST: spec.imageDigest,
      MAX_OUTPUT_BYTES: "65536",
      X402_SANDBOX_DIR: workDir,
      DEV_ATTESTATION_KEY: process.env.DEV_ATTESTATION_KEY ?? "",
      DEV_ATTESTATION_KEY_ID: process.env.DEV_ATTESTATION_KEY_ID ?? "",
      EGRESS_PROXY_URL: `http://${this.opts.proxyHost}:${this.opts.proxyPort}`,
      PROXY_TOKEN: spec.proxyToken,
      LOG_LEVEL: process.env.GUEST_LOG_LEVEL ?? "warn",
    };

    const proc = spawn(this.opts.binary, ["run"], { env, stdio: ["ignore", "ignore", "pipe"] });
    const pod: LocalPod = {
      name: podName,
      sessionId: spec.sessionId,
      spec,
      proc,
      createdAt: Date.now(),
      phase: "Running",
      stderr: "",
    };
    proc.stderr?.on("data", (chunk: Buffer) => {
      // Keep a bounded tail for diagnostics only; guest logs never contain
      // customer code or output.
      pod.stderr = (pod.stderr + chunk.toString()).slice(-4096);
    });
    proc.on("exit", () => {
      pod.phase = "Succeeded";
    });
    this.pods.set(podName, pod);
    return { podName };
  }

  async deletePod(podName: string): Promise<void> {
    const pod = this.pods.get(podName);
    if (!pod) return;
    if (pod.proc.exitCode === null) pod.proc.kill("SIGKILL");
    pod.phase = "Succeeded";
    this.pods.delete(podName);
  }

  async getPod(podName: string): Promise<{ phase: string; deleted: boolean } | null> {
    const pod = this.pods.get(podName);
    if (!pod) return null;
    return { phase: pod.phase, deleted: false };
  }

  async listSandboxPods(): Promise<Array<{ name: string; sessionId: string; createdAt: number; phase: string }>> {
    return [...this.pods.values()].map((p) => ({
      name: p.name,
      sessionId: p.sessionId,
      createdAt: p.createdAt,
      phase: p.phase,
    }));
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
