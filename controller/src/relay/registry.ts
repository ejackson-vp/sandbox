import type { WebSocket } from "ws";
import type { AttestationEnvelope, RelaySessionState } from "@x402s/shared";
import { constantTimeEqual, sha256Hex } from "../tokens.js";

export const MAX_FRAME_BYTES = 24 * 1024 * 1024;
export const MAX_PENDING = 8;
const MAX_CACHED_RESPONSES = 64;

export type WaiterValue = { envelope: string } | { error: string } | null;

interface Pending {
  at: number;
  waiter?: (value: WaiterValue) => void;
}

interface CachedResponse {
  envelope: string;
  at: number;
}

interface CachedError {
  message: string;
  at: number;
}

interface Entry {
  sessionId: string;
  tokenHash: string;
  expiresAt: number;
  ws: WebSocket | null;
  connectedAt: number | null;
  hello: AttestationEnvelope | null;
  helloAt: number | null;
  pending: Map<string, Pending>;
  responses: Map<string, CachedResponse>;
  errors: Map<string, CachedError>;
  lastError: { code: string; message: string } | null;
  /** Guest-reported operation state; null until the guest sends a status frame. */
  activeRequestId: string | null;
  execEpoch: number | null;
  statusAt: number | null;
}

export interface RelayRegistryOptions {
  maxSessions: number;
  responseTtlMs: number;
  /** Called for a non-pool guest hello; the composition root wakes the controller. */
  onHello?: (sessionId: string) => void;
}

export type RegisterResult = "ok" | "already_connected" | "at_capacity";
export type RequestResult = "sent" | "cached" | "pending" | "too_many" | "not_connected" | "not_registered";
export type SendResult = "sent" | "not_registered" | "not_connected";
export type AttachResult = "ok" | "not_found" | "expired" | "bad_token" | "connected";

export type WaitResult =
  | { kind: "envelope"; envelope: string }
  | { kind: "error"; message: string }
  | { kind: "pending"; stillPending: boolean }
  | { kind: "not_registered" };

