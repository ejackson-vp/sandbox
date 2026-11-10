/**
 * Public SDK types and errors. Kept separate from the client implementation so
 * modules can depend on the contract without importing the facade.
 */
import type { SessionStatus, SessionTier } from "@x402s/shared/protocol";
import type { Payer, PaymentMode } from "./payment.js";
import type { FileSessionStore } from "./session-store.js";

export class SandboxError extends Error {
  /** Set when a one-shot run failed and destroying its session also failed. */
  cleanupError?: unknown;

  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

export class SessionExpiredError extends SandboxError {
  constructor(message = "the session lease has ended") {
    super("lease_expired", message, 410);
    this.name = "SessionExpiredError";
  }
}

export interface SandboxClientOptions {
  apiUrl: string;
  payer?: Payer;
  paymentMode?: PaymentMode;
  /** Set to false to reject all simulated evidence; this product has no
   * hardware evidence path. */
  allowInsecureDev?: boolean;
  expectedMeasurement?: string;
  /** Persist session handles for multi-process CLI use. */
  store?: FileSessionStore;
  log?: (line: string) => void;
}

export interface SessionHandle {
  sessionId: string;
  capability: string;
  clientPublicKey: Uint8Array;
  clientPrivateKey: Uint8Array;
  clientNonce: string;
  guestPublicKey?: Uint8Array;
  status?: SessionStatus;
  createdAt: number;
}

export interface CreateOptions {
  tier?: SessionTier;
  durationSeconds?: number;
  cpuMillis?: number;
  memoryMiB?: number;
  diskMiB?: number;
  /** Steady-state reservation (defaults to a quarter of the peak). */
  baselineCpuMillis?: number;
  baselineMemoryMiB?: number;
  /** Opt into checkpointed suspend/resume. */
  idlePolicy?: {
    maxIdleSeconds?: number;
    suspendedDurationSeconds?: number;
    autoResume?: boolean;
  };
  /** Wall-clock cap, including suspended time. */
  maxLifetimeSeconds?: number;
  /** Persist the handle (default true when a store is configured). */
  save?: boolean;
}

export interface StartServiceOptions {
  name: string;
  command: string[];
  port: number;
  env?: Record<string, string>;
  cwd?: string;
}

export interface HttpOptions {
  port: number;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: Buffer | Uint8Array | string;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
}

export interface OpenHttpStreamOptions {
  port: number;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: Buffer | Uint8Array | string;
}

export interface HttpStream {
  streamId: string;
  status: number;
  headers: Record<string, string>;
  read(): Promise<{ chunk?: Buffer; done: boolean }>;
  close(): Promise<void>;
}

export interface OpenWebSocketOptions {
  port: number;
  path: string;
  headers?: Record<string, string>;
}

export interface WebSocketStream {
  streamId: string;
  status: number;
  read(): Promise<{ data?: Buffer; binary: boolean; done: boolean }>;
  send(data: Buffer | Uint8Array | string, opts?: { binary?: boolean }): Promise<void>;
  close(): Promise<void>;
}

export interface ExecOptions {
  command: string[];
  env?: Record<string, string>;
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
  requestId?: string;
  /** Wait for a busy session instead of failing immediately (ms). */
  queueMs?: number;
  /** Abort the client-side wait (the command keeps running server-side). */
  signal?: AbortSignal;
}

/**
 * One-shot run options. A run creates a fresh session, uploads `files`, runs
 * `command`, downloads `returnFiles`, and destroys the session.
 *
 * File paths are workspace-relative (the guest resolves them under
 * `/workspace`). Absolute paths are accepted only inside `/workspace`.
 */
export interface RunOptions extends CreateOptions {
  /** Runtime profile. Only `"base"` is available today; defaults to `"base"`. */
  runtime?: string;
  command: string[];
  /** Files to write before the command, keyed by workspace-relative path. */
  files?: Record<string, string | Uint8Array>;
  /** Workspace-relative paths to download after the command. */
  returnFiles?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

export interface RunResult {
  sessionId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Downloaded files, keyed by the requested workspace-relative path. */
  files: Record<string, Uint8Array>;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
}

export interface FilePutOptions {
  path: string;
  data: Buffer | Uint8Array;
  archive?: boolean;
  mode?: number;
  requestId?: string;
  queueMs?: number;
}

