/**
 * Session relay.
 *
 * The relay is a dumb, encrypted-blob message switch between one customer and
 * one guest. It:
 *   - accepts guest-initiated WebSocket connections only (so sandbox pods need
 *     no inbound networking at all),
 *   - never parses or decrypts `envelope` contents,
 *   - cannot proxy arbitrary traffic: the only frames it understands are
 *     hello / result / error, and it only forwards opaque envelopes,
 *   - binds exactly one live connection per session and refuses a second.
 *
 * It is reachable from sandbox pods on one port, and its admin surface is
 * restricted to the controller by NetworkPolicy + shared token.
 */
import http from "node:http";
import express, { type Request, type Response, type NextFunction } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import type { AttestationEnvelope, GuestToRelay, RelayExecuteMessage, RelaySessionState } from "@x402s/shared";
import { log } from "./log.js";
import { constantTimeEqual, sha256Hex } from "./tokens.js";

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 15_000;

interface Entry {
  sessionId: string;
  tokenHash: string;
  expiresAt: number;
  ws: WebSocket | null;
  connectedAt: number | null;
  hello: AttestationEnvelope | null;
  result: string | null;
  error: { code: string; message: string } | null;
  resultWaiters: Array<(value: { envelope: string } | null) => void>;
  deliveredAt: number | null;
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
  /** How long to keep a completed result for the client to fetch. */
  resultTtlMs?: number;
  maxSessions?: number;
}

export function createRelay(opts: RelayOptions): RelayServer {
  const entries = new Map<string, Entry>();
  const resultTtlMs = opts.resultTtlMs ?? 120_000;
  const maxSessions = opts.maxSessions ?? 2000;

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "3mb" }));

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

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, sessions: entries.size });
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
      expiresAt: Date.now() + (Number(ttlMs) || 900_000),
      ws: null,
      connectedAt: null,
      hello: null,
      result: null,
      error: null,
      resultWaiters: existing?.resultWaiters ?? [],
      deliveredAt: null,
    });
    res.status(201).json({ ok: true });
  });

  app.get("/internal/:sessionId/state", requireAdmin, (req, res) => {
    const entry = getEntry(String(req.params.sessionId ?? ""));
    if (!entry) {
      res.json({ registered: false, connected: false, resultAvailable: false } satisfies RelaySessionState);
      return;
    }
    const state: RelaySessionState = {
      registered: true,
      connected: Boolean(entry.ws && entry.ws.readyState === 1),
      resultAvailable: entry.result !== null,
      ...(entry.hello ? { attestation: entry.hello } : {}),
      ...(entry.error ? { error: entry.error.message } : {}),
    };
    res.json(state);
  });

  app.post("/internal/:sessionId/deliver", requireAdmin, (req: Request, res: Response) => {
    const entry = getEntry(String(req.params.sessionId ?? ""));
    if (!entry) {
      res.status(404).json({ error: "session_not_registered" });
      return;
    }
    const { envelope, deadlineMs } = req.body ?? {};
    if (typeof envelope !== "string" || envelope.length === 0 || envelope.length > MAX_FRAME_BYTES) {
      res.status(400).json({ error: "invalid_envelope" });
      return;
    }
    if (!entry.ws || entry.ws.readyState !== 1) {
      res.status(409).json({ error: "guest_not_connected" });
      return;
    }
    if (entry.deliveredAt) {
      res.status(409).json({ error: "already_delivered" });
      return;
    }
    const msg: RelayExecuteMessage = {
      type: "execute",
      envelope,
      deadlineMs: Number(deadlineMs) || Date.now(),
    };
    entry.ws.send(JSON.stringify(msg));
    entry.deliveredAt = Date.now();
    log.info("relay_delivered", { sessionId: entry.sessionId, envelopeBytes: envelope.length });
    res.status(202).json({ ok: true });
  });

  app.get("/internal/:sessionId/result", requireAdmin, async (req: Request, res: Response) => {
    const entry = getEntry(String(req.params.sessionId ?? ""));
    if (!entry) {
      res.status(404).json({ error: "session_not_registered" });
      return;
    }
    if (entry.result) {
      res.json({ envelope: entry.result });
      return;
    }
    if (entry.error) {
      res.status(200).json({ envelope: null, error: entry.error });
      return;
    }
    if (!entry.ws && !entry.deliveredAt) {
      res.status(200).json({ envelope: null });
      return;
    }

    const timeoutMs = Math.min(20_000, Number(req.query.waitMs) || 20_000);
    const value = await new Promise<{ envelope: string } | null>((resolve) => {
      const timer = setTimeout(() => {
        entry.resultWaiters = entry.resultWaiters.filter((w) => w !== waiter);
        resolve(null);
      }, timeoutMs);
      const waiter = (v: { envelope: string } | null) => {
        clearTimeout(timer);
        resolve(v);
      };
      entry.resultWaiters.push(waiter);
    });
    res.json({ envelope: value?.envelope ?? null });
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
    for (const waiter of entry.resultWaiters) waiter(null);
    entry.resultWaiters = [];
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
          clearTimeout(helloTimer);
          log.info("relay_guest_ready", {
            sessionId: entry.sessionId,
            evidenceType: evidence.evidenceType,
            insecureDevOnly: evidence.insecureDevOnly,
          });
          break;
        }
        case "result": {
          if (typeof msg.envelope !== "string" || msg.envelope.length > MAX_FRAME_BYTES) {
            ws.close(1009, "bad result");
            return;
          }
          entry.result = msg.envelope;
          entry.error = null;
          log.info("relay_result_received", { sessionId: entry.sessionId, envelopeBytes: msg.envelope.length });
          const waiters = entry.resultWaiters;
          entry.resultWaiters = [];
          for (const w of waiters) w({ envelope: msg.envelope });
          // Results are encrypted to the customer key; drop them after TTL.
          setTimeout(() => {
            const current = getEntry(entry.sessionId);
            if (current && current.result === msg.envelope) {
              current.result = null;
              log.info("relay_result_expired", { sessionId: entry.sessionId });
            }
          }, resultTtlMs).unref();
          break;
        }
        case "error": {
          entry.error = { code: String(msg.code ?? "guest_error"), message: String(msg.message ?? "") };
          log.warn("relay_guest_error", { sessionId: entry.sessionId, errorCode: entry.error.code });
          const waiters = entry.resultWaiters;
          entry.resultWaiters = [];
          for (const w of waiters) w(null);
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
