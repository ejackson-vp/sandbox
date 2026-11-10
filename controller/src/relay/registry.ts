import type { WebSocket } from "ws";
import type { AttestationEnvelope, RelaySessionState } from "@x402s/shared";
import { metrics, type MetricsRegistry } from "@x402s/shared";
import { constantTimeEqual, guestTokenShard, sha256Hex } from "../tokens.js";
import { registerRelayMetrics, type RelayDisconnectReason } from "./metrics.js";

export const MAX_FRAME_BYTES = 24 * 1024 * 1024;
export const MAX_PENDING = 8;
const MAX_CACHED_RESPONSES = 64;

export type WaiterValue = { envelope: string } | { error: string } | null;

interface Pending {
  at: number;
  /** Execution epoch the frame was forwarded under, for withdrawal. */
  epoch: number;
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
  /**
   * The TCP socket behind `ws`. Kept so recovery can reset the connection
   * (discarding unread frames) rather than closing it gracefully.
   */
  socket: { resetAndDestroy?: () => void } | null;
  connectedAt: number | null;
  hello: AttestationEnvelope | null;
  helloAt: number | null;
  /** Frame protocol the guest reported; null when it predates versioning. */
  protocolVersion: number | null;
  /** Operation verbs the guest reported on hello; null when it sent none. */
  capabilities: readonly string[] | null;
  pending: Map<string, Pending>;
  responses: Map<string, CachedResponse>;
  errors: Map<string, CachedError>;
  lastError: { code: string; message: string } | null;
  /** Guest-reported operation state; null until the guest sends a status frame. */
  activeRequestId: string | null;
  execEpoch: number | null;
  statusAt: number | null;
  /**
   * Lowest execution epoch the relay may forward. The controller raises it to
   * the session's `exec_epoch` on recovery, so a frame from an older controller
   * generation is refused here before it can reach the guest.
   */
  epochFloor: number;
}

export interface RelayRegistryOptions {
  maxSessions: number;
  responseTtlMs: number;
  /**
   * Ordinal of this relay replica. When set, a guest token whose shard claim is
   * missing or different is refused: the registry is in memory, so a guest that
   * dials the wrong replica registers where the controller will never look for
   * it. Unset (the single-replica default) accepts any shard.
   */
  shardIndex?: number;
  /**
   * Number of relay replicas. Enforcement is skipped at one replica because the
   * controller mints a claim-free token there; see `precheck`.
   */
  replicas?: number;
  /** Called for a non-pool guest hello; the composition root wakes the controller. */
  onHello?: (sessionId: string) => void;
  /** Injectable for tests; defaults to the process-wide registry. */
  metricsRegistry?: MetricsRegistry;
}

export type RegisterResult = "ok" | "already_connected" | "at_capacity";
export type RequestResult =
  | "sent"
  | "cached"
  | "pending"
  | "too_many"
  | "not_connected"
  | "not_registered"
  | "stale_epoch";
export type EpochResult = "ok" | "unknown";

export interface RaiseEpochResult {
  result: EpochResult;
  /** Pending frames dropped from the superseded generation. */
  withdrawn: number;
  /** Whether the guest link was reset to discard an unread frame. */
  reset: boolean;
}
export type SendResult = "sent" | "not_registered" | "not_connected";
export type AttachResult = "ok" | "not_found" | "expired" | "bad_token" | "wrong_shard" | "connected";

export type WaitResult =
  | { kind: "envelope"; envelope: string }
  | { kind: "error"; message: string }
  | { kind: "pending"; stillPending: boolean }
  | { kind: "not_registered" };

