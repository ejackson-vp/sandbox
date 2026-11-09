/**
 * Session relay: guest-initiated encrypted RPC between the controller and one
 * sandbox. The registry owns state; HTTP and WebSocket are transports.
 */
import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import { MAX_FRAME_BYTES, RelayRegistry } from "./relay/registry.js";
import { registerRelayRoutes } from "./relay/http.js";
import { attachGuestUpgrade } from "./relay/ws.js";

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
  const registry = new RelayRegistry({
    maxSessions: opts.maxSessions ?? 2000,
    responseTtlMs: opts.responseTtlMs ?? 5 * 60_000,
    onHello: () => wakeController(opts),
  });

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32mb" }));
  registerRelayRoutes(app, registry, { adminToken: opts.adminToken });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  attachGuestUpgrade(server, wss, registry);

  return {
    app,
    server,
    size: () => registry.size(),
    close: async () => {
      registry.closeAll(1001, "relay shutting down");
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Event-driven readiness: a hello means the session may now be READY, so stop
 * waiting for the next 250 ms reconcile tick. Fire-and-forget; a lost wake only
 * costs one tick.
 */
function wakeController(opts: RelayOptions): void {
  if (!opts.controllerUrl || !opts.wakeToken) return;
  void fetch(`${opts.controllerUrl.replace(/\/$/, "")}/internal/wake`, {
    method: "POST",
    headers: { "x-wake-token": opts.wakeToken },
    signal: AbortSignal.timeout(1_000),
  }).catch(() => undefined);
}
