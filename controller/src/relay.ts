/**
 * Session relay: guest-initiated encrypted RPC between the controller and one
 * sandbox. The registry owns state; HTTP and WebSocket are transports.
 *
 * Two listeners:
 *   - the guest listener (plaintext HTTP/WebSocket) carries /healthz, /readyz
 *     and the bearer-token WebSocket upgrade;
 *   - the control listener (mTLS, client CA + CN=controller) carries every
 *     /internal/* route the controller uses to register, poll and purge.
 * The control routes are never mounted on the guest listener when TLS is
 * configured, so plaintext and wrong-CN callers cannot reach them.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import express from "express";
import { WebSocketServer } from "ws";
import {
  httpMetricsMiddleware,
  log,
  metrics,
  recordAuthFailure,
  registerRequestMetrics,
  type MetricsRegistry,
  type TokenBucket,
} from "@x402s/shared";
import { MAX_FRAME_BYTES, RelayRegistry } from "./relay/registry.js";
import { registerRelayControlRoutes, registerRelayProbeRoutes } from "./relay/http.js";
import { attachGuestUpgrade } from "./relay/ws.js";
import { collectRelayMetrics } from "./relay/metrics.js";
import { constantTimeEqual } from "./tokens.js";

export interface RelayTlsOptions {
  certFile: string;
  keyFile: string;
  caFile: string;
}

export interface RelayServer {
  app: express.Express;
  server: http.Server;
  /**
   * mTLS listener for /internal/*. Present only when `controlTls` is set; the
   * composition root listens on `relayControlPort`.
   */
  controlServer?: https.Server;
  close(): Promise<void>;
  /**
   * Per-process identity. The registry is in memory, so a registration is only
   * valid for the generation that accepted it. The controller compares this
   * value before and after registering to refuse a registration that landed on
   * a relay that is being replaced.
   */
  generation: string;
  /** Test helper: inspect registry size. */
  size(): number;
  /** Refresh scrape-time gauges (registry size, pending requests). */
  collectMetrics(): void;
}

export interface RelayOptions {
  adminToken: string;
  maxSessions?: number;
  responseTtlMs?: number;
  /** When set, a guest hello nudges the controller's reconciler. */
  controllerUrl?: string;
  wakeToken?: string;
  /**
   * Server certificate, key and client CA for the control listener. When set,
   * /internal/* exists only on that TLS listener and the authenticated socket
   * must present a client certificate with `controlClientCn` (checked at
   * `secureConnection`, before Express).
   *
   * When unset the control routes stay on the plaintext guest listener with the
   * relay admin token. That is a local-dev/test fallback only; the controller
   * refuses to start a cluster relay without TLS material.
   */
  controlTls?: RelayTlsOptions;
  /** Expected client certificate CN on the control listener. */
  controlClientCn?: string;
  /** Injectable for tests; defaults to the process-wide registry. */
  metricsRegistry?: MetricsRegistry;
  /** Injectable for tests; production uses the bounded internal bucket. */
  internalRateLimiter?: TokenBucket;
}

function isControlRequest(req: http.IncomingMessage): boolean {
  const raw = (req.url ?? "/").split("?")[0] ?? "/";
  let pathname = raw;
  try {
    pathname = decodeURIComponent(raw);
  } catch {
    /* keep the raw path; an invalid escape is not a control route */
  }
  return pathname === "/internal" || pathname.startsWith("/internal/");
}

function hasRelayAdminToken(req: http.IncomingMessage, adminToken: string): boolean {
  const header = req.headers["x-internal-token"];
  const supplied = Array.isArray(header) ? (header[0] ?? "") : (header ?? "");
  return Boolean(adminToken) && constantTimeEqual(supplied, adminToken);
}

