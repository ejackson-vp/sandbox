/**
 * Internal controller client. The API holds no state; the controller owns the
 * single-writer database and the Kubernetes lifecycle.
 */
import type {
  EntitlementRequest,
  EntitlementResponse,
  RelaySessionState,
  SandboxState,
} from "@x402s/shared";

export interface SessionView {
  sessionId: string;
  state: SandboxState;
  durationSeconds: number;
  createdAt: number;
  paidAt?: number;
  readyAt?: number;
  executionDeadlineAt?: number;
  completedAt?: number;
  destroyedAt?: number;
  clientNonce: string;
  clientPublicKey: string;
  capabilityHash: string;
  capabilityExpiresAt: number;
  guestPublicKey?: string;
  attestation?: unknown;
  failureCode?: string;
  failureMessage?: string;
  runtimeClass?: string;
  executionMode?: "dev" | "kata" | "confidential";
  payment: {
    paymentKey: string;
    network: string;
    scheme: string;
    asset: string;
    amount: string;
    payTo: string;
    payer?: string;
    transaction?: string;
    mode: "mock" | "testnet";
  };
  relay: RelaySessionState;
}

export class ControllerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

export class ControllerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly adminToken: string,
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(new URL(path, this.baseUrl), {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-internal-token": this.adminToken,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(150_000),
    });
    const text = await res.text();
    let body: unknown = undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const b = body as { error?: string; message?: string } | undefined;
      throw new ControllerError(
        res.status,
        b?.error ?? "controller_error",
        b?.message ?? `controller returned ${res.status}`,
        body,
      );
    }
    return body as T;
  }

  async createEntitlement(req: EntitlementRequest): Promise<EntitlementResponse> {
    return this.call<EntitlementResponse>("/internal/entitlements", {
      method: "POST",
      body: JSON.stringify(req),
    });
  }

  async getSession(sessionId: string): Promise<SessionView> {
    return this.call<SessionView>(`/internal/sessions/${encodeURIComponent(sessionId)}`);
  }

  async execute(sessionId: string, envelope: string): Promise<{ state: SandboxState; remainingMs: number }> {
    return this.call(`/internal/sessions/${encodeURIComponent(sessionId)}/execute`, {
      method: "POST",
      body: JSON.stringify({ envelope }),
    });
  }

  async result(sessionId: string): Promise<{ state: SandboxState; envelope?: string }> {
    return this.call(`/internal/sessions/${encodeURIComponent(sessionId)}/result`);
  }

  async destroy(sessionId: string): Promise<{ state: SandboxState }> {
    return this.call(`/internal/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  }

  async healthz(): Promise<{ ok: boolean }> {
    return this.call("/internal/healthz");
  }
}
