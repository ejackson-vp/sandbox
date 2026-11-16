/**
 * The sealed operation exchange: submit one operation, wait (or poll), and open
 * the result under the session binding.
 *
 * This is transport policy, not meaning. It owns the things that must be
 * identical for every operation type: the idempotency key bound to the
 * canonical plaintext, the busy queue, the 202 poll, and the binding check that
 * rejects a result for another session, nonce or request. What an operation
 * *is* stays in `operations.ts` and `data-plane.ts`.
 */
import { canonicalJson, openSealedJson, sealJsonTo, sha256Hex } from "@x402s/shared/crypto";
import type { GuestResult } from "@x402s/shared/protocol";
import { sleep } from "./timing.js";
import { SandboxError, type SessionHandle } from "./types.js";

/** The slice of the transport an operation needs. `ClientRuntime` provides it. */
export interface OperationTransport {
  auth(handle: SessionHandle): Record<string, string>;
  api(
    path: string,
    init?: RequestInit,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<Response>;
  errorFrom(res: Response, fallback: string): Promise<SandboxError>;
  errorFromText(status: number, text: string, fallback: string): SandboxError;
  /** Resolve the guest key before the first operation on a fresh handle. */
  ensureReady(handle: SessionHandle): Promise<void>;
}

/** A 202 body's error/request id, or an empty object when the body is not JSON. */
function errorBody(text: string): { error?: string; requestId?: string } {
  try {
    return JSON.parse(text) as { error?: string; requestId?: string };
  } catch {
    return {};
  }
}

export class OperationChannel {
  constructor(private readonly transport: OperationTransport) {}

  async getOperation(
    handle: SessionHandle,
    requestId: string,
    waitMs = 20_000,
  ): Promise<GuestResult | null> {
    const res = await this.transport.api(
      `/v1/sessions/${handle.sessionId}/requests/${requestId}?waitMs=${waitMs}`,
      { headers: this.transport.auth(handle) },
      waitMs + 30_000,
    );
    if (res.status === 202) return null;
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        requestId?: string;
      };
      if (body.error === "outcome_unknown") {
        throw new SandboxError(
          "outcome_unknown",
          body.message ??
            "the controller restarted while this operation was in flight; its outcome is unknown",
          409,
          requestId,
        );
      }
      throw new SandboxError(
        body.error ?? "operation_lookup_failed",
        body.message ?? "operation lookup failed",
        409,
        requestId,
      );
    }
    if (res.status === 410) throw new SandboxError("result_expired", "the result is no longer available", 410, requestId);
    if (!res.ok) throw await this.transport.errorFrom(res, "operation_lookup_failed");
    const body = (await res.json()) as { envelope?: string };
    if (!body.envelope) return null;
    return this.openResult(handle, body.envelope, requestId);
  }

  /**
   * `runGet` is the same exchange over the GET surface, used by the read-only
   * filesystem operations. It keeps its own body because the server's 409
   * handling differs: only a busy queue is retried here, and everything else is
   * surfaced.
   */
  async run<T extends GuestResult>(
    handle: SessionHandle,
    operation: { requestId: string },
    requestId: string,
    queueMs = 0,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const sealed = await this.seal(handle, operation);
    // Matches the API's waitMs cap: the schema rejects anything above 90 s, which
    // is below the edge proxy's 100 s timeout. A longer command answers 202 and
    // the loop below polls.
    const waitMs = Math.min(90_000, (timeoutMs ?? 60_000) + 10_000);
    const queueDeadline = Date.now() + queueMs;

    for (;;) {
      const res = await this.transport.api(
        `/v1/sessions/${handle.sessionId}/operations`,
        {
          method: "POST",
          headers: this.transport.auth(handle),
          body: JSON.stringify({
            requestId,
            envelope: sealed.envelope,
            payloadHash: sealed.payloadHash,
            timeoutMs,
            waitMs,
          }),
        },
        waitMs + 30_000,
        signal,
      );
      if (res.status === 409) {
        const text = await res.text().catch(() => "");
        const body = errorBody(text);
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
        throw this.transport.errorFromText(409, text, "exec_failed");
      }
      if (res.status === 202) {
        const pending = await this.pollOperation<T>(handle, requestId, waitMs);
        if (pending) return pending;
        return this.pendingResult<T>(handle, requestId, "exec");
      }
      if (!res.ok) throw await this.transport.errorFrom(res, "exec_failed");
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
    const sealed = await this.seal(handle, operation);
    const queueDeadline = Date.now() + queueMs;
    for (;;) {
      const res = await this.transport.api(
        `/v1/sessions/${handle.sessionId}/operations?request=${encodeURIComponent(sealed.envelope)}&requestId=${encodeURIComponent(operation.requestId)}&payloadHash=${sealed.payloadHash}&waitMs=60000`,
        { headers: this.transport.auth(handle) },
        120_000,
      );
      if (res.status === 409) {
        const text = await res.text().catch(() => "");
        if (errorBody(text).error === "busy" && Date.now() < queueDeadline) {
          await sleep(250);
          continue;
        }
        throw this.transport.errorFromText(409, text, "file_operation_failed");
      }
      if (res.status === 202) {
        const pending = await this.pollOperation<T>(handle, requestId, 60_000);
        if (pending) return pending;
        return this.pendingResult<T>(handle, requestId, "file.get");
      }
      if (!res.ok) throw await this.transport.errorFrom(res, "file_operation_failed");
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

  /**
   * Seal one operation and bind an idempotency key to it.
   *
   * The envelope is re-sealed (fresh randomness) if the caller retries the
   * logical operation, so the key is the hash of the canonical plaintext
   * instead. The operation carries `requestId`, so two different requests never
   * share a hash. Computed once per call and reused on every retry.
   */
  private async seal(
    handle: SessionHandle,
    operation: { requestId: string },
  ): Promise<{ envelope: string; payloadHash: string }> {
    await this.transport.ensureReady(handle);
    return {
      payloadHash: sha256Hex(canonicalJson(operation)),
      envelope: await sealJsonTo(handle.guestPublicKey!, operation),
    };
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

  /** The answer when a 202's poll window closed with the operation still running. */
  private pendingResult<T extends GuestResult>(
    handle: SessionHandle,
    requestId: string,
    op: "exec" | "file.get",
  ): T {
    return {
      v: 2,
      sessionId: handle.sessionId,
      clientNonce: handle.clientNonce,
      requestId,
      op,
      ok: false,
      error: { code: "operation_pending", message: "the operation is still running; fetch it by request id" },
    } as unknown as T;
  }
}
