/**
 * Session routes: status, the single operations surface, and lifecycle.
 */
import express, { type Request, type Response } from "express";
import { safeEqualHex, sha256Hex } from "@x402s/shared/crypto";
import {
  LATENCY_BUCKETS,
  log,
  metrics,
  recordAuthFailure,
  recordRateLimited,
} from "@x402s/shared/runtime";
import { RateLimiter } from "../admission.js";
import { ControllerError, type ControllerClient, type SessionView } from "../controller-client.js";
import type { ApiConfig } from "../config.js";
import { operationSchema, requestIdSchema, rejectPlaintextBodies } from "../schemas.js";
import { toStatus } from "../status.js";

export interface SessionsDeps {
  config: ApiConfig;
  controller: ControllerClient;
}

export function createSessionsRouter(deps: SessionsDeps): express.Router {
  const router = express.Router();
  const readLimiter = new RateLimiter(deps.config.readRateBurst, deps.config.readRateRefill);

  const authorize = async (req: Request, res: Response): Promise<SessionView | null> => {
    if (!readLimiter.take(req.ip ?? "unknown")) {
      recordRateLimited("read");
      res.status(429).json({ error: "rate_limited" });
      return null;
    }
    const id = String(req.params.id ?? "");
    const capability = req.header("x-sandbox-capability");
    if (!capability || capability.length < 20 || capability.length > 128) {
      recordAuthFailure("capability_missing");
      res.status(401).json({ error: "capability_required" });
      return null;
    }
    let session: SessionView;
    try {
      session = await deps.controller.getSession(id);
    } catch (err) {
      if (err instanceof ControllerError && err.status === 404) {
        res.status(404).json({ error: "session_not_found" });
        return null;
      }
      log.error("session_lookup_failed", { error: (err as Error).message });
      res.status(503).json({ error: "control_plane_unavailable" });
      return null;
    }
    const presented = sha256Hex(capability);
    if (!safeEqualHex(presented, session.capabilityHash)) {
      recordAuthFailure("capability_invalid");
      res.status(404).json({ error: "session_not_found" });
      return null;
    }
    if (Date.now() > session.capabilityExpiresAt) {
      recordAuthFailure("capability_expired");
      res.status(410).json({ error: "capability_expired" });
      return null;
    }
    return session;
  };

  router.get("/v1/sessions/:id", async (req, res) => {
    const session = await authorize(req, res);
    if (!session) return;
    res.json(toStatus(session));
  });

  /** Every operation: the API only sees ciphertext. */
  const runOperation = async (req: Request, res: Response): Promise<void> => {
    const started = Date.now();
    metrics.gauge("sandbox_operations_active", "Operations in flight").inc();
    res.on("finish", () => {
      metrics.gauge("sandbox_operations_active", "Operations in flight").dec();
      metrics.histogram("sandbox_operation_duration_seconds", "Operation duration", LATENCY_BUCKETS).observe((Date.now() - started) / 1000);
      metrics.counter("sandbox_operations_total", "Operations by result").inc({ result: res.statusCode < 300 ? "ok" : "error" });
    });
    const session = await authorize(req, res);
    if (!session) return;
    if (session.state === "SUSPENDED") {
      res.status(409).json({
        error: "session_suspended",
        message: "resume the session before sending operations",
      });
      return;
    }
    const parsed = operationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    try {
      const waitMs =
        parsed.data.waitMs ??
        Math.min(
          120_000,
          (parsed.data.timeoutMs ?? deps.config.platformLimits.maxCommandSeconds * 1000) + 5_000,
        );
      const out = await deps.controller.operation(session.sessionId, {
        requestId: parsed.data.requestId,
        envelope: parsed.data.envelope,
        op: "operation",
        waitMs,
      });
      if (out.pending) {
        res.status(202).json({ state: out.state, requestId: out.requestId, pending: true });
        return;
      }
      res.json({ state: out.state, requestId: out.requestId, envelope: out.envelope });
    } catch (err) {
      if (err instanceof ControllerError) {
        const code = err.code;
        const status = code === "lease_expired" ? 410 : err.status;
        res.status(status).json({ error: code, message: err.message });
        return;
      }
      log.error("operation_failed", { error: (err as Error).message });
      res.status(503).json({ error: "control_plane_unavailable" });
    }
  };

  // Every operation carries its type inside the sealed envelope. The URL is
  // deliberately opaque: a path cannot change what the guest does, and the API
  // never sees the command.
  router.post("/v1/sessions/:id/operations", rejectPlaintextBodies, (req, res) =>
    runOperation(req, res),
  );

  // Download/list/stat: the request (path and options) is inside the encrypted
  // envelope too, so the API never learns what is being read.
  router.get("/v1/sessions/:id/operations", async (req, res) => {
    const session = await authorize(req, res);
    if (!session) return;
    const raw = req.query.request;
    const requestId = typeof req.query.requestId === "string" ? req.query.requestId : "";
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 2 * 1024 * 1024) {
      res.status(400).json({ error: "request_envelope_required" });
      return;
    }
    if (!requestIdSchema.safeParse(requestId).success) {
      res.status(400).json({ error: "invalid_request_id" });
      return;
    }
    // Standard base64 only. Guessing base64url from `-`/`_` could silently
    // reinterpret a payload as different bytes. Clients percent-encode the
    // value, so `+` and `/` are safe in the query string.
    if (raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
      res.status(400).json({ error: "invalid_envelope_encoding" });
      return;
    }
    const envelope = raw;
    try {
      const out = await deps.controller.operation(session.sessionId, {
        requestId,
        envelope,
        op: "file.get",
        waitMs: 60_000,
      });
      if (out.pending) {
        res.status(202).json({ state: out.state, requestId: out.requestId, pending: true });
        return;
      }
      res.json({ state: out.state, requestId: out.requestId, envelope: out.envelope });
    } catch (err) {
      if (err instanceof ControllerError) {
        res.status(err.status === 410 ? 410 : err.status).json({ error: err.code, message: err.message });
        return;
      }
      log.error("file_get_failed", { error: (err as Error).message });
      res.status(503).json({ error: "control_plane_unavailable" });
    }
  });

  router.get("/v1/sessions/:id/requests/:requestId", async (req, res) => {
    const session = await authorize(req, res);
    if (!session) return;
    const requestId = String(req.params.requestId ?? "");
    if (!requestIdSchema.safeParse(requestId).success) {
      res.status(400).json({ error: "invalid_request_id" });
      return;
    }
    const requestedWait = Number(req.query.waitMs);
    const waitMs = Number.isFinite(requestedWait)
      ? Math.min(120_000, Math.max(0, requestedWait))
      : 20_000;
    try {
      const out = await deps.controller.getOperation(session.sessionId, requestId, waitMs);
      if (out.pending) {
        res.status(202).json({ state: out.state, requestId, pending: true });
        return;
      }
      res.json({ state: out.state, requestId, envelope: out.envelope });
    } catch (err) {
      if (err instanceof ControllerError) {
        res.status(err.status).json({ error: err.code, message: err.message });
        return;
      }
      res.status(503).json({ error: "control_plane_unavailable" });
    }
  });

  router.delete("/v1/sessions/:id/requests/:requestId", async (req, res) => {
    const session = await authorize(req, res);
    if (!session) return;
    const requestId = String(req.params.requestId ?? "");
    if (!requestIdSchema.safeParse(requestId).success) {
      res.status(400).json({ error: "invalid_request_id" });
      return;
    }
    try {
      await deps.controller.cancelOperation(session.sessionId, requestId);
      res.status(202).json({ ok: true, requestId });
    } catch (err) {
      if (err instanceof ControllerError) {
        res.status(err.status).json({ error: err.code, message: err.message });
        return;
      }
      res.status(503).json({ error: "control_plane_unavailable" });
    }
  });

  router.post("/v1/sessions/:id/suspend", async (req, res) => {
    const session = await authorize(req, res);
    if (!session) return;
    try {
      const out = await deps.controller.suspend(session.sessionId);
      res.json(toStatus(out));
    } catch (err) {
      if (err instanceof ControllerError) {
        res.status(err.status).json({ error: err.code, message: err.message });
        return;
      }
      res.status(503).json({ error: "control_plane_unavailable" });
    }
  });

  router.post("/v1/sessions/:id/resume", async (req, res) => {
    const session = await authorize(req, res);
    if (!session) return;
    try {
      const out = await deps.controller.resume(session.sessionId);
      void deps.controller.wake();
      res.status(202).json(toStatus(out));
    } catch (err) {
      if (err instanceof ControllerError) {
        res.status(err.status).json({ error: err.code, message: err.message });
        return;
      }
      res.status(503).json({ error: "control_plane_unavailable" });
    }
  });

  router.delete("/v1/sessions/:id", async (req, res) => {
    const session = await authorize(req, res);
    if (!session) return;
    try {
      const out = await deps.controller.destroy(session.sessionId);
      void deps.controller.wake();
      res.json({ state: out.state });
    } catch (err) {
      log.error("destroy_failed", { error: (err as Error).message });
      res.status(503).json({ error: "control_plane_unavailable" });
    }
  });

  return router;
}
