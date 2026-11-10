/**
 * Test harness for the real Go guest: starts a relay, spawns the supervisor,
 * verifies its evidence, and issues encrypted operations directly (no API).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fromBase64,
  generateBoxKeyPair,
  generateNonce,
  openSealedJson,
  sealJsonTo,
  toBase64,
  verifyAttestation,
  type AttestationEnvelope,
  type GuestRequest,
  type GuestResult,
} from "../../shared/src/index.js";
import { createRelay, type RelayServer, type RelayTlsOptions } from "../../controller/src/relay.js";
import { RelayClient, type RelayClientTlsOptions } from "../../controller/src/relay-client.js";

export const DEV_SEED = "qSgP+dPwGhb/58O0ZD/dSqCMovhhWNIQbT3MeTD35WY=";
export const DEV_KEY_ID = "x402-dev-attestation-key-INSECURE-DEV-ONLY";

export interface GuestOptions {
  port: number;
  /**
   * When set, the control routes move to an mTLS listener on `controlPort` and
   * the harness's RelayClient presents the client certificate. The guest
   * WebSocket stays on the plaintext `port`.
   */
  controlPort?: number;
  relayTls?: RelayTlsOptions;
  relayClientTls?: RelayClientTlsOptions;
  leaseSeconds?: number;
  maxFileBytes?: number;
  maxDiskMiB?: number;
  maxOutputBytes?: number;
  maxCommandSeconds?: number;
  workspaceRoot?: string;
  extraEnv?: Record<string, string>;
  /** Execution epoch this harness's controller generation sends on frames. */
  execEpoch?: number;
}

export class GuestHarness {
  readonly sessionId = `sbx_${randomBytes(12).toString("hex")}`;
  readonly guestToken = randomBytes(24).toString("base64url");
  clientKeys!: Awaited<ReturnType<typeof generateBoxKeyPair>>;
  clientNonce!: string;
  relay!: RelayServer;
  relayClient!: RelayClient;
  proc?: ChildProcess;
  workspace = "";
  stderr = "";
  evidence?: AttestationEnvelope;
  guestKey?: Uint8Array;

  constructor(readonly opts: GuestOptions) {}

