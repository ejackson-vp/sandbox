/**
 * Internal controller client. The API holds no durable state; the controller
 * owns the single-writer database and the Kubernetes lifecycle.
 */
import type {
  AttestationEnvelope,
  PaymentSummary,
  SessionLimits,
  SessionSpec,
  SessionState,
  SessionTier,
  SessionTimings,
} from "@x402s/shared";

export interface SessionView {
  sessionId: string;
  state: SessionState;
  tier: SessionTier;
  durationSeconds: number;
  limits: SessionLimits;
  createdAt: number;
  paidAt?: number;
  readyAt?: number;
  leaseExpiresAt?: number;
  remainingSeconds: number;
  terminatingAt?: number;
  destroyedAt?: number;
  clientNonce: string;
  clientPublicKey: string;
  capabilityHash: string;
  capabilityExpiresAt: number;
  guestPublicKey?: string;
  attestation?: AttestationEnvelope;
  suspendedAt?: number;
  resumeCount?: number;
  maxLifetimeSeconds?: number;
  idlePolicy?: {
    maxIdleSeconds?: number;
    suspendedDurationSeconds?: number;
    autoResume?: boolean;
  };
  baseline?: { cpuMillis: number; memoryMiB: number };
  failureCode?: string;
  failureMessage?: string;
  runtimeClass?: string;
  executionMode?: "dev" | "kata" | "confidential";
  busy: boolean;
  timings?: SessionTimings;
  payment: PaymentSummary & { paymentKey: string };
}

