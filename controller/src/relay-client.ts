import { readFileSync } from "node:fs";
import { Agent, fetch as undiciFetch } from "undici";
import type { RelayStateSnapshot, WarmClaim } from "@x402s/shared/protocol";
import { dataPlaneShard, shardHost } from "./data-plane-shard.js";

export interface RelayClientTlsOptions {
  certFile: string;
  keyFile: string;
  caFile: string;
}

interface RelayClientOptions {
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
  /**
   * Relay replica count and the per-shard pod host template. Above 1, every
   * session-scoped call is sent to the shard that owns the session so the
   * controller reaches the same registry the guest dialled. `baseUrl` is used
   * unchanged when this is 1 or absent.
   */
  relayReplicas?: number;
  relayHostTemplate?: string;
  relayControlPort?: number;
}

type RelayResponse =
  | { kind: "envelope"; envelope: string }
  | { kind: "pending" }
  | { kind: "guest_error"; message: string };

interface RelayHealth {
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

interface RegistrationOptions {
  /** Total time to keep retrying. Each attempt is a fresh connection. */
  deadlineMs?: number;
  /**
   * A 409 `session_already_connected` means a stale entry still holds a guest.
   * Purge it and retry (resume) instead of surfacing the conflict (cold start).
   */
  replaceConnected?: boolean;
  onRetry?: (attempt: number, error: Error) => void;
}

interface RegistrationResult {
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
  private readonly replicas: number;
  private readonly hostTemplate: string | undefined;
  private readonly controlPort: number | undefined;
  private readonly scheme: string;
  private readiness: { generation: string; at: number } | null = null;
  private readinessProbe: Promise<RelayHealth> | null = null;

  constructor(opts: RelayClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.readinessCacheMs = opts.readinessCacheMs ?? 1000;
    this.replicas = opts.relayReplicas ?? 1;
    this.hostTemplate = opts.relayHostTemplate;
    this.controlPort = opts.relayControlPort;
    this.scheme = new URL(this.baseUrl).protocol;
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
      // (maxSurge: 0), so a keep-alive socket can stay pinned to a serving but
      // terminating pod. Mutating calls therefore open a fresh connection,
      // routed to the current pod. Read-only snapshots may reuse the pool
      // because they carry the generation that answered, and callers that care
      // compare it (see `state` and the readiness path).
      // The client certificate is the credential on the mTLS path; do not also
      // send the shared token over the wire.
      ...(opts.tls ? {} : { "x-internal-token": opts.adminToken }),
    };
  }

  /**
   * Control base URL for one session. With a single replica this is `baseUrl`
   * exactly, so the local/kind paths are unchanged.
   */
  private baseFor(sessionId?: string): string {
    if (!sessionId || this.replicas <= 1 || !this.hostTemplate) return this.baseUrl;
    const shard = dataPlaneShard(sessionId, this.replicas);
    const host = shardHost(this.hostTemplate, shard);
    // The per-shard control listener is the same port as the Service's; fall
    // back to the scheme default only if neither is configured.
    const defaultPort = this.scheme === "https:" ? 443 : 80;
    const port = this.controlPort ?? Number(new URL(this.baseUrl).port || defaultPort);
    return `${this.scheme}//${host}:${port}`;
  }

  private async raw(
    path: string,
    init: RequestInit = {},
    timeoutMs?: number,
    opts: { reuse?: boolean } = {},
    baseUrl: string = this.baseUrl,
  ): Promise<Response> {
    // undici's fetch, not the global one: the global fetch uses Node's bundled
    // undici, and a dispatcher created by the npm package is a different
    // instance, which fails with UND_ERR_INVALID_ARG.
    const request = {
      ...init,
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      headers: {
        ...this.headers,
        ...(opts.reuse ? {} : { connection: "close" }),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
    } as Parameters<typeof undiciFetch>[1];
    return undiciFetch(`${baseUrl}${path}`, request) as unknown as Promise<Response>;
  }

  private async call<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs?: number,
    opts: { reuse?: boolean } = {},
    baseUrl: string = this.baseUrl,
  ): Promise<T> {
    const res = await this.raw(path, init, timeoutMs, opts, baseUrl);
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
    return this.healthFrom(this.baseUrl, timeoutMs);
  }

