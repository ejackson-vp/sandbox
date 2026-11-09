/**
 * Internal control API (controller-owned).
 *
 * Reached only by the API server, over the cluster network, with a shared
 * admin token and a NetworkPolicy that permits nothing else. It is never
 * exposed through the ingress path.
 *
 * All customer payloads here are opaque sealed-box envelopes; commands, file
 * contents and results never appear in this process.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { metrics } from "@x402s/shared";
import { constantTimeEqual } from "./tokens.js";
import { log } from "@x402s/shared";
import { createCapacityRouter } from "./capacity/routes.js";
import { registerPaymentRoutes } from "./control-api/payments.js";
import { registerSessionRoutes } from "./control-api/sessions.js";
import type { ControlApiDeps } from "./control-api/types.js";

export type { ControlApiDeps } from "./control-api/types.js";

export function createControlApi(deps: ControlApiDeps): express.Express {
  const { cfg } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32mb" }));

  app.get("/internal/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // A client certificate signed by the internal CA with CN=api is an
  // authenticated caller. Anything else must present the bearer token, which is
  // what the relay (wake) and in-cluster tooling use on the HTTP listener.
  const mtlsCn = (req: Request): string | undefined => {
    const socket = req.socket as {
      authorized?: boolean;
      getPeerCertificate?: () => { subject?: { CN?: string } };
    };
    if (socket.authorized !== true || typeof socket.getPeerCertificate !== "function") {
      return undefined;
    }
    return socket.getPeerCertificate().subject?.CN;
  };

  app.post("/internal/wake", (req, res) => {
    // The relay holds only this token; it can nudge the reconciler but cannot
    // reach any other internal endpoint.
    const token = req.header("x-wake-token") ?? req.header("x-internal-token") ?? "";
    // The API holds the admin token; the relay holds only the wake token.
    const authorized =
      mtlsCn(req) === "api" ||
      (Boolean(cfg.wakeToken) && constantTimeEqual(token, cfg.wakeToken)) ||
      (Boolean(cfg.adminToken) && constantTimeEqual(token, cfg.adminToken));
    if (!authorized) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    deps.wake?.();
    res.status(202).json({ ok: true });
  });

  // Aggregate metrics only (no session ids, no payloads). Scraped internally.
  app.get("/metrics", (_req, res) => {
    res.setHeader("content-type", "text/plain; version=0.0.4");
    res.send(metrics.render());
  });

  app.use("/internal", (req: Request, res: Response, next: NextFunction) => {
    const token = req.header("x-internal-token") ?? "";
    const mtls = mtlsCn(req) === "api";
    if (!mtls && (!cfg.adminToken || !constantTimeEqual(token, cfg.adminToken))) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });
  app.use("/internal", createCapacityRouter(deps.capacity));

  /* ---------------- payment intent outbox ---------------- */

  registerPaymentRoutes(app, deps);

  registerSessionRoutes(app, deps);

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error("control_api_error", { error: err.message });
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}

