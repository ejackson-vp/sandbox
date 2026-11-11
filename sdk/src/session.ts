/**
 * Session lifecycle: create/attach/checkpoint/resume/destroy.
 */
import { fromBase64, generateBoxKeyPair, generateNonce, toBase64 } from "@x402s/shared/crypto";
import type { CreateSessionRequest, CreateSessionResponse, SessionStatus } from "@x402s/shared/protocol";
import type { ClientRuntime } from "./runtime.js";
import { sleep } from "./runtime.js";
import {
  SandboxError,
  SessionExpiredError,
  type CreateOptions,
  type SessionHandle,
} from "./types.js";

export class SessionService {
  constructor(private readonly rt: ClientRuntime) {}

  async create(opts: CreateOptions = {}): Promise<SessionHandle> {
    const keys = await generateBoxKeyPair();
    const clientNonce = toBase64(await generateNonce());
    const customResources =
      opts.tier === undefined &&
      [opts.cpuMillis, opts.memoryMiB, opts.diskMiB, opts.baselineCpuMillis, opts.baselineMemoryMiB]
        .some((value) => value !== undefined);
    const body: CreateSessionRequest = {
      ...(opts.tier ? { tier: opts.tier } : customResources ? { tier: "custom" as const } : {}),
      ...(opts.durationSeconds === undefined ? {} : { durationSeconds: opts.durationSeconds }),
      ...(opts.cpuMillis === undefined ? {} : { cpuMillis: opts.cpuMillis }),
      ...(opts.memoryMiB === undefined ? {} : { memoryMiB: opts.memoryMiB }),
      ...(opts.diskMiB === undefined ? {} : { diskMiB: opts.diskMiB }),
      ...(opts.baselineCpuMillis === undefined ? {} : { baselineCpuMillis: opts.baselineCpuMillis }),
      ...(opts.baselineMemoryMiB === undefined ? {} : { baselineMemoryMiB: opts.baselineMemoryMiB }),
      ...(opts.idlePolicy ? { idlePolicy: opts.idlePolicy } : {}),
      ...(opts.maxLifetimeSeconds === undefined ? {} : { maxLifetimeSeconds: opts.maxLifetimeSeconds }),
      ...(opts.runtime === undefined ? {} : { runtime: opts.runtime }),
      clientPublicKey: toBase64(keys.publicKey),
      clientNonce,
    };

    const paid = await this.rt.payer.createSession(this.rt.apiUrl, body);
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
      throw new SandboxError(
        code,
        `session creation failed (${paid.response.status}): ${text.slice(0, 300)}`,
        paid.response.status,
      );
    }

    const created = (await paid.response.json()) as CreateSessionResponse;
    // Newer servers embed the session view in the create response, so the
    // handle is complete without an immediate GET /v1/sessions/{id}. Older
    // servers omit it; keep the locally derived view as the fallback.
    // The local nonce always wins so the handle stays bound to this client key.
    const status: SessionStatus = created.session
      ? { ...created.session, sessionId: created.sessionId, clientNonce }
      : {
          sessionId: created.sessionId,
          state: created.state,
          tier: created.tier,
          durationSeconds: created.durationSeconds,
          limits: created.limits,
          ...(created.runtime ? { runtime: created.runtime } : {}),
          ...(created.baseline ? { baseline: created.baseline } : {}),
          createdAt: new Date().toISOString(),
          remainingSeconds: created.durationSeconds,
          clientNonce,
          payment: created.payment,
          busy: false,
        };
    const handle: SessionHandle = {
      sessionId: created.sessionId,
      capability: created.capability,
      clientPublicKey: keys.publicKey,
      clientPrivateKey: keys.privateKey,
      clientNonce,
      status,
      createdAt: Date.now(),
    };
    this.rt.log(
      `session ${created.sessionId} created (${created.tier}, ${created.durationSeconds}s, ${created.payment.priceUsd})`,
    );
    if (opts.save !== false) this.rt.persist(handle);
    return handle;
  }

  /** Reconstruct a handle from the local credential store. */
  attach(sessionId: string): SessionHandle {
    if (!this.rt.store) throw new SandboxError("no_store", "this client has no session store configured");
    const stored = this.rt.store.get(sessionId);
    if (!stored) throw new SandboxError("session_not_found", `no local credentials for ${sessionId}`);
    if (stored.apiUrl !== this.rt.apiUrl) {
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

  listLocal() {
    return this.rt.store?.list() ?? [];
  }

  forgetLocal(sessionId: string): void {
    this.rt.forgetLocal(sessionId);
  }

  async suspend(handle: SessionHandle): Promise<SessionStatus> {
    const res = await this.rt.api(`/v1/sessions/${handle.sessionId}/suspend`, {
      method: "POST",
      headers: this.rt.auth(handle),
    });
    if (!res.ok) throw await this.rt.errorFrom(res, "suspend_failed");
    const status = (await res.json()) as SessionStatus;
    handle.status = status;
    this.rt.persist(handle);
    return status;
  }

  async resume(handle: SessionHandle, timeoutMs = 180_000): Promise<SessionStatus> {
    const res = await this.rt.api(`/v1/sessions/${handle.sessionId}/resume`, {
      method: "POST",
      headers: this.rt.auth(handle),
    });
    if (!res.ok) throw await this.rt.errorFrom(res, "resume_failed");
    return this.rt.waitForReady(handle, timeoutMs);
  }

  async destroy(handle: SessionHandle, waitMs = 30_000): Promise<SessionStatus | null> {
    await this.rt.api(`/v1/sessions/${handle.sessionId}`, { method: "DELETE", headers: this.rt.auth(handle) });
    this.rt.forgetLocal(handle.sessionId);
    const deadline = Date.now() + waitMs;
    let last: SessionStatus | null = null;
    let polls = 0;
    while (Date.now() < deadline) {
      try {
        last = await this.rt.status(handle);
        if (["DESTROYED", "EXPIRED", "FAILED"].includes(last.state)) return last;
      } catch (err) {
        if (err instanceof SessionExpiredError) return null;
        if (err instanceof SandboxError && err.code === "rate_limited") {
          await sleep(100);
          continue;
        }
        throw err;
      }
      await sleep(polls++ < 10 ? 100 : 250);
    }
    return last;
  }
}
