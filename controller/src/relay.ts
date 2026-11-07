/**
 * Session relay.
 *
 * A dumb, encrypted RPC switch between one customer and one guest:
 *   - accepts guest-initiated WebSocket connections only (sandbox pods need no
 *     inbound networking at all),
 *   - never parses or decrypts `envelope` contents,
 *   - correlates opaque request/response envelopes by id, with a bounded cache,
 *   - forwards cancellation and shutdown notices,
 *   - binds exactly one live connection per session.
 *
 * It is reachable from sandbox pods on one port; its admin surface is
 * restricted to the controller by NetworkPolicy + shared token.
 */
import http from "node:http";
import express, { type Request, type Response, type NextFunction } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  AttestationEnvelope,
  GuestToRelay,
  RelayCancelMessage,
  RelayRequestMessage,
  RelaySessionState,
  RelayShutdownMessage,
} from "@x402s/shared";
import { metrics } from "@x402s/shared";
import { log } from "./log.js";
import { constantTimeEqual, sha256Hex } from "./tokens.js";

/** A single frame cap. Sealed file payloads are base64-in-JSON. */
const MAX_FRAME_BYTES = 24 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 15_000;
const MAX_PENDING = 8;
const MAX_CACHED_RESPONSES = 64;
const RESPONSE_TTL_MS = 5 * 60_000;

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
  pending: Map<string, { at: number; waiter?: (v: { envelope: string } | { error: string } | null) => void }>;
  responses: Map<string, CachedResponse>;
  errors: Map<string, CachedError>;
  lastError: { code: string; message: string } | null;
}

export interface RelayServer {
  app: express.Express;
  server: http.Server;
  close(): Promise<void>;
  /** Test helper: inspect registry size. */
  size(): number;
}

export interface RelayOptions {
  adminToken: string;
  maxSessions?: number;
  responseTtlMs?: number;
  /** When set, a guest hello nudges the controller's reconciler. */
  controllerUrl?: string;
  wakeToken?: string;
}

