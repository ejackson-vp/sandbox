/**
 * Programmatic client for the x402 sandbox session API.
 *
 * The client holds the only copy of its X25519 private key. Commands and file
 * contents are sealed to the attested guest key; results are sealed back to the
 * client. The API and controller only ever see ciphertext.
 */
import {
  fromBase64,
  generateBoxKeyPair,
  generateNonce,
  openSealedJson,
  sealJsonTo,
  toBase64,
  verifyAttestation,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type ExecOperation,
  type ExecResult,
  type FileEntry,
  type FileGetOperation,
  type FileGetResult,
  type FileListOperation,
  type FileListResult,
  type FilePutOperation,
  type FilePutResult,
  type FileStatOperation,
  type FileStatResult,
  type GuestResult,
  type OperationError,
  type SessionStatus,
  type SessionTier,
} from "@x402s/shared";
import { randomBytes } from "node:crypto";
import { createPayer, type Payer, type PaymentMode } from "./payment.js";
import { FileSessionStore, type StoredSession } from "./session-store.js";

export class SandboxError extends Error {
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
  /** Explicit acknowledgement that simulated attestation is not confidential. */
  allowInsecureDev?: boolean;
  /** Reject anything that is not hardware-attested. */
  requireHardware?: boolean;
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
  /** Persist the handle (default true when a store is configured). */
  save?: boolean;
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

export interface FilePutOptions {
  path: string;
  data: Buffer | Uint8Array;
  archive?: boolean;
  mode?: number;
  requestId?: string;
  queueMs?: number;
}

export type FileOutcome<T> = T | OperationError;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SandboxClient {
  private readonly apiUrl: string;
  private readonly payer: Payer;
  private readonly allowInsecureDev: boolean;
  private readonly requireHardware: boolean;
  private readonly expectedMeasurement?: string;
  private readonly store?: FileSessionStore;
  private readonly log: (line: string) => void;

  constructor(opts: SandboxClientOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/$/, "");
    this.payer = opts.payer ?? createPayer(opts.paymentMode ?? "mock");
    this.allowInsecureDev = opts.allowInsecureDev ?? false;
    this.requireHardware = opts.requireHardware ?? false;
    this.expectedMeasurement = opts.expectedMeasurement;
    this.store = opts.store;
    this.log = opts.log ?? (() => {});
    if (!this.allowInsecureDev && !this.requireHardware) {
      throw new SandboxError(
        "insecure_dev_ack_required",
        "refusing to run: simulated attestation requires allowInsecureDev (or requireHardware)",
      );
    }
  }

  /* ---------------- session lifecycle ---------------- */

  async createSession(opts: CreateOptions = {}): Promise<SessionHandle> {
    const keys = await generateBoxKeyPair();
    const clientNonce = toBase64(await generateNonce());
    const body: CreateSessionRequest = {
      ...(opts.tier ? { tier: opts.tier } : {}),
      ...(opts.durationSeconds === undefined ? {} : { durationSeconds: opts.durationSeconds }),
      ...(opts.cpuMillis === undefined ? {} : { cpuMillis: opts.cpuMillis }),
      ...(opts.memoryMiB === undefined ? {} : { memoryMiB: opts.memoryMiB }),
      ...(opts.diskMiB === undefined ? {} : { diskMiB: opts.diskMiB }),
      clientPublicKey: toBase64(keys.publicKey),
      clientNonce,
    };

    const paid = await this.payer.createSession(this.apiUrl, body);
    if (paid.paymentError) {
      throw new SandboxError("payment_rejected", `payment rejected: ${paid.paymentError}`, paid.response.status);
    }
    if (!paid.response.ok) {
      const text = await paid.response.text().catch(() => "");
      let code = "create_failed";
      try {
        code = (JSON.parse(text) as { error?: string }).error ?? code;
      } catch {
        /* keep default */
      }
      throw new SandboxError(code, `session creation failed (${paid.response.status}): ${text.slice(0, 300)}`, paid.response.status);
    }

    const created = (await paid.response.json()) as CreateSessionResponse;
    const handle: SessionHandle = {
      sessionId: created.sessionId,
      capability: created.capability,
      clientPublicKey: keys.publicKey,
      clientPrivateKey: keys.privateKey,
      clientNonce,
      status: {
        sessionId: created.sessionId,
        state: created.state,
        tier: created.tier,
        durationSeconds: created.durationSeconds,
        limits: created.limits,
        createdAt: new Date().toISOString(),
        remainingSeconds: created.durationSeconds,
        clientNonce,
        payment: created.payment,
        busy: false,
      },
      createdAt: Date.now(),
    };
    this.log(`session ${created.sessionId} created (${created.tier}, ${created.durationSeconds}s, ${created.payment.priceUsd})`);
    if (opts.save !== false && this.store) this.persist(handle);
    return handle;
  }