  /**
   * Probe the relay that owns this session. Readiness gating uses the Service
   * (any replica answers), but the generation fence around a register/state
   * read must observe the same replica, or two healthy replicas look like a
   * relay replacement.
   */
  async healthFor(sessionId: string, timeoutMs = 2000): Promise<RelayHealth> {
    return this.healthFrom(this.baseFor(sessionId), timeoutMs);
  }

  private async healthFrom(baseUrl: string, timeoutMs: number): Promise<RelayHealth> {
    const body = await this.call<Partial<RelayHealth>>("/healthz", {}, timeoutMs, {}, baseUrl);
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

  private probeHealth(sessionId?: string): Promise<RelayHealth> {
    // A shard-specific probe is not shared: the in-flight cache is keyed to one
    // process, and mixing shards would return the wrong generation.
    if (sessionId) return this.healthFor(sessionId);
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
    }, undefined, {}, this.baseFor(sessionId));
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

  async state(sessionId: string, opts: { reuse?: boolean } = {}): Promise<RelayStateSnapshot> {
    return this.call<RelayStateSnapshot>(
      `/internal/${encodeURIComponent(sessionId)}/state`,
      {},
      undefined,
      opts,
      this.baseFor(sessionId),
    );
  }

  /**
   * Publish the session's current execution epoch to the relay before the
   * operation fence is trusted. The relay then refuses frames below it and
   * withdraws a frame that was forwarded but never observed. `reset` reports
   * that the relay ended the guest link to discard such a frame.
   *
   * `result` is `unknown` when the relay has no registration for the session (a
   * relay restart): there is nothing to fence on the old generation.
   */
  async raiseEpoch(
    sessionId: string,
    epoch: number,
  ): Promise<{ result: "ok" | "unknown"; withdrawn: number; reset: boolean }> {
    try {
      const body = await this.call<{ withdrawn?: unknown; reset?: unknown }>(
        `/internal/${encodeURIComponent(sessionId)}/epoch`,
        {
          method: "POST",
          body: JSON.stringify({ epoch }),
        },
        undefined,
        {},
        this.baseFor(sessionId),
      );
      return {
        result: "ok",
        withdrawn: typeof body?.withdrawn === "number" ? body.withdrawn : 0,
        reset: body?.reset === true,
      };
    } catch (err) {
      if (err instanceof RelayUnavailableError && err.status === 404) {
        return { result: "unknown", withdrawn: 0, reset: false };
      }
      throw err;
    }
  }

  async request(sessionId: string, id: string, envelope: string, deadlineMs: number, epoch = 0): Promise<void> {
    await this.call(`/internal/${encodeURIComponent(sessionId)}/request`, {
      method: "POST",
      body: JSON.stringify({ id, envelope, deadlineMs, epoch }),
    }, 60_000, {}, this.baseFor(sessionId));
  }

  async response(sessionId: string, id: string, waitMs: number): Promise<RelayResponse> {
    const res = await this.raw(
      `/internal/${encodeURIComponent(sessionId)}/response/${encodeURIComponent(id)}?waitMs=${Math.max(0, waitMs)}`,
      {},
      waitMs + 15_000,
      {},
      this.baseFor(sessionId),
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
    }, undefined, {}, this.baseFor(sessionId));
  }

  async shutdown(sessionId: string, reason: string): Promise<void> {
    await this.call(`/internal/${encodeURIComponent(sessionId)}/shutdown`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }, undefined, {}, this.baseFor(sessionId));
  }

  /** Send a claim to a warm (unleased) guest over its pooled relay entry. */
  async claim(poolSessionId: string, claim: WarmClaim): Promise<void> {
    await this.call(`/internal/${encodeURIComponent(poolSessionId)}/claim`, {
      method: "POST",
      body: JSON.stringify({ claim }),
    }, undefined, {}, this.baseFor(poolSessionId));
  }

  async purge(sessionId: string): Promise<void> {
    try {
      await this.call(
        `/internal/${encodeURIComponent(sessionId)}`,
        { method: "DELETE" },
        undefined,
        {},
        this.baseFor(sessionId),
      );
    } catch (err) {
      if (err instanceof RelayUnavailableError && err.status === 404) return;
      throw err;
    }
  }
}