export function createRelay(opts: RelayOptions): RelayServer {
  const generation = randomUUID();
  const metricsRegistry = opts.metricsRegistry ?? metrics;
  registerRequestMetrics(metricsRegistry);
  const registry = new RelayRegistry({
    maxSessions: opts.maxSessions ?? 2000,
    responseTtlMs: opts.responseTtlMs ?? 5 * 60_000,
    onHello: () => wakeController(opts),
    metricsRegistry,
  });

  const app = express();
  app.disable("x-powered-by");
  app.use(httpMetricsMiddleware(metricsRegistry));
  registerRelayProbeRoutes(app, { generation, registry });

  const controlOptions = {
    generation,
    metricsRegistry,
    ...(opts.internalRateLimiter ? { internalRateLimiter: opts.internalRateLimiter } : {}),
  };

  let controlServer: https.Server | undefined;
  if (opts.controlTls) {
    const controlApp = express();
    controlApp.disable("x-powered-by");
    controlApp.use(httpMetricsMiddleware(metricsRegistry));
    controlApp.use(express.json({ limit: "32mb" }));
    // The controller probes /healthz before and after registering to fence a
    // terminating relay, so the probe endpoint must exist on the control
    // listener too. Its body is the same bounded, non-secret generation id.
    registerRelayProbeRoutes(controlApp, { generation, registry });
    registerRelayControlRoutes(controlApp, registry, controlOptions);
    // requestCert + rejectUnauthorized rejects a plaintext client at the TLS
    // handshake and a client certificate that is not signed by the CA. The
    // expected CN is enforced on the authenticated TLS socket, before Express
    // sees the request, so a CA-signed certificate for another component (for
    // example the API's CN=api) is rejected at the transport layer.
    controlServer = https.createServer(
      {
        key: readFileSync(opts.controlTls.keyFile),
        cert: readFileSync(opts.controlTls.certFile),
        ca: readFileSync(opts.controlTls.caFile),
        requestCert: true,
        rejectUnauthorized: true,
      },
      controlApp,
    );
    const expectedCn = opts.controlClientCn ?? "controller";
    controlServer.on("secureConnection", (socket) => {
      const cn = socket.getPeerCertificate().subject?.CN;
      if (cn !== expectedCn) {
        log.warn("relay_control_client_rejected", {
          reason: cn ? "wrong_cn" : "missing_certificate",
        });
        socket.destroy();
      }
    });
  } else {
    // Local dev/test only: see RelayOptions.controlTls.
    app.use(express.json({ limit: "32mb" }));
    registerRelayControlRoutes(app, registry, controlOptions);
  }

  // The plaintext fallback is local-dev/test only (see RelayOptions.controlTls).
  // Its token check lives in the HTTP server wrapper rather than an Express
  // route: the production listener authenticates the caller at the TLS layer,
  // and the fallback should not create a second Express authorization site.
  const server = http.createServer(
    opts.controlTls
      ? app
      : (req, res) => {
          if (isControlRequest(req) && !hasRelayAdminToken(req, opts.adminToken)) {
            recordAuthFailure("relay_admin_token", metricsRegistry);
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "unauthorized" }));
            return;
          }
          app(req, res);
        },
  );
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  attachGuestUpgrade(server, wss, registry);

  return {
    app,
    server,
    ...(controlServer ? { controlServer } : {}),
    generation,
    size: () => registry.size(),
    collectMetrics: () => collectRelayMetrics(metricsRegistry, registry),
    close: async () => {
      registry.closeAll(1001, "relay shutting down");
      wss.close();
      const closeHttp = new Promise<void>((resolve) => server.close(() => resolve()));
      const closeControl = controlServer
        ? new Promise<void>((resolve) => controlServer!.close(() => resolve()))
        : Promise.resolve();
      await Promise.all([closeHttp, closeControl]);
    },
  };
}

/**
 * Tell the controller a fresh relay is serving. PROVISIONING sessions then
 * re-register in the next reconcile pass instead of waiting for the poll
 * interval, and PAID sessions that were held at the readiness gate proceed.
 * Fire-and-forget: a lost wake only costs one tick.
 *
 * This is the relay -> controller direction. It deliberately keeps using the
 * controller's plaintext HTTP listener and the low-privilege wake token; that
 * listener is reachable only from the relay's pod and cannot reach any other
 * internal endpoint.
 */
export function notifyControllerReady(opts: RelayOptions): void {
  wakeController(opts);
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
    headers: { "x-wake-token": opts.wakeToken, connection: "close" },
    signal: AbortSignal.timeout(1_000),
  }).catch(() => undefined);
}