  /** Reconstruct a handle from the local credential store. */
  attach(sessionId: string): SessionHandle {
    if (!this.store) throw new SandboxError("no_store", "this client has no session store configured");
    const stored = this.store.get(sessionId);
    if (!stored) throw new SandboxError("session_not_found", `no local credentials for ${sessionId}`);
    if (stored.apiUrl !== this.apiUrl) {
      throw new SandboxError("api_mismatch", `session was created against ${stored.apiUrl}`);
    }
    return {
      sessionId: stored.sessionId,
      capability: stored.capability,
      clientPublicKey: fromBase64(stored.clientPublicKey),
      clientPrivateKey: fromBase64(stored.clientPrivateKey),
      clientNonce: stored.clientNonce,
      createdAt: stored.createdAt,
      ...(stored.guestPublicKey ? { guestPublicKey: fromBase64(stored.guestPublicKey) } : {}),
    };
  }

  listLocalSessions(): StoredSession[] {
    return this.store?.list() ?? [];
  }

  forgetLocal(sessionId: string): void {
    this.store?.remove(sessionId);
  }

  private persist(handle: SessionHandle): void {
    if (!this.store) return;
    this.store.save({
      apiUrl: this.apiUrl,
      sessionId: handle.sessionId,
      capability: handle.capability,
      clientPublicKey: toBase64(handle.clientPublicKey),
      clientPrivateKey: toBase64(handle.clientPrivateKey),
      clientNonce: handle.clientNonce,
      createdAt: handle.createdAt,
      ...(handle.status?.leaseExpiresAt ? { leaseExpiresAt: Date.parse(handle.status.leaseExpiresAt) } : {}),
      ...(handle.status?.tier ? { tier: handle.status.tier } : {}),
      ...(handle.guestPublicKey ? { guestPublicKey: toBase64(handle.guestPublicKey) } : {}),
    });
  }

  async status(handle: SessionHandle): Promise<SessionStatus> {
    const res = await this.api(`/v1/sessions/${handle.sessionId}`, { headers: this.auth(handle) });
    if (res.status === 410) throw new SessionExpiredError("capability expired");
    if (!res.ok) throw await this.errorFrom(res, "status_failed");
    const status = (await res.json()) as SessionStatus;
    handle.status = status;
    return status;
  }

