import type { Express, NextFunction, Request, Response } from "express";
import { metrics } from "@x402s/shared";
import { log } from "@x402s/shared";
import { constantTimeEqual } from "../tokens.js";
import { MAX_FRAME_BYTES, type RelayRegistry } from "./registry.js";

export interface RelayHttpOptions {
  adminToken: string;
}

export function registerRelayRoutes(
  app: Express,
  registry: RelayRegistry,
  opts: RelayHttpOptions,
): void {
  const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    const token = req.header("x-internal-token") ?? "";
    if (!opts.adminToken || !constantTimeEqual(token, opts.adminToken)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, sessions: registry.size() });
  });

  app.get("/metrics", (_req, res) => {
    metrics.gauge("sandbox_relay_sessions", "Registered relay sessions").set({}, registry.size());
    metrics
      .gauge("sandbox_relay_pending_requests", "Requests awaiting a guest response")
      .set({}, registry.pendingTotal());
    res.setHeader("content-type", "text/plain; version=0.0.4");
    res.send(metrics.render());
  });

  app.post("/internal/register", requireAdmin, (req, res) => {
    const { sessionId, tokenHash, ttlMs } = req.body ?? {};
    if (typeof sessionId !== "string" || typeof tokenHash !== "string") {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const result = registry.register(sessionId, tokenHash, Number(ttlMs));
    if (result === "at_capacity") {
      res.status(503).json({ error: "relay_at_capacity" });
      return;
    }
    if (result === "already_connected") {
      res.status(409).json({ error: "session_already_connected" });
      return;
    }
    res.status(201).json({ ok: true });
  });

  app.get("/internal/:sessionId/state", requireAdmin, (req, res) => {
    res.json(registry.state(String(req.params.sessionId ?? "")));
  });

  app.post("/internal/:sessionId/request", requireAdmin, (req: Request, res: Response) => {
    const sessionId = String(req.params.sessionId ?? "");
    const { id, envelope, deadlineMs } = req.body ?? {};
    if (typeof id !== "string" || id.length < 8 || id.length > 128) {
      res.status(400).json({ error: "invalid_request_id" });
      return;
    }
    if (typeof envelope !== "string" || envelope.length === 0 || envelope.length > MAX_FRAME_BYTES) {
      res.status(400).json({ error: "invalid_envelope" });
      return;
    }
    const result = registry.request(sessionId, id, envelope, Number(deadlineMs));
    if (result === "not_registered") {
      res.status(404).json({ error: "session_not_registered" });
      return;
    }
    if (result === "cached") {
      res.status(202).json({ ok: true, cached: true });
      return;
    }
    if (result === "pending") {
      res.status(202).json({ ok: true, pending: true });
      return;
    }
    if (result === "too_many") {
      res.status(429).json({ error: "too_many_pending_requests" });
      return;
    }
    if (result === "not_connected") {
      res.status(409).json({ error: "guest_not_connected" });
      return;
    }
    log.info("relay_request_forwarded", { sessionId, requestId: id, envelopeBytes: envelope.length });
    res.status(202).json({ ok: true });
  });

  app.post("/internal/:sessionId/cancel", requireAdmin, (req: Request, res: Response) => {
    const sessionId = String(req.params.sessionId ?? "");
    const { id } = req.body ?? {};
    if (typeof id !== "string") {
      res.status(400).json({ error: "invalid_request_id" });
      return;
    }
    const result = registry.cancel(sessionId, id);
    if (result === "not_registered") {
      res.status(404).json({ error: "session_not_registered" });
      return;
    }
    if (result === "not_connected") {
      res.status(409).json({ error: "guest_not_connected" });
      return;
    }
    log.info("relay_cancel_forwarded", { sessionId, requestId: id });
    res.status(202).json({ ok: true });
  });

  app.post("/internal/:sessionId/shutdown", requireAdmin, (req: Request, res: Response) => {
    const sessionId = String(req.params.sessionId ?? "");
    const reason = String(req.body?.reason ?? "lease ended");
    if (registry.shutdown(sessionId, reason) === "not_registered") {
      res.status(404).json({ error: "session_not_registered" });
      return;
    }
    log.info("relay_shutdown_forwarded", { sessionId });
    res.status(202).json({ ok: true });
  });

  app.post("/internal/:sessionId/claim", requireAdmin, (req: Request, res: Response) => {
    const sessionId = String(req.params.sessionId ?? "");
    const claim = req.body?.claim;
    if (!claim || typeof claim !== "object" || typeof (claim as { sessionId?: unknown }).sessionId !== "string") {
      res.status(400).json({ error: "invalid_claim" });
      return;
    }
    const result = registry.claim(sessionId, claim);
    if (result === "not_registered" || result === "not_connected") {
      res.status(409).json({ error: "guest_not_connected" });
      return;
    }
    log.info("relay_claim_forwarded", {
      poolSessionId: sessionId,
      sessionId: (claim as { sessionId: string }).sessionId,
    });
    res.status(202).json({ ok: true });
  });

  app.get("/internal/:sessionId/response/:requestId", requireAdmin, async (req: Request, res: Response) => {
    const sessionId = String(req.params.sessionId ?? "");
    const requestId = String(req.params.requestId ?? "");
    const waitMs = Math.min(120_000, Number(req.query.waitMs) || 20_000);
    const result = await registry.waitForResponse(sessionId, requestId, waitMs);
    if (result.kind === "not_registered") {
      res.status(404).json({ error: "session_not_registered" });
      return;
    }
    if (result.kind === "envelope") {
      res.json({ envelope: result.envelope });
      return;
    }
    if (result.kind === "error") {
      res.status(409).json({ error: "guest_error", message: result.message });
      return;
    }
    res.status(202).json({ pending: result.stillPending });
  });

  app.delete("/internal/:sessionId", requireAdmin, (req, res) => {
    const sessionId = String(req.params.sessionId ?? "");
    if (!registry.remove(sessionId)) {
      res.status(404).json({ error: "session_not_registered" });
      return;
    }
    log.info("relay_session_purged", { sessionId });
    res.json({ ok: true });
  });
}