export class RelayRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly opts: RelayRegistryOptions) {}

  size(): number {
    return this.entries.size;
  }

  pendingTotal(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.pending.size;
    return total;
  }

  register(sessionId: string, tokenHash: string, ttlMs?: number): RegisterResult {
    if (this.entries.size >= this.opts.maxSessions && !this.entries.has(sessionId)) {
      return "at_capacity";
    }
    const existing = this.entries.get(sessionId);
    if (existing?.ws) return "already_connected";
    this.entries.set(sessionId, {
      sessionId,
      tokenHash,
      expiresAt: Date.now() + (ttlMs || 3_600_000),
      ws: null,
      connectedAt: null,
      hello: null,
      helloAt: existing?.helloAt ?? null,
      pending: existing?.pending ?? new Map(),
      responses: existing?.responses ?? new Map(),
      errors: existing?.errors ?? new Map(),
      lastError: null,
      // A fresh registration is a fresh guest process. Do not inherit an
      // execution state: fail closed until the guest reports one.
      activeRequestId: null,
      execEpoch: null,
      statusAt: null,
    });
    return "ok";
  }

  state(sessionId: string): RelaySessionState {
    const entry = this.entries.get(sessionId);
    if (!entry) return { registered: false, connected: false, pending: 0 };
    return {
      registered: true,
      connected: Boolean(entry.ws && entry.ws.readyState === 1),
      pending: entry.pending.size,
      ...(entry.hello ? { attestation: entry.hello } : {}),
      ...(entry.helloAt ? { helloAt: entry.helloAt } : {}),
      ...(entry.statusAt !== null
        ? {
            activeRequestId: entry.activeRequestId ?? "",
            execEpoch: entry.execEpoch ?? 0,
            statusAt: entry.statusAt,
          }
        : {}),
      ...(entry.lastError ? { error: entry.lastError.message } : {}),
    };
  }

  request(sessionId: string, id: string, envelope: string, deadlineMs?: number, epoch = 0): RequestResult {
    const entry = this.entries.get(sessionId);
    if (!entry) return "not_registered";
    if (entry.responses.has(id) || entry.errors.has(id)) return "cached";
    if (entry.pending.has(id)) return "pending";
    if (entry.pending.size >= MAX_PENDING) return "too_many";
    if (!entry.ws || entry.ws.readyState !== 1) return "not_connected";
    entry.pending.set(id, { at: Date.now() });
    entry.ws.send(
      JSON.stringify({
        type: "request",
        id,
        envelope,
        deadlineMs: Number(deadlineMs) || Date.now() + 60_000,
        epoch: Number(epoch) || 0,
      }),
    );
    return "sent";
  }

  /** Record the guest's own view of its single execution slot. */
  status(sessionId: string, activeRequestId: string, epoch: number): "ok" | "unknown" {
    const entry = this.entries.get(sessionId);
    if (!entry) return "unknown";
    entry.activeRequestId = activeRequestId || null;
    entry.execEpoch = Number.isFinite(epoch) ? epoch : 0;
    entry.statusAt = Date.now();
    return "ok";
  }

  cancel(sessionId: string, id: string): SendResult {
    const entry = this.entries.get(sessionId);
    if (!entry) return "not_registered";
    if (!entry.ws || entry.ws.readyState !== 1) return "not_connected";
    entry.ws.send(JSON.stringify({ type: "cancel", id }));
    return "sent";
  }

  shutdown(sessionId: string, reason: string): SendResult {
    const entry = this.entries.get(sessionId);
    if (!entry) return "not_registered";
    try {
      if (entry.ws && entry.ws.readyState === 1) {
        entry.ws.send(JSON.stringify({ type: "shutdown", reason }));
      }
    } catch {
      /* the pod is going away anyway */
    }
    return "sent";
  }

  claim(sessionId: string, claim: unknown): SendResult {
    const entry = this.entries.get(sessionId);
    if (!entry) return "not_registered";
    if (!entry.ws || entry.ws.readyState !== 1) return "not_connected";
    try {
      entry.ws.send(JSON.stringify({ type: "claim", claim }));
    } catch {
      return "not_connected";
    }
    return "sent";
  }

  /** Long-poll for a response. Returns pending when the deadline passes. */
  async waitForResponse(sessionId: string, id: string, waitMs: number): Promise<WaitResult> {
    const entry = this.entries.get(sessionId);
    if (!entry) return { kind: "not_registered" };
    this.prune(entry);

    const cachedError = entry.errors.get(id);
    if (cachedError) return { kind: "error", message: cachedError.message };
    const cached = entry.responses.get(id);
    if (cached) return { kind: "envelope", envelope: cached.envelope };
    if (!entry.pending.has(id)) return { kind: "pending", stillPending: false };

    const value = await new Promise<WaiterValue>((resolve) => {
      const pending = entry.pending.get(id);
      if (!pending) {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => {
        pending.waiter = undefined;
        resolve(null);
      }, waitMs);
      pending.waiter = (next) => {
        clearTimeout(timer);
        resolve(next);
      };
    });

    if (value && "envelope" in value) return { kind: "envelope", envelope: value.envelope };
    if (value && "error" in value) return { kind: "error", message: value.error };
    return { kind: "pending", stillPending: entry.pending.has(id) };
  }

  /** Upgrade pre-check. Does not attach the socket. */
  precheck(sessionId: string, token: string): AttachResult {
    const entry = this.entries.get(sessionId);
    if (!entry) return "not_found";
    if (Date.now() > entry.expiresAt) return "expired";
    if (!token || !constantTimeEqual(sha256Hex(token), entry.tokenHash)) return "bad_token";
    if (entry.ws) return "connected";
    return "ok";
  }

  attach(sessionId: string, ws: WebSocket): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.ws) return false;
    entry.ws = ws;
    entry.connectedAt = Date.now();
    return true;
  }

  hello(sessionId: string, evidence: AttestationEnvelope): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry || evidence.sessionId !== sessionId) return false;
    entry.hello = evidence;
    entry.helloAt = Date.now();
    if (!sessionId.startsWith("warm_")) this.opts.onHello?.(sessionId);
    return true;
  }

  response(sessionId: string, id: string, envelope: string): "ok" | "duplicate" | "unknown" {
    const entry = this.entries.get(sessionId);
    if (!entry) return "unknown";
    if (entry.responses.has(id) || entry.errors.has(id)) return "duplicate";
    entry.responses.set(id, { envelope, at: Date.now() });
    this.prune(entry);
    entry.lastError = null;
    const pending = entry.pending.get(id);
    entry.pending.delete(id);
    pending?.waiter?.({ envelope });
    return "ok";
  }

  error(sessionId: string, id: string, code: string, message: string): "ok" | "duplicate" | "unknown" {
    const entry = this.entries.get(sessionId);
    if (!entry) return "unknown";
    if (id && (entry.responses.has(id) || entry.errors.has(id))) return "duplicate";
    entry.lastError = { code, message };
    if (!id) return "ok";
    entry.errors.set(id, { message, at: Date.now() });
    this.prune(entry);
    const pending = entry.pending.get(id);
    entry.pending.delete(id);
    pending?.waiter?.({ error: message });
    return "ok";
  }

  detach(sessionId: string, ws: WebSocket): void {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.ws !== ws) return;
    entry.ws = null;
    for (const pending of entry.pending.values()) pending.waiter?.({ error: "guest disconnected" });
    entry.pending.clear();
  }

  remove(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    try {
      entry.ws?.close(1000, "session destroyed");
    } catch {
      /* ignore */
    }
    for (const pending of entry.pending.values()) pending.waiter?.({ error: "session destroyed" });
    entry.pending.clear();
    this.entries.delete(sessionId);
    return true;
  }

  closeAll(code: number, reason: string): void {
    for (const entry of this.entries.values()) {
      try {
        entry.ws?.close(code, reason);
      } catch {
        /* ignore */
      }
    }
  }

  private prune(entry: Entry): void {
    const now = Date.now();
    for (const [id, value] of entry.responses) {
      if (now - value.at > this.opts.responseTtlMs) entry.responses.delete(id);
    }
    for (const [id, value] of entry.errors) {
      if (now - value.at > this.opts.responseTtlMs) entry.errors.delete(id);
    }
    while (entry.responses.size > MAX_CACHED_RESPONSES) {
      const oldest = entry.responses.keys().next().value;
      if (oldest === undefined) break;
      entry.responses.delete(oldest);
    }
    while (entry.errors.size > MAX_CACHED_RESPONSES) {
      const oldest = entry.errors.keys().next().value;
      if (oldest === undefined) break;
      entry.errors.delete(oldest);
    }
  }
}