  /**
   * Wait for READY/ACTIVE and verify attestation. Returns the verified status.
   */
  async waitForReady(handle: SessionHandle, timeoutMs = 180_000): Promise<SessionStatus> {
    const deadline = Date.now() + timeoutMs;
    let last: SessionStatus | undefined;
    while (Date.now() < deadline) {
      last = await this.status(handle);
      if (last.state === "READY" || last.state === "ACTIVE") break;
      if (last.state === "EXPIRED" || last.state === "DESTROYED") {
        throw new SessionExpiredError(`session is ${last.state}`);
      }
      if (last.state === "FAILED" || last.state === "TERMINATING") {
        throw new SandboxError(
          "session_failed",
          `session ended before it became ready (${last.state}${last.failure ? `: ${last.failure.code}` : ""})`,
        );
      }
      await sleep(250);
    }
    if (!last || (last.state !== "READY" && last.state !== "ACTIVE")) {
      throw new SandboxError("ready_timeout", "sandbox did not become ready in time");
    }
    if (!last.attestation || !last.guestPublicKey) {
      throw new SandboxError("missing_attestation", "READY session did not provide attestation evidence");
    }

    const mode = last.executionMode ?? "dev";
    const verdict = verifyAttestation(last.attestation, {
      mode: this.requireHardware ? "confidential" : mode,
      allowInsecureDev: this.allowInsecureDev && mode !== "confidential",
      expectedSessionId: handle.sessionId,
      expectedClientNonce: handle.clientNonce,
      expectedClientPublicKey: toBase64(handle.clientPublicKey),
      // Evidence is valid for the whole purchased lease (bound to this session,
      // nonce and client key), so re-attaching mid-lease works.
      maxEvidenceAgeMs: last.durationSeconds * 1000 + 300_000,
      ...(this.expectedMeasurement ? { allowedMeasurements: [this.expectedMeasurement] } : {}),
    });
    if (!verdict.ok) {
      throw new SandboxError("attestation_rejected", `attestation rejected: ${verdict.code} (${verdict.message})`);
    }
    handle.guestPublicKey = fromBase64(last.guestPublicKey);
    if (handle.guestPublicKey.length !== 32) {
      throw new SandboxError("invalid_guest_key", "guest public key has an invalid length");
    }
    handle.status = last;
    if (this.store) this.persist(handle);
    return last;
  }

  async destroy(handle: SessionHandle, waitMs = 30_000): Promise<SessionStatus | null> {
    await this.api(`/v1/sessions/${handle.sessionId}`, { method: "DELETE", headers: this.auth(handle) });
    if (this.store) this.forgetLocal(handle.sessionId);
    const deadline = Date.now() + waitMs;
    let last: SessionStatus | null = null;
    while (Date.now() < deadline) {
      try {
        last = await this.status(handle);
        if (["DESTROYED", "EXPIRED", "FAILED"].includes(last.state)) return last;
      } catch (err) {
        if (err instanceof SessionExpiredError) return null;
        throw err;
      }
      await sleep(250);
    }
    return last;
  }

  /* ---------------- operations ---------------- */

  async exec(handle: SessionHandle, opts: ExecOptions): Promise<ExecResult | OperationError> {
    const requestId = opts.requestId ?? randomBytes(16).toString("hex");
    const operation: ExecOperation = {
      v: 2,
      sessionId: handle.sessionId,
      clientNonce: handle.clientNonce,
      requestId,
      op: "exec",
      command: opts.command,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.stdin ? { stdin: opts.stdin } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    };
    return this.run<ExecResult>(handle, operation, requestId, opts.queueMs, opts.timeoutMs, opts.signal);
  }

  async putFile(handle: SessionHandle, opts: FilePutOptions): Promise<FilePutResult | OperationError> {
    const requestId = opts.requestId ?? randomBytes(16).toString("hex");
    const operation: FilePutOperation = {
      v: 2,
      sessionId: handle.sessionId,
      clientNonce: handle.clientNonce,
      requestId,
      op: "file.put",
      path: opts.path,
      dataBase64: Buffer.from(opts.data).toString("base64"),
      ...(opts.archive ? { archive: true } : {}),
      ...(opts.mode ? { mode: opts.mode } : {}),
    };
    return this.run<FilePutResult>(handle, operation, requestId, opts.queueMs, 30_000);
  }

  async getFile(handle: SessionHandle, path: string, archive = false, queueMs = 0): Promise<FileGetResult | OperationError> {
    const requestId = randomBytes(16).toString("hex");
    const operation: FileGetOperation = {
      v: 2,
      sessionId: handle.sessionId,
      clientNonce: handle.clientNonce,
      requestId,
      op: "file.get",
      path,
      ...(archive ? { archive: true } : {}),
    };
    return this.runGet<FileGetResult>(handle, operation, requestId, queueMs);
  }