export interface OperationResult {
  state: SessionState;
  requestId: string;
  envelope?: string;
  pending?: boolean;
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

export type IntentClaim =
  | { status: "claimed"; recovered: boolean }
  | { status: "settled"; sessionId: string }
  | { status: "in_progress" }
  | { status: "failed"; reason?: string }
  | { status: "mismatch" };

export type CapacityDecision =
  | { admitted: true; nodeId: string; reservation: { nodeId: string } }
  | {
      admitted: false;
      reason: string;
      retryable: boolean;
      requested: { cpuMillicores: number; memoryBytes: number; storageBytes: number };
    };

export interface CompleteIntentBody {
  sessionId: string;
  capabilityHash: string;
  capabilityExpiresAt: number;
  spec: SessionSpec;
  clientPublicKey: string;
  clientNonce: string;
  timings?: {
    apiReceivedAt?: number;
    paymentVerifyMs?: number;
    paymentSettleMs?: number;
    entitlementMs?: number;
  };
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
}

export class ControllerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly adminToken: string,
  ) {}

  private async raw(path: string, init: RequestInit = {}, timeoutMs = 150_000): Promise<Response> {
    return fetch(new URL(path, this.baseUrl), {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-internal-token": this.adminToken,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
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
      const b = body as { error?: string; message?: string; state?: string } | undefined;
      throw new ControllerError(res.status, b?.error ?? "controller_error", b?.message ?? `controller ${res.status}`, body);
    }
    return body as T;
  }

  /* ---------------- payment intents ---------------- */

  async claimIntent(paymentKey: string, specHash: string, staleMs?: number): Promise<IntentClaim> {
    const res = await this.raw("/internal/payment-intents/claim", {
      method: "POST",
      body: JSON.stringify({ paymentKey, specHash, staleMs }),
    });
    const body = (await res.json().catch(() => ({}))) as IntentClaim & { status?: string };
    if (res.ok) return body as IntentClaim;
    if (res.status === 409) {
      if (body.status === "in_progress") return { status: "in_progress" };
      if (body.status === "failed") return { status: "failed", reason: (body as { reason?: string }).reason };
      if (body.status === "mismatch") return { status: "mismatch" };
    }
    throw new ControllerError(res.status, "intent_claim_failed", `intent claim failed (${res.status})`, body);
  }

  async completeIntent(paymentKey: string, body: CompleteIntentBody): Promise<{ sessionId: string; state: SessionState }> {
    return this.call(`/internal/payment-intents/${encodeURIComponent(paymentKey)}/complete`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async failIntent(paymentKey: string, reason: string): Promise<void> {
    await this.call(`/internal/payment-intents/${encodeURIComponent(paymentKey)}/fail`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
  }

  async preflightCapacity(spec: SessionSpec): Promise<CapacityDecision> {
    return this.call("/internal/capacity/preflight", {
      method: "POST",
      body: JSON.stringify({ spec }),
    });
  }

  async holdCapacity(paymentKey: string, specHash: string, spec: SessionSpec): Promise<CapacityDecision> {
    const res = await this.raw("/internal/capacity/holds", {
      method: "POST",
      body: JSON.stringify({ paymentKey, specHash, spec }),
    });
    const body = (await res.json().catch(() => ({}))) as CapacityDecision & { error?: string; message?: string };
    if (res.ok || res.status === 409) return body;
    throw new ControllerError(res.status, body.error ?? "capacity_hold_failed", body.message ?? `controller ${res.status}`, body);
  }

  async releaseCapacity(paymentKey: string): Promise<void> {
    await this.call(`/internal/capacity/holds/${encodeURIComponent(paymentKey)}`, { method: "DELETE" }).catch(() => undefined);
  }

  async capacity(): Promise<unknown> {
    return this.call("/internal/capacity");
  }

  /* ---------------- sessions ---------------- */

  async getSession(sessionId: string): Promise<SessionView> {
    return this.call<SessionView>(`/internal/sessions/${encodeURIComponent(sessionId)}`);
  }

  async operation(
    sessionId: string,
    body: { requestId: string; envelope: string; op?: string; waitMs?: number },
  ): Promise<OperationResult> {
    const res = await this.raw(`/internal/sessions/${encodeURIComponent(sessionId)}/operations`, {
      method: "POST",
      body: JSON.stringify(body),
    }, 180_000);
    const parsed = (await res.json().catch(() => ({}))) as OperationResult & { error?: string; message?: string };
    if (res.ok || res.status === 202) return parsed;
    throw new ControllerError(res.status, parsed.error ?? "operation_failed", parsed.message ?? `controller ${res.status}`, parsed);
  }

  async getOperation(sessionId: string, requestId: string, waitMs = 20_000): Promise<OperationResult> {
    const res = await this.raw(
      `/internal/sessions/${encodeURIComponent(sessionId)}/operations/${encodeURIComponent(requestId)}?waitMs=${waitMs}`,
      {},
      waitMs + 20_000,
    );
    const parsed = (await res.json().catch(() => ({}))) as OperationResult & { error?: string; message?: string };
    if (res.ok || res.status === 202) return parsed;
    throw new ControllerError(res.status, parsed.error ?? "operation_failed", parsed.message ?? `controller ${res.status}`, parsed);
  }

  async cancelOperation(sessionId: string, requestId: string): Promise<void> {
    await this.call(
      `/internal/sessions/${encodeURIComponent(sessionId)}/operations/${encodeURIComponent(requestId)}`,
      { method: "DELETE" },
    );
  }

  async suspend(sessionId: string): Promise<SessionView> {
    return this.call<SessionView>(`/internal/sessions/${encodeURIComponent(sessionId)}/suspend`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  async resume(sessionId: string): Promise<SessionView> {
    return this.call<SessionView>(`/internal/sessions/${encodeURIComponent(sessionId)}/resume`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  async destroy(sessionId: string): Promise<{ state: SessionState }> {
    return this.call(`/internal/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  }

  /** Fire-and-forget nudge so provisioning/cleanup does not wait for a tick. */
  async wake(): Promise<void> {
    try {
      await this.call("/internal/wake", { method: "POST" }, 2000);
    } catch {
      /* best effort: the periodic tick still runs */
    }
  }

  async healthz(): Promise<{ ok: boolean }> {
    return this.call("/internal/healthz");
  }
}
