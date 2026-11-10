import { readFileSync } from "node:fs";
import { Agent, fetch as undiciFetch } from "undici";
import type { RelaySessionState, WarmClaim } from "@x402s/shared";

export interface RelayClientTlsOptions {
  certFile: string;
  keyFile: string;
  caFile: string;
}

export interface RelayClientOptions {
  /** Control URL. `https://…` when `tls` is set (the mTLS control listener). */
  baseUrl: string;
  /** Low-privilege relay admin token; plaintext local-dev path only. */
  adminToken: string;
  /**
   * Client certificate, key and CA for the relay's mTLS control listener. When
   * present the certificate is the credential and the shared token is not sent.
   */
  tls?: RelayClientTlsOptions;
  timeoutMs?: number;
  /**
   * How long a readiness probe may be reused. The reconcile tick is 250 ms, so
   * without a cache every paid session would probe the relay four times a
   * second.
   */
  readinessCacheMs?: number;
}

export type RelayResponse =
  | { kind: "envelope"; envelope: string }
  | { kind: "pending" }
  | { kind: "guest_error"; message: string };

export interface RelayHealth {
  ok: boolean;
  /** Per-process identity; changes on every relay restart. */
  generation: string;
  sessions?: number;
}

export class RelayUnavailableError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "RelayUnavailableError";
  }
}

export interface RegistrationOptions {
  /** Total time to keep retrying. Each attempt is a fresh connection. */
  deadlineMs?: number;
  /**
   * A 409 `session_already_connected` means a stale entry still holds a guest.
   * Purge it and retry (resume) instead of surfacing the conflict (cold start).
   */
  replaceConnected?: boolean;
  onRetry?: (attempt: number, error: Error) => void;
}

export interface RegistrationResult {
  generation: string;
  attempts: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class RelayClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly readinessCacheMs: number;
  private readonly headers: Record<string, string>;
  private readonly dispatcher?: Agent;
  private readiness: { generation: string; at: number } | null = null;
  private readinessProbe: Promise<RelayHealth> | null = null;

  constructor(opts: RelayClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.readinessCacheMs = opts.readinessCacheMs ?? 1000;
    if (opts.tls) {
      this.dispatcher = new Agent({
        connect: {
          cert: readFileSync(opts.tls.certFile),
          key: readFileSync(opts.tls.keyFile),
          ca: readFileSync(opts.tls.caFile),
        },
      });
    }
    this.headers = {
      "content-type": "application/json",
      // The relay's registry is in memory and the Deployment replaces the pod
      // (maxSurge: 0). A keep-alive socket can stay pinned to the old pod
      // through a Service after its endpoints are gone, so control calls must
      // open a fresh connection and be routed to the current pod.
      connection: "close",
      // The client certificate is the credential on the mTLS path; do not also
      // send the shared token over the wire.
      ...(opts.tls ? {} : { "x-internal-token": opts.adminToken }),
    };
  }

