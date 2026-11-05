import type { RelaySessionState } from "@x402s/shared";

export interface RelayClientOptions {
  baseUrl: string;
  adminToken: string;
  timeoutMs?: number;
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
      const err = new Error(`relay ${res.status}`) as Error & { status?: number; body?: unknown };
      err.status = res.status;
      err.body = body;
      throw err;
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

  async deliver(sessionId: string, envelope: string, deadlineMs: number): Promise<void> {
    await this.call(`/internal/${encodeURIComponent(sessionId)}/deliver`, {
      method: "POST",
      body: JSON.stringify({ envelope, deadlineMs }),
    });
  }

  async result(
    sessionId: string,
    waitMs = 20_000,
  ): Promise<{ envelope: string | null; error?: { code: string; message: string } }> {
    return this.call(
      `/internal/${encodeURIComponent(sessionId)}/result?waitMs=${waitMs}`,
      {},
      waitMs + 5000,
    );
  }

  async purge(sessionId: string): Promise<void> {
    try {
      await this.call(`/internal/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    } catch (err) {
      if ((err as { status?: number }).status === 404) return;
      throw err;
    }
  }
}