  async listFiles(handle: SessionHandle, path = ".", recursive = false): Promise<FileListResult | OperationError> {
    const requestId = randomBytes(16).toString("hex");
    const operation: FileListOperation = {
      v: 2,
      sessionId: handle.sessionId,
      clientNonce: handle.clientNonce,
      requestId,
      op: "file.list",
      path,
      recursive,
    };
    return this.runGet<FileListResult>(handle, operation, requestId, 0);
  }

  async statFile(handle: SessionHandle, path: string): Promise<FileStatResult | OperationError> {
    const requestId = randomBytes(16).toString("hex");
    const operation: FileStatOperation = {
      v: 2,
      sessionId: handle.sessionId,
      clientNonce: handle.clientNonce,
      requestId,
      op: "file.stat",
      path,
    };
    return this.runGet<FileStatResult>(handle, operation, requestId, 0);
  }

  async cancel(handle: SessionHandle, requestId: string): Promise<void> {
    await this.api(`/v1/sessions/${handle.sessionId}/requests/${requestId}`, {
      method: "DELETE",
      headers: this.auth(handle),
    });
  }

  async getOperation(handle: SessionHandle, requestId: string, waitMs = 20_000): Promise<GuestResult | null> {
    const res = await this.api(
      `/v1/sessions/${handle.sessionId}/requests/${requestId}?waitMs=${waitMs}`,
      { headers: this.auth(handle) },
      waitMs + 30_000,
    );
    if (res.status === 202) return null;
    if (res.status === 410) throw new SandboxError("result_expired", "the result is no longer available", 410, requestId);
    if (!res.ok) throw await this.errorFrom(res, "operation_lookup_failed");
    const body = (await res.json()) as { envelope?: string };
    if (!body.envelope) return null;
    return this.openResult(handle, body.envelope, requestId);
  }

  /* ---------------- internals ---------------- */

  private auth(handle: SessionHandle): Record<string, string> {
    return { "x-sandbox-capability": handle.capability };
  }