export function createRelay(opts: RelayOptions): RelayServer {
  const entries = new Map<string, Entry>();
  const maxSessions = opts.maxSessions ?? 2000;
  const responseTtlMs = opts.responseTtlMs ?? RESPONSE_TTL_MS;

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32mb" }));

  const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    const token = req.header("x-internal-token") ?? "";
    if (!opts.adminToken || !constantTimeEqual(token, opts.adminToken)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  const getEntry = (id: string): Entry | undefined => entries.get(id);

  const pruneResponses = (entry: Entry): void => {
    const now = Date.now();
    for (const [id, value] of entry.responses) {
      if (now - value.at > responseTtlMs) entry.responses.delete(id);
    }
    for (const [id, value] of entry.errors) {
      if (now - value.at > responseTtlMs) entry.errors.delete(id);
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
  };

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, sessions: entries.size });
  });

  app.get("/metrics", (_req, res) => {
    const sessions = metrics.gauge("sandbox_relay_sessions", "Registered relay sessions");
    const pending = metrics.gauge("sandbox_relay_pending_requests", "Requests awaiting a guest response");
    let pendingTotal = 0;
    for (const entry of entries.values()) pendingTotal += entry.pending.size;
    sessions.set({}, entries.size);
    pending.set({}, pendingTotal);
    res.setHeader("content-type", "text/plain; version=0.0.4");
    res.send(metrics.render());
  });

  app.post("/internal/register", requireAdmin, (req, res) => {
    const { sessionId, tokenHash, ttlMs } = req.body ?? {};
    if (typeof sessionId !== "string" || typeof tokenHash !== "string") {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    if (entries.size >= maxSessions && !entries.has(sessionId)) {
      res.status(503).json({ error: "relay_at_capacity" });
      return;
    }
    const existing = getEntry(sessionId);
    if (existing?.ws) {
      res.status(409).json({ error: "session_already_connected" });
      return;
    }
    entries.set(sessionId, {
      sessionId,
      tokenHash,
      expiresAt: Date.now() + (Number(ttlMs) || 3_600_000),
      ws: null,
      connectedAt: null,
      hello: null,
      helloAt: existing?.helloAt ?? null,
      pending: existing?.pending ?? new Map(),
      responses: existing?.responses ?? new Map(),
      errors: existing?.errors ?? new Map(),
      lastError: null,
    });
    res.status(201).json({ ok: true });
  });

  app.get("/internal/:sessionId/state", requireAdmin, (req, res) => {
    const entry = getEntry(String(req.params.sessionId ?? ""));
    if (!entry) {
      res.json({ registered: false, connected: false, pending: 0 } satisfies RelaySessionState);
      return;
    }
    const state: RelaySessionState = {
      registered: true,
      connected: Boolean(entry.ws && entry.ws.readyState === 1),
      pending: entry.pending.size,
      ...(entry.hello ? { attestation: entry.hello } : {}),
      ...(entry.helloAt ? { helloAt: entry.helloAt } : {}),
      ...(entry.lastError ? { error: entry.lastError.message } : {}),
    };
    res.json(state);
  });

  app.post("/internal/:sessionId/request", requireAdmin, (req: Request, res: Response) => {
    const entry = getEntry(String(req.params.sessionId ?? ""));
    if (!entry) {
      res.status(404).json({ error: "session_not_registered" });
      return;
    }
    const { id, envelope, deadlineMs } = req.body ?? {};
    if (typeof id !== "string" || id.length < 8 || id.length > 128) {
      res.status(400).json({ error: "invalid_request_id" });
      return;
    }
    if (typeof envelope !== "string" || envelope.length === 0 || envelope.length > MAX_FRAME_BYTES) {
      res.status(400).json({ error: "invalid_envelope" });
      return;
    }
    if (entry.responses.has(id) || entry.errors.has(id)) {
      // The outcome is already cached. A retried request must not re-execute
      // the operation; the controller can read the cached result or error.
      res.status(202).json({ ok: true, cached: true });
      return;
    }
    if (entry.pending.has(id)) {
      // Idempotent retry of an in-flight request.
      res.status(202).json({ ok: true, pending: true });
      return;
    }
    if (entry.pending.size >= MAX_PENDING) {
      res.status(429).json({ error: "too_many_pending_requests" });
      return;
    }
    if (!entry.ws || entry.ws.readyState !== 1) {
      res.status(409).json({ error: "guest_not_connected" });
      return;
    }
    const msg: RelayRequestMessage = {
      type: "request",
      id,
      envelope,
      deadlineMs: Number(deadlineMs) || Date.now() + 60_000,
    };
    entry.pending.set(id, { at: Date.now() });
    entry.ws.send(JSON.stringify(msg));
    log.info("relay_request_forwarded", {
      sessionId: entry.sessionId,
      requestId: id,
      envelopeBytes: envelope.length,
    });
    res.status(202).json({ ok: true });
  });

  app.post("/internal/:sessionId/cancel", requireAdmin, (req: Request, res: Response) => {
    const entry = getEntry(String(req.params.sessionId ?? ""));
    if (!entry) {
      res.status(404).json({ error: "session_not_registered" });
      return;
    }
    const { id } = req.body ?? {};
    if (typeof id !== "string") {
      res.status(400).json({ error: "invalid_request_id" });
      return;
    }
    if (!entry.ws || entry.ws.readyState !== 1) {
      res.status(409).json({ error: "guest_not_connected" });
      return;
    }
    const msg: RelayCancelMessage = { type: "cancel", id };
    entry.ws.send(JSON.stringify(msg));
    log.info("relay_cancel_forwarded", { sessionId: entry.sessionId, requestId: id });
    res.status(202).json({ ok: true });
  });

  app.post("/internal/:sessionId/shutdown", requireAdmin, (req: Request, res: Response) => {
    const entry = getEntry(String(req.params.sessionId ?? ""));
    if (!entry) {
      res.status(404).json({ error: "session_not_registered" });
      return;
    }
    const msg: RelayShutdownMessage = { type: "shutdown", reason: String(req.body?.reason ?? "lease ended") };
    try {
      if (entry.ws && entry.ws.readyState === 1) entry.ws.send(JSON.stringify(msg));
    } catch {
      /* the pod is going away anyway */
    }
    log.info("relay_shutdown_forwarded", { sessionId: entry.sessionId });
    res.status(202).json({ ok: true });
  });

  /**
   * Hand a warm guest its session identity. The payload is forwarded verbatim;
   * the relay never interprets customer keys or tokens. Ordering matters: the
   * controller registers the real session entry before calling this, so the
   * guest can reconnect immediately after it closes the pooled connection.
   */
  app.post("/internal/:sessionId/claim", requireAdmin, (req: Request, res: Response) => {
    const entry = getEntry(String(req.params.sessionId ?? ""));
    if (!entry || !entry.ws || entry.ws.readyState !== 1) {
      res.status(409).json({ error: "guest_not_connected" });
      return;
    }
    const claim = req.body?.claim;
    if (!claim || typeof claim !== "object" || typeof (claim as { sessionId?: unknown }).sessionId !== "string") {
      res.status(400).json({ error: "invalid_claim" });
      return;
    }
    try {
      entry.ws.send(JSON.stringify({ type: "claim", claim }));
    } catch {
      res.status(409).json({ error: "guest_disconnected" });
      return;
    }
    log.info("relay_claim_forwarded", {
      poolSessionId: entry.sessionId,
      sessionId: (claim as { sessionId: string }).sessionId,
    });
    res.status(202).json({ ok: true });
  });

  app.get("/internal/:sessionId/response/:requestId", requireAdmin, async (req: Request, res: Response) => {
    const entry = getEntry(String(req.params.sessionId ?? ""));
    if (!entry) {
      res.status(404).json({ error: "session_not_registered" });
      return;
    }
    const id = String(req.params.requestId ?? "");
    pruneResponses(entry);
    const cachedError = entry.errors.get(id);
    if (cachedError) {
      res.status(409).json({ error: "guest_error", message: cachedError.message });
      return;
    }
    const cached = entry.responses.get(id);
    if (cached) {
      res.json({ envelope: cached.envelope });
      return;
    }
    if (!entry.pending.has(id)) {
      res.status(202).json({ pending: false });
      return;
    }
    const timeoutMs = Math.min(120_000, Number(req.query.waitMs) || 20_000);
    const value = await new Promise<{ envelope: string } | { error: string } | null>((resolve) => {
      const pending = entry.pending.get(id);
      if (!pending) {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => {
        pending.waiter = undefined;
        resolve(null);
      }, timeoutMs);
      pending.waiter = (v) => {
        clearTimeout(timer);
        resolve(v);
      };
    });
    if (value && "envelope" in value) {
      res.json({ envelope: value.envelope });
      return;
    }
    if (value && "error" in value) {
      res.status(409).json({ error: "guest_error", message: value.error });
      return;
    }
    res.status(202).json({ pending: entry.pending.has(id) });
  });

  app.delete("/internal/:sessionId", requireAdmin, (req, res) => {
    const entry = getEntry(String(req.params.sessionId ?? ""));
    if (!entry) {
      res.status(404).json({ error: "session_not_registered" });
      return;
    }
    try {
      entry.ws?.close(1000, "session destroyed");
    } catch {
      /* ignore */
    }
    for (const pending of entry.pending.values()) pending.waiter?.({ error: "session destroyed" });
    entry.pending.clear();
    entries.delete(entry.sessionId);
    log.info("relay_session_purged", { sessionId: entry.sessionId });
    res.json({ ok: true });
  });

  server.on("upgrade", (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://relay.local");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/guest") {
      socket.destroy();
      return;
    }
    const sessionId = url.searchParams.get("session") ?? "";
    const token = url.searchParams.get("token") ?? "";
    const entry = getEntry(sessionId);
    if (!entry || Date.now() > entry.expiresAt) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!token || !constantTimeEqual(sha256Hex(token), entry.tokenHash)) {
      log.warn("relay_bad_guest_token", { sessionId });
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    if (entry.ws) {
      log.warn("relay_duplicate_guest_connection", { sessionId });
      socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleGuestConnection(entry, ws);
    });
  });

  /**
   * Event-driven readiness: a hello means the session may now be READY, so
   * stop waiting for the next 250 ms reconcile tick. Fire-and-forget; a lost
   * wake only costs one tick.
   */
  function wakeController(): void {
    if (!opts.controllerUrl || !opts.wakeToken) return;
    void fetch(`${opts.controllerUrl.replace(/\/$/, "")}/internal/wake`, {
      method: "POST",
      headers: { "x-wake-token": opts.wakeToken },
      signal: AbortSignal.timeout(1_000),
    }).catch(() => undefined);
  }

  function resolvePending(entry: Entry, id: string, value: { envelope: string }): void {
    const pending = entry.pending.get(id);
    entry.pending.delete(id);
    if (pending?.waiter) pending.waiter(value);
  }

  function handleGuestConnection(entry: Entry, ws: WebSocket): void {
    entry.ws = ws;
    entry.connectedAt = Date.now();
    log.info("relay_guest_connected", { sessionId: entry.sessionId });

    const helloTimer = setTimeout(() => {
      if (!entry.hello) {
        log.warn("relay_hello_timeout", { sessionId: entry.sessionId });
        ws.close(1008, "hello timeout");
      }
    }, HELLO_TIMEOUT_MS);

    const ping = setInterval(() => {
      if (ws.readyState === 1) ws.ping();
    }, 15_000);

    ws.on("message", (data, isBinary) => {
      if (isBinary || (data as Buffer).length > MAX_FRAME_BYTES) {
        ws.close(1009, "unsupported frame");
        return;
      }
      let msg: GuestToRelay;
      try {
        msg = JSON.parse(data.toString()) as GuestToRelay;
      } catch {
        ws.close(1003, "invalid json");
        return;
      }
      if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") {
        ws.close(1003, "invalid message");
        return;
      }
      switch (msg.type) {
        case "hello": {
          const evidence = msg.evidence as AttestationEnvelope;
          if (!evidence || typeof evidence !== "object" || evidence.sessionId !== entry.sessionId) {
            log.warn("relay_hello_binding_mismatch", { sessionId: entry.sessionId });
            ws.close(1008, "bad hello");
            return;
          }
          entry.hello = evidence;
          entry.helloAt = Date.now();
          clearTimeout(helloTimer);
          // Pool hellos are not customer readiness; don't wake for them.
          if (!entry.sessionId.startsWith("warm_")) wakeController();
          log.info("relay_guest_ready", {
            sessionId: entry.sessionId,
            evidenceType: evidence.evidenceType,
            insecureDevOnly: evidence.insecureDevOnly,
          });
          break;
        }
        case "response": {
          if (typeof msg.id !== "string" || typeof msg.envelope !== "string" || msg.envelope.length > MAX_FRAME_BYTES) {
            ws.close(1009, "bad response");
            return;
          }
          if (entry.responses.has(msg.id) || entry.errors.has(msg.id)) {
            // First outcome wins. A delayed duplicate must never replace a
            // result or error the controller may already have handed to the
            // client.
            log.warn("relay_duplicate_response", { sessionId: entry.sessionId, requestId: msg.id });
            break;
          }
          entry.responses.set(msg.id, { envelope: msg.envelope, at: Date.now() });
          pruneResponses(entry);
          entry.lastError = null;
          resolvePending(entry, msg.id, { envelope: msg.envelope });
          log.info("relay_response_received", {
            sessionId: entry.sessionId,
            requestId: msg.id,
            envelopeBytes: msg.envelope.length,
          });
          break;
        }
        case "error": {
          const message = String(msg.message ?? msg.code ?? "guest_error");
          if (typeof msg.id === "string" && (entry.responses.has(msg.id) || entry.errors.has(msg.id))) {
            log.warn("relay_duplicate_error", { sessionId: entry.sessionId, requestId: msg.id });
            break;
          }
          entry.lastError = { code: String(msg.code ?? "guest_error"), message: String(msg.message ?? "") };
          log.warn("relay_guest_error", {
            sessionId: entry.sessionId,
            errorCode: entry.lastError.code,
            requestId: msg.id,
          });
          if (typeof msg.id === "string") {
            entry.errors.set(msg.id, { message, at: Date.now() });
            pruneResponses(entry);
            const pending = entry.pending.get(msg.id);
            entry.pending.delete(msg.id);
            pending?.waiter?.({ error: message });
          }
          break;
        }
        default:
          ws.close(1003, "unknown message type");
      }
    });

    ws.on("close", () => {
      clearInterval(ping);
      clearTimeout(helloTimer);
      if (entry.ws === ws) entry.ws = null;
      for (const pending of entry.pending.values()) {
        pending.waiter?.({ error: "guest disconnected" });
      }
      entry.pending.clear();
      log.info("relay_guest_disconnected", { sessionId: entry.sessionId });
    });
    ws.on("error", () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }

  return {
    app,
    server,
    size: () => entries.size,
    close: async () => {
      for (const entry of entries.values()) {
        try {
          entry.ws?.close(1001, "relay shutting down");
        } catch {
          /* ignore */
        }
      }
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