  private async raw(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<Response> {
    // undici's fetch, not the global one: the global fetch uses Node's bundled
    // undici, and a dispatcher created by the npm package is a different
    // instance, which fails with UND_ERR_INVALID_ARG.
    const request = {
      ...init,
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      headers: {
        ...this.headers,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
    } as Parameters<typeof undiciFetch>[1];
    return undiciFetch(`${this.baseUrl}${path}`, request) as unknown as Promise<Response>;
  }

  private async call<T>(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
    const res = await this.raw(path, init, timeoutMs);
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const message = (body as { error?: string } | undefined)?.error ?? `relay ${res.status}`;
      throw new RelayUnavailableError(res.status, message);
    }
    return body as T;
  }

  /** Probe readiness and read the current relay generation. */
  async health(timeoutMs = 2000): Promise<RelayHealth> {
    const body = await this.call<Partial<RelayHealth>>("/healthz", {}, timeoutMs);
    if (body?.ok !== true || typeof body.generation !== "string" || body.generation.length === 0) {
      throw new RelayUnavailableError(503, "relay_not_ready");
    }
    return { ok: true, generation: body.generation, ...(typeof body.sessions === "number" ? { sessions: body.sessions } : {}) };
  }

  /** Cached readiness for admission gating; a negative probe is never cached. */
  async isReady(): Promise<boolean> {
    if (this.readiness && Date.now() - this.readiness.at <= this.readinessCacheMs) return true;
    try {
      const health = await this.probeHealth();
      this.readiness = { generation: health.generation, at: Date.now() };
      return true;
    } catch {
      this.readiness = null;
      return false;
    }
  }

  /** The generation observed by the last successful readiness probe. */
  readyGeneration(): string | null {
    return this.readiness?.generation ?? null;
  }

  private probeHealth(): Promise<RelayHealth> {
    if (!this.readinessProbe) {
      this.readinessProbe = this.health().finally(() => {
        this.readinessProbe = null;
      });
    }
    return this.readinessProbe;
  }

  async register(
    sessionId: string,
    tokenHash: string,
    ttlMs: number,
    generation?: string,
  ): Promise<{ generation: string }> {
    const body = await this.call<{ ok: boolean; generation?: string }>("/internal/register", {
      method: "POST",
      body: JSON.stringify({
        sessionId,
        tokenHash,
        ttlMs,
        ...(generation ? { generation } : {}),
      }),
    });
    return { generation: typeof body?.generation === "string" ? body.generation : (generation ?? "") };
  }

  /**
   * Register against the relay generation that is serving *now*.
   *
   * Each attempt probes /healthz, registers with that generation as a
   * precondition, then probes again. If the generation changed at any point the
   * registration was accepted by a relay that is being replaced and is
   * discarded: the loop retries against the replacement. This is what closes
   * the "controller registered on the terminating relay" window.
   */
  async registerCurrent(
    sessionId: string,
    tokenHash: string,
    ttlMs: number,
    opts: RegistrationOptions = {},
  ): Promise<RegistrationResult> {
    const deadline = Date.now() + (opts.deadlineMs ?? 10_000);
    let delay = 100;
    let attempt = 0;
    let lastError: Error | undefined;

    for (;;) {
      attempt += 1;
      try {
        const before = await this.probeHealth();
        try {
          const registered = await this.register(sessionId, tokenHash, ttlMs, before.generation);
          if (registered.generation && registered.generation !== before.generation) {
            throw new RelayUnavailableError(409, "relay_generation_changed");
          }
          const after = await this.probeHealth();
          if (after.generation !== before.generation) {
            throw new RelayUnavailableError(409, "relay_generation_changed");
          }
          this.readiness = { generation: after.generation, at: Date.now() };
          return { generation: after.generation, attempts: attempt };
        } catch (err) {
          if (
            opts.replaceConnected &&
            err instanceof RelayUnavailableError &&
            err.status === 409 &&
            err.message === "session_already_connected"
          ) {
            // A resumed session may still hold a stale entry. Replace it so the
            // new guest token is the valid one, then retry.
            await this.purge(sessionId).catch(() => undefined);
          }
          throw err;
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.readiness = null;
        opts.onRetry?.(attempt, lastError);
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await sleep(Math.min(delay, remaining));
        delay = Math.min(delay * 2, 1_000);
      }
    }

    throw new RelayUnavailableError(
      503,
      `relay registration failed: ${lastError?.message ?? "relay unavailable"}`,
    );
  }

  async state(sessionId: string): Promise<RelaySessionState> {
    return this.call<RelaySessionState>(`/internal/${encodeURIComponent(sessionId)}/state`);
  }

  async request(sessionId: string, id: string, envelope: string, deadlineMs: number, epoch = 0): Promise<void> {
    await this.call(`/internal/${encodeURIComponent(sessionId)}/request`, {
      method: "POST",
      body: JSON.stringify({ id, envelope, deadlineMs, epoch }),
    }, 60_000);
  }

  async response(sessionId: string, id: string, waitMs: number): Promise<RelayResponse> {
    const res = await this.raw(
      `/internal/${encodeURIComponent(sessionId)}/response/${encodeURIComponent(id)}?waitMs=${Math.max(0, waitMs)}`,
      {},
      waitMs + 15_000,
    );
    const body = (await res.json().catch(() => ({}))) as {
      envelope?: string;
      pending?: boolean;
      error?: string;
      message?: string;
    };
    if (res.status === 200 && typeof body.envelope === "string") {
      return { kind: "envelope", envelope: body.envelope };
    }
    if (res.status === 202) return { kind: "pending" };
    if (res.status === 409) return { kind: "guest_error", message: body.message ?? body.error ?? "guest error" };
    throw new RelayUnavailableError(res.status, body.error ?? `relay ${res.status}`);
  }

  async cancel(sessionId: string, id: string): Promise<void> {
    await this.call(`/internal/${encodeURIComponent(sessionId)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ id }),
    });
  }

  async shutdown(sessionId: string, reason: string): Promise<void> {
    await this.call(`/internal/${encodeURIComponent(sessionId)}/shutdown`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
  }

  /** Send a claim to a warm (unleased) guest over its pooled relay entry. */
  async claim(poolSessionId: string, claim: WarmClaim): Promise<void> {
    await this.call(`/internal/${encodeURIComponent(poolSessionId)}/claim`, {
      method: "POST",
      body: JSON.stringify({ claim }),
    });
  }

  async purge(sessionId: string): Promise<void> {
    try {
      await this.call(`/internal/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    } catch (err) {
      if (err instanceof RelayUnavailableError && err.status === 404) return;
      throw err;
    }
  }
}
