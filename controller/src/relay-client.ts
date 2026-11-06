import type { RelaySessionState, WarmClaim } from "@x402s/shared";

export interface RelayClientOptions {
  baseUrl: string;
  adminToken: string;
  timeoutMs?: number;
}

export type RelayResponse =
  | { kind: "envelope"; envelope: string }
  | { kind: "pending" }
  | { kind: "guest_error"; message: string };

class RelayUnavailableError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "RelayUnavailableError";
  }
}

export class RelayClient {
  private readonly baseUrl: string;
  private readonly adminToken: string;
  private readonly timeoutMs: number;

  constructor(opts: RelayClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.adminToken = opts.adminToken;
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  private async call<T>(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-internal-token": this.adminToken,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
    });
    const text = await res.text();
    const body = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const message = (body as { error?: string } | undefined)?.error ?? `relay ${res.status}`;
      throw new RelayUnavailableError(res.status, message);
    }
    return body as T;
  }

  async register(sessionId: string, tokenHash: string, ttlMs: number): Promise<void> {
    await this.call("/internal/register", {
      method: "POST",
      body: JSON.stringify({ sessionId, tokenHash, ttlMs }),
    });
  }

  async state(sessionId: string): Promise<RelaySessionState> {
    return this.call<RelaySessionState>(`/internal/${encodeURIComponent(sessionId)}/state`);
  }

  async request(sessionId: string, id: string, envelope: string, deadlineMs: number): Promise<void> {
    await this.call(`/internal/${encodeURIComponent(sessionId)}/request`, {
      method: "POST",
      body: JSON.stringify({ id, envelope, deadlineMs }),
    }, 60_000);
  }

  async response(sessionId: string, id: string, waitMs: number): Promise<RelayResponse> {
    const res = await fetch(
      `${this.baseUrl}/internal/${encodeURIComponent(sessionId)}/response/${encodeURIComponent(id)}?waitMs=${Math.max(0, waitMs)}`,
      {
        headers: { "x-internal-token": this.adminToken },
        signal: AbortSignal.timeout(waitMs + 15_000),
      },
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
