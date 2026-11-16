/**
 * The client's session runtime: configuration, the payer, local persistence,
 * and the readiness/attestation gate.
 *
 * Transport lives in `transport.ts` and the sealed operation exchange in
 * `operation-loop.ts`. What is left here is the part that is about a *session*:
 * who is paying, where the handle is stored, and whether the guest that just
 * became READY is bound to this client's key. Session, operation and data-plane
 * modules depend on this; the public facade composes them.
 */
import { fromBase64, toBase64, verifyAttestation } from "@x402s/shared/crypto";
import type { GuestResult, SessionStatus } from "@x402s/shared/protocol";
import { createPayer, type Payer } from "./payment.js";
import { OperationChannel } from "./operation-loop.js";
import { ClientTransport } from "./transport.js";
import { sleep } from "./timing.js";
import type { FileSessionStore } from "./session-store.js";
import {
  SandboxError,
  SessionExpiredError,
  type SandboxClientOptions,
  type SessionHandle,
} from "./types.js";

export class ClientRuntime extends ClientTransport {
  readonly payer: Payer;
  readonly allowInsecureDev: boolean;
  readonly expectedMeasurement?: string;
  readonly store?: FileSessionStore;
  readonly log: (line: string) => void;
  private readonly operations: OperationChannel;

  constructor(opts: SandboxClientOptions) {
    super(opts.apiUrl);
    this.payer = opts.payer ?? createPayer(opts.paymentMode ?? "mock");
    this.allowInsecureDev = opts.allowInsecureDev ?? true;
    this.expectedMeasurement = opts.expectedMeasurement;
    this.store = opts.store;
    this.log = opts.log ?? (() => {});
    this.operations = new OperationChannel({
      auth: (handle) => this.auth(handle),
      api: (path, init, timeoutMs, signal) => this.api(path, init, timeoutMs, signal),
      errorFrom: (res, fallback) => this.errorFrom(res, fallback),
      errorFromText: (status, text, fallback) => this.errorFromText(status, text, fallback),
      ensureReady: (handle) => this.ensureReady(handle),
    });
  }

  private async ensureReady(handle: SessionHandle): Promise<void> {
    if (!handle.guestPublicKey) await this.waitForReady(handle);
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
      mode,
      allowInsecureDev: this.allowInsecureDev,
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

  getOperation(
    handle: SessionHandle,
    requestId: string,
    waitMs = 20_000,
  ): Promise<GuestResult | null> {
    return this.operations.getOperation(handle, requestId, waitMs);
  }

  run<T extends GuestResult>(
    handle: SessionHandle,
    operation: { requestId: string },
    requestId: string,
    queueMs = 0,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.operations.run<T>(handle, operation, requestId, queueMs, timeoutMs, signal);
  }

  runGet<T extends GuestResult>(
    handle: SessionHandle,
    operation: { requestId: string },
    requestId: string,
    queueMs: number,
  ): Promise<T> {
    return this.operations.runGet<T>(handle, operation, requestId, queueMs);
  }
}