  async start(): Promise<void> {
    this.clientKeys = await generateBoxKeyPair();
    this.clientNonce = toBase64(await generateNonce());
    const dir = this.opts.workspaceRoot ?? (await mkdtemp(join(tmpdir(), "x402-guest-")));
    this.workspace = join(dir, "workspace");
    this.relay = createRelay({
      adminToken: "harness-admin-token-0123456789",
      responseTtlMs: 60_000,
      ...(this.opts.relayTls ? { controlTls: this.opts.relayTls } : {}),
    });
    await new Promise<void>((r) => this.relay.server.listen(this.opts.port, "127.0.0.1", () => r()));
    if (this.opts.relayTls) {
      if (!this.relay.controlServer || !this.opts.controlPort) {
        throw new Error("relay TLS requires controlPort");
      }
      await new Promise<void>((r) => this.relay.controlServer!.listen(this.opts.controlPort!, "127.0.0.1", () => r()));
    }
    this.relayClient = new RelayClient({
      baseUrl: this.opts.relayTls
        ? `https://127.0.0.1:${this.opts.controlPort}`
        : `http://127.0.0.1:${this.opts.port}`,
      adminToken: "harness-admin-token-0123456789",
      ...(this.opts.relayClientTls ? { tls: this.opts.relayClientTls } : {}),
    });
    await this.relayClient.register(
      this.sessionId,
      createHash("sha256").update(this.guestToken).digest("hex"),
      300_000,
    );

    const binary = process.env.GUEST_BINARY ?? join(process.cwd(), "guest/bin/x402-guest");
    this.proc = spawn(binary, ["run"], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        SESSION_ID: this.sessionId,
        RELAY_URL: `ws://127.0.0.1:${this.opts.port}/guest?session=${this.sessionId}`,
        GUEST_TOKEN: this.guestToken,
        CLIENT_PUBLIC_KEY: toBase64(this.clientKeys.publicKey),
        CLIENT_NONCE: this.clientNonce,
        LEASE_SECONDS: String(this.opts.leaseSeconds ?? 120),
        EXECUTION_MODE: "dev",
        RUNTIME_CLASS: "x402-sandbox",
        GUEST_IMAGE_DIGEST: "sha256:test",
        WORKSPACE_DIR: this.workspace,
        X402_SANDBOX_DIR: join(dir, "run"),
        MAX_OUTPUT_BYTES: String(this.opts.maxOutputBytes ?? 262144),
        MAX_FILE_BYTES: String(this.opts.maxFileBytes ?? 8 * 1024 * 1024),
        MAX_DISK_MIB: String(this.opts.maxDiskMiB ?? 256),
        MAX_COMMAND_SECONDS: String(this.opts.maxCommandSeconds ?? 120),
        MAX_PROCESSES: "256",
        GUEST_TOOLS: "python3,node,bash,tar,curl",
        DEV_ATTESTATION_KEY: DEV_SEED,
        DEV_ATTESTATION_KEY_ID: DEV_KEY_ID,
        EGRESS_PROXY_URL: "",
        PROXY_TOKEN: "",
        LOG_LEVEL: "warn",
        ...this.opts.extraEnv,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-8192);
    });

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const state = await this.relayClient.state(this.sessionId);
      if (state.connected && state.attestation) {
        this.evidence = state.attestation;
        this.guestKey = fromBase64(state.attestation.guestPublicKey);
        const verdict = verifyAttestation(state.attestation, {
          mode: "dev",
          allowInsecureDev: true,
          expectedSessionId: this.sessionId,
          expectedClientNonce: this.clientNonce,
          expectedClientPublicKey: toBase64(this.clientKeys.publicKey),
        });
        if (!verdict.ok) throw new Error(`attestation rejected: ${verdict.code} ${verdict.message}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`guest did not become ready: ${this.stderr}`);
  }

  async op(request: { op: string; requestId?: string; [key: string]: unknown }): Promise<GuestResult> {
    if (!this.guestKey) throw new Error("guest not ready");
    const requestId = request.requestId ?? randomBytes(16).toString("hex");
    const payload = {
      v: 2 as const,
      sessionId: this.sessionId,
      clientNonce: this.clientNonce,
      requestId,
      ...request,
    };
    const envelope = await sealJsonTo(this.guestKey, payload);
    const epoch = this.opts.execEpoch ?? 1;
    await this.relayClient.request(this.sessionId, requestId, envelope, Date.now() + 120_000, epoch);
    const response = await this.relayClient.response(this.sessionId, requestId, 30_000);
    if (response.kind !== "envelope") throw new Error(`unexpected relay response: ${JSON.stringify(response)}`);
    return openSealedJson<GuestResult>(response.envelope, this.clientKeys.publicKey, this.clientKeys.privateKey);
  }

  async exec(command: string[], extra: Partial<{ env: Record<string, string>; cwd: string; stdin: string; timeoutMs: number }> = {}) {
    const result = await this.op({ op: "exec", command, ...extra });
    if (result.op !== "exec") throw new Error(`expected exec result, got ${result.op}`);
    return result;
  }

  /**
   * Stop the guest process with SIGSTOP. Used to make "a frame forwarded but
   * not yet observed" deterministic: the process cannot read its socket while
   * stopped, so a forwarded frame stays queued in the kernel.
   */
  pause(): void {
    if (!this.proc?.pid) throw new Error("guest not running");
    process.kill(this.proc.pid, "SIGSTOP");
  }

  resume(): void {
    if (!this.proc?.pid) throw new Error("guest not running");
    process.kill(this.proc.pid, "SIGCONT");
  }

  /** Exit code once the guest process ends, or null if it is still running. */
  async waitForExit(timeoutMs = 10_000): Promise<number | null> {
    if (!this.proc || this.proc.exitCode !== null) return this.proc?.exitCode ?? null;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      this.proc!.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  async stop(): Promise<void> {
    if (this.proc?.pid) {
      // A stopped process does not act on SIGKILL until it is continued.
      try {
        process.kill(this.proc.pid, "SIGCONT");
      } catch {
        /* already gone */
      }
    }
    this.proc?.kill("SIGKILL");
    await this.relayClient?.purge(this.sessionId).catch(() => undefined);
    await this.relay?.close();
  }
}
