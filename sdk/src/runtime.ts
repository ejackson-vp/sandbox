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
import { pollUntil } from "./timing.js";
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
    const ready = await pollUntil<SessionStatus>(
      deadline,
      async () => {
        let next: SessionStatus;
        try {
          next = await this.status(handle);
        } catch (err) {
          // A rate limit is a wait, not a failure: `pollUntil` reads it as one
          // and honours the `Retry-After` the limiter sent.
          if (err instanceof SandboxError && err.code === "rate_limited") throw err;
          // A restarting API can answer 502/503 before its routes are live.
          // Retry server-side failures, but surface real client errors.
          if (err instanceof SandboxError && !(err.status !== undefined && err.status >= 500)) {
            throw err;
          }
          // The API may be restarting or briefly unreachable. Treat transport
          // failures as retryable so callers can wait through a control-plane
          // restart instead of surfacing a transient "fetch failed".
          lastTransportError = err;
          return undefined;
        }
        last = next;
        lastTransportError = undefined;
        if (next.state === "READY" || next.state === "ACTIVE") return next;
        if (next.state === "EXPIRED" || next.state === "DESTROYED") {
          throw new SessionExpiredError(`session is ${next.state}`);
        }
        if (next.state === "FAILED" || next.state === "TERMINATING") {
          throw new SandboxError(
            "session_failed",
            `session ended before it became ready (${next.state}${next.failure ? `: ${next.failure.code}` : ""})`,
          );
        }
        return undefined;
      },
      { fastMs: 75, slowMs: 200, fastPolls: 8 },
    );
    if (!ready) {
      // A rate limit never becomes the reported failure: the deadline is, and it
      // says the sandbox did not arrive in time rather than blaming the limiter.
      if (!last && lastTransportError) throw lastTransportError;
      throw new SandboxError("ready_timeout", "sandbox did not become ready in time");
    }
    if (!ready.attestation || !ready.guestPublicKey) {
      throw new SandboxError("missing_attestation", "READY session did not provide attestation evidence");
    }

    const mode = ready.executionMode ?? "dev";
    const verdict = verifyAttestation(ready.attestation, {
      mode,
      allowInsecureDev: this.allowInsecureDev,
      expectedSessionId: handle.sessionId,
      expectedClientNonce: handle.clientNonce,
      expectedClientPublicKey: toBase64(handle.clientPublicKey),
      maxEvidenceAgeMs: ready.durationSeconds * 1000 + 300_000,
      ...(this.expectedMeasurement ? { allowedMeasurements: [this.expectedMeasurement] } : {}),
    });
    if (!verdict.ok) {
      throw new SandboxError("attestation_rejected", `attestation rejected: ${verdict.code} (${verdict.message})`);
    }
    handle.guestPublicKey = fromBase64(ready.guestPublicKey);
    if (handle.guestPublicKey.length !== 32) {
      throw new SandboxError("invalid_guest_key", "guest public key has an invalid length");
    }
    handle.status = ready;
    this.persist(handle);
    return ready;
  }

  getOperation(
    handle: SessionHandle,
    requestId: string,
    waitMs = 20_000,
  ): Promise<GuestResult | null> {
    return this.operations.getOperation(handle, requestId, waitMs);
  }

  run<T extends GuestResult>(req: {
    handle: SessionHandle;
    operation: { requestId: string };
    requestId: string;
    queueMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<T> {
    return this.operations.run<T>(req);
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