  private async api(
    path: string,
    init: RequestInit = {},
    timeoutMs = 180_000,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    return fetch(`${this.apiUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
  }

  private async errorFrom(res: Response, fallback: string): Promise<SandboxError> {
    const text = await res.text().catch(() => "");
    return this.errorFromText(res.status, text, fallback);
  }

  private errorFromText(status: number, text: string, fallback: string): SandboxError {
    let code = fallback;
    let message = text.slice(0, 300);
    let requestId: string | undefined;
    try {
      const body = JSON.parse(text) as { error?: string; message?: string; requestId?: string };
      code = body.error ?? fallback;
      message = body.message ?? message;
      requestId = body.requestId;
    } catch {
      /* keep defaults */
    }
    if (status === 410 && /lease|expired/.test(code)) return new SessionExpiredError(message);
    return new SandboxError(code, message, status, requestId);
  }

  private async run<T extends GuestResult>(
    handle: SessionHandle,
    operation: { requestId: string },
    requestId: string,
    queueMs = 0,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!handle.guestPublicKey) await this.waitForReady(handle);
    const envelope = await sealJsonTo(handle.guestPublicKey!, operation);
    const waitMs = Math.min(120_000, (timeoutMs ?? 60_000) + 10_000);
    const queueDeadline = Date.now() + queueMs;

    for (;;) {
      const res = await this.api(
        `/v1/sessions/${handle.sessionId}/exec`,
        {
          method: "POST",
          headers: this.auth(handle),
          body: JSON.stringify({ requestId, envelope, timeoutMs, waitMs }),
        },
        waitMs + 30_000,
        signal,
      );
      if (res.status === 409) {
        const text = await res.text().catch(() => "");
        let body: { error?: string; requestId?: string } = {};
        try {
          body = JSON.parse(text) as typeof body;
        } catch {
          /* keep default */
        }
        if (body.error === "busy" && Date.now() < queueDeadline) {
          await sleep(250);
          continue;
        }
        if (body.error === "busy") {
          throw new SandboxError("session_busy", "another operation is running in this session", 409, body.requestId);
        }
        if (body.error === "duplicate") {
          const existing = await this.getOperation(handle, requestId, waitMs);
          if (existing) return existing as T;
        }
        throw this.errorFromText(409, text, "exec_failed");
      }
      if (res.status === 202) {
        const pending = await this.pollOperation<T>(handle, requestId, waitMs);
        if (pending) return pending;
        return {
          v: 2,
          sessionId: handle.sessionId,
          clientNonce: handle.clientNonce,
          requestId,
          op: "exec",
          ok: false,
          error: { code: "operation_pending", message: "the operation is still running; fetch it by request id" },
        } as unknown as T;
      }
      if (!res.ok) throw await this.errorFrom(res, "exec_failed");
      const body = (await res.json()) as { envelope?: string };
      if (!body.envelope) throw new SandboxError("missing_result", "server returned no result envelope");
      return this.openResult<T>(handle, body.envelope, requestId);
    }
  }

  /** File read/list/stat travel in the query string (small encrypted requests). */
  private async runGet<T extends GuestResult>(
    handle: SessionHandle,
    operation: { requestId: string },
    requestId: string,
    queueMs: number,
  ): Promise<T> {
    if (!handle.guestPublicKey) await this.waitForReady(handle);
    const envelope = await sealJsonTo(handle.guestPublicKey!, operation);
    const queueDeadline = Date.now() + queueMs;
    for (;;) {
      const res = await this.api(
        `/v1/sessions/${handle.sessionId}/files?request=${encodeURIComponent(envelope)}&requestId=${encodeURIComponent(operation.requestId)}&waitMs=60000`,
        { headers: this.auth(handle) },
        120_000,
      );
      if (res.status === 409) {
        const text = await res.text().catch(() => "");
        let body: { error?: string } = {};
        try {
          body = JSON.parse(text) as typeof body;
        } catch {
          /* keep default */
        }
        if (body.error === "busy" && Date.now() < queueDeadline) {
          await sleep(250);
          continue;
        }
        throw this.errorFromText(409, text, "file_operation_failed");
      }
      if (res.status === 202) {
        const pending = await this.pollOperation<T>(handle, requestId, 60_000);
        if (pending) return pending;
        return {
          v: 2,
          sessionId: handle.sessionId,
          clientNonce: handle.clientNonce,
          requestId,
          op: operation.requestId,
          ok: false,
          error: { code: "operation_pending", message: "the operation is still running; fetch it by request id" },
        } as unknown as T;
      }
      if (!res.ok) throw await this.errorFrom(res, "file_operation_failed");
      const body = (await res.json()) as { envelope?: string };
      if (!body.envelope) throw new SandboxError("missing_result", "server returned no result envelope");
      return this.openResult<T>(handle, body.envelope, requestId);
    }
  }

  private async pollOperation<T extends GuestResult>(
    handle: SessionHandle,
    requestId: string,
    waitMs: number,
  ): Promise<T | null> {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const result = await this.getOperation(handle, requestId, Math.min(20_000, Math.max(1000, deadline - Date.now())));
      if (result) return result as T;
      await sleep(250);
    }
    return null;
  }

  private async openResult<T extends GuestResult>(
    handle: SessionHandle,
    envelope: string,
    requestId: string,
  ): Promise<T> {
    let result: GuestResult;
    try {
      result = await openSealedJson<GuestResult>(envelope, handle.clientPublicKey, handle.clientPrivateKey);
    } catch {
      throw new SandboxError("decryption_failed", "result could not be decrypted with the client key", undefined, requestId);
    }
    if (
      result.v !== 2 ||
      result.sessionId !== handle.sessionId ||
      result.clientNonce !== handle.clientNonce ||
      result.requestId !== requestId
    ) {
      throw new SandboxError("binding_mismatch", "result failed the session binding check", undefined, requestId);
    }
    return result as T;
  }
}

export type { FileEntry, SessionStatus };
