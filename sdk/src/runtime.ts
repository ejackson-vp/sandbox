/**
 * Shared client runtime: transport, auth, errors, attestation, persistence and
 * the encrypted operation loop. Session/operation/data-plane modules depend on
 * this; the public facade composes them.
 */
import {
  fromBase64,
  openSealedJson,
  sealJsonTo,
  toBase64,
  verifyAttestation,
  type GuestResult,
  type SessionStatus,
} from "@x402s/shared";
import { createPayer, type Payer } from "./payment.js";
import type { FileSessionStore } from "./session-store.js";
import {
  SandboxError,
  SessionExpiredError,
  type SandboxClientOptions,
  type SessionHandle,
} from "./types.js";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ClientRuntime {
  readonly apiUrl: string;
  readonly payer: Payer;
  readonly allowInsecureDev: boolean;
  readonly requireHardware: boolean;
  readonly expectedMeasurement?: string;
  readonly store?: FileSessionStore;
  readonly log: (line: string) => void;

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

  auth(handle: SessionHandle): Record<string, string> {
    return { "x-sandbox-capability": handle.capability };
  }

  async api(
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

  async errorFrom(res: Response, fallback: string): Promise<SandboxError> {
    const text = await res.text().catch(() => "");
    return this.errorFromText(res.status, text, fallback);
  }

  errorFromText(status: number, text: string, fallback: string): SandboxError {
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

  persist(handle: SessionHandle): void {
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

  forgetLocal(sessionId: string): void {
    this.store?.remove(sessionId);
  }

  async status(handle: SessionHandle): Promise<SessionStatus> {
    const res = await this.api(`/v1/sessions/${handle.sessionId}`, { headers: this.auth(handle) });
    if (res.status === 410) throw new SessionExpiredError("capability expired");
    if (!res.ok) throw await this.errorFrom(res, "status_failed");
    const status = (await res.json()) as SessionStatus;
    handle.status = status;
    return status;
  }

  /** Wait for READY/ACTIVE and verify attestation. Returns the verified status. */
  async waitForReady(handle: SessionHandle, timeoutMs = 180_000): Promise<SessionStatus> {
    const deadline = Date.now() + timeoutMs;
    let last: SessionStatus | undefined;
    let lastTransportError: unknown;
    let polls = 0;
    while (Date.now() < deadline) {
      try {
        last = await this.status(handle);
        lastTransportError = undefined;
      } catch (err) {
        if (err instanceof SandboxError) {
          if (err.code === "rate_limited") {
            await sleep(250);
            continue;
          }
          // A restarting API can answer 502/503 before its routes are live.
          // Retry server-side failures, but surface real client errors.
          if (err.status !== undefined && err.status >= 500) {
            lastTransportError = err;
            await sleep(polls++ < 8 ? 75 : 200);
            continue;
          }
          throw err;
        }
        // The API may be restarting or briefly unreachable. Treat transport
        // failures as retryable so callers can wait through a control-plane
        // restart instead of surfacing a transient "fetch failed".
        lastTransportError = err;
        await sleep(polls++ < 8 ? 75 : 200);
        continue;
      }
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
      await sleep(polls++ < 8 ? 75 : 200);
    }
    if (!last) {
      if (lastTransportError) throw lastTransportError;
      throw new SandboxError("ready_timeout", "sandbox did not become ready in time");
    }
    if (last.state !== "READY" && last.state !== "ACTIVE") {
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
    this.persist(handle);
    return last;
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

  async run<T extends GuestResult>(
    handle: SessionHandle,
    operation: { requestId: string },
    requestId: string,
    queueMs = 0,
    timeoutMs?: number,
    signal?: AbortSignal,
    route = "exec",
  ): Promise<T> {
    if (!handle.guestPublicKey) await this.waitForReady(handle);
    const envelope = await sealJsonTo(handle.guestPublicKey!, operation);
    const waitMs = Math.min(120_000, (timeoutMs ?? 60_000) + 10_000);
    const queueDeadline = Date.now() + queueMs;

    for (;;) {
      const res = await this.api(
        `/v1/sessions/${handle.sessionId}/${route}`,
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

  async runGet<T extends GuestResult>(
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

  async pollOperation<T extends GuestResult>(
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

  async openResult<T extends GuestResult>(
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