export class RelayRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly metrics: MetricsRegistry;

  constructor(private readonly opts: RelayRegistryOptions) {
    this.metrics = opts.metricsRegistry ?? metrics;
    registerRelayMetrics(this.metrics);
  }

  size(): number {
    return this.entries.size;
  }

  pendingTotal(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.pending.size;
    return total;
  }

  /** Operations the guests themselves have reported as running. */
  activeTotal(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      if (entry.activeRequestId !== null) total += 1;
    }
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
      socket: null,
      connectedAt: null,
      hello: null,
      helloAt: existing?.helloAt ?? null,
      protocolVersion: null,
      capabilities: null,
      pending: existing?.pending ?? new Map(),
      responses: existing?.responses ?? new Map(),
      errors: existing?.errors ?? new Map(),
      lastError: null,
      // A fresh registration is a fresh guest process. Do not inherit an
      // execution state: fail closed until the guest reports one.
      activeRequestId: null,
      execEpoch: null,
      statusAt: null,
      // The epoch is a property of the session, not of one guest process, so a
      // registration keeps a floor that recovery already raised.
      epochFloor: existing?.epochFloor ?? 0,
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
      ...(entry.protocolVersion !== null ? { protocolVersion: entry.protocolVersion } : {}),
      ...(entry.capabilities !== null ? { capabilities: entry.capabilities } : {}),
      ...(entry.statusAt !== null
        ? {
            activeRequestId: entry.activeRequestId ?? "",
            execEpoch: entry.execEpoch ?? 0,
            statusAt: entry.statusAt,
          }
        : {}),
      ...(entry.lastError ? { error: entry.lastError.message } : {}),
      epochFloor: entry.epochFloor,
    };
  }

  request(sessionId: string, id: string, envelope: string, deadlineMs?: number, epoch = 0): RequestResult {
    const entry = this.entries.get(sessionId);
    if (!entry) return "not_registered";
    const requestedEpoch = Number(epoch) || 0;
    // A frame below the floor belongs to a controller generation that recovery
    // has already superseded. Epoch 0 is only admissible while no floor has
    // been raised (the relay's floor starts at 0).
    if (requestedEpoch < entry.epochFloor) return "stale_epoch";
    if (entry.responses.has(id) || entry.errors.has(id)) return "cached";
    if (entry.pending.has(id)) return "pending";
    if (entry.pending.size >= MAX_PENDING) return "too_many";
    if (!entry.ws || entry.ws.readyState !== 1) return "not_connected";
    entry.pending.set(id, { at: Date.now(), epoch: requestedEpoch });
    entry.ws.send(
      JSON.stringify({
        type: "request",
        id,
        envelope,
        deadlineMs: Number(deadlineMs) || Date.now() + 60_000,
        epoch: requestedEpoch,
      }),
    );
    return "sent";
  }

  /**
   * Raise the session's execution-epoch floor to at least `epoch`, then
   * withdraw any frame the guest could still start from a superseded
   * generation.
   *
   * A request that is still awaiting a response was forwarded under an older
   * epoch; dropping it from the pending set stops the relay waiting for a
   * frame that must never run. Dropping it does not unsend it, though: the
   * frame may already be queued on the guest's socket. If the guest has not
   * itself reported an epoch at or above the floor and has no command running,
   * the only way to guarantee it never reads that frame is to end the
   * connection. That matches the existing contract: the supervisor exits when
   * its relay link drops, so a command cannot survive the link. A command the
   * guest has already started is observed; the fence waits for it instead.
   */
  raiseEpoch(sessionId: string, epoch: number): RaiseEpochResult {
    const entry = this.entries.get(sessionId);
    if (!entry) return { result: "unknown", withdrawn: 0, reset: false };
    const requested = Math.trunc(Number(epoch));
    if (!Number.isFinite(requested) || requested <= entry.epochFloor) {
      return { result: "ok", withdrawn: 0, reset: false };
    }
    entry.epochFloor = requested;

    let withdrawn = 0;
    for (const [id, pending] of entry.pending) {
      if (pending.epoch < requested) {
        entry.pending.delete(id);
        pending.waiter?.({ error: "request superseded by controller recovery" });
        withdrawn += 1;
      }
    }

    const guestBehind = entry.execEpoch === null || entry.execEpoch < requested;
    let reset = false;
    if (withdrawn > 0) {
      this.metrics
        .counter("sandbox_relay_frames_withdrawn_total", "Frames withdrawn after a recovery epoch increase")
        .inc({ reason: guestBehind ? "guest_reset" : "guest_ahead" }, withdrawn);
    }
    if (withdrawn > 0 && guestBehind && !entry.activeRequestId) {
      reset = this.resetConnection(entry);
    }
    return { result: "ok", withdrawn, reset };
  }

  /**
   * End a guest connection with a TCP reset, not a WebSocket close. A close
   * frame is ordered after every frame already queued on the socket, so the
   * guest would still read them; a reset discards unread bytes. The guest
   * supervisor exits on the read error and reconnects (or the session ends),
   * which is the same path as any other relay link loss.
   */
  private resetConnection(entry: Entry): boolean {
    const ws = entry.ws;
    if (!ws) return false;
    const socket = entry.socket;
    entry.ws = null;
    entry.socket = null;
    for (const pending of entry.pending.values()) pending.waiter?.({ error: "guest disconnected" });
    entry.pending.clear();
    try {
      if (socket && typeof socket.resetAndDestroy === "function") socket.resetAndDestroy();
      else ws.terminate();
      return true;
    } catch {
      /* the pod is going away anyway */
      return false;
    }
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
    // The shard suffix is covered by the hash above, so a value that survives
    // that check is the one the controller minted, not one the guest chose.
    if (
      this.opts.shardIndex !== undefined &&
      (this.opts.replicas ?? 1) > 1 &&
      guestTokenShard(token) !== this.opts.shardIndex
    ) {
      return "wrong_shard";
    }
    if (entry.ws) return "connected";
    return "ok";
  }

  attach(sessionId: string, ws: WebSocket, socket?: { resetAndDestroy?: () => void } | null): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.ws) return false;
    const reconnecting = entry.connectedAt !== null;
    entry.ws = ws;
    entry.socket = socket ?? null;
    entry.connectedAt = Date.now();
    if (reconnecting) {
      this.metrics
        .counter("sandbox_relay_reconnects_total", "Guest reconnections to an existing registration")
        .inc();
    }
    return true;
  }

  hello(
    sessionId: string,
    evidence: AttestationEnvelope,
    meta: { protocolVersion?: number; capabilities?: readonly string[] } = {},
  ): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry || evidence.sessionId !== sessionId) return false;
    entry.hello = evidence;
    entry.helloAt = Date.now();
    // A registration starts from a fresh guest process, so a reconnect that
    // sends no metadata must clear what a previous process reported rather than
    // inherit it.
    entry.protocolVersion = meta.protocolVersion ?? null;
    entry.capabilities = meta.capabilities ?? null;
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
    entry.socket = null;
    for (const pending of entry.pending.values()) pending.waiter?.({ error: "guest disconnected" });
    entry.pending.clear();
  }

  /** Record a guest disconnect with a bounded close-reason label. */
  recordDisconnect(reason: RelayDisconnectReason): void {
    this.metrics
      .counter("sandbox_relay_disconnects_total", "Guest disconnections by close reason")
      .inc({ reason });
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
