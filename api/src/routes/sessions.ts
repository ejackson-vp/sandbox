/**
 * Session routes: status, the single operations surface, and lifecycle.
 */
import express, { type Request, type Response } from "express";
import { safeEqualHex, sha256Hex, ringAcceptsToken } from "@x402s/shared/crypto";
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
import { operationSchema, payloadHashSchema, requestIdSchema, rejectPlaintextBodies } from "../schemas.js";
import { toStatus } from "../status.js";

interface SessionsDeps {
  config: ApiConfig;
  controller: ControllerClient;
}

/**
 * The response every session route sends when the controller call fails.
 *
 * A `ControllerError` carries the status and code the client should see, so the
 * default is a straight copy. `translate` lets a route override either, which is
 * how a lease that runs out mid-command becomes 410 instead of the controller's
 * own status. Anything else is the control plane being unreachable: `log` names
 * the failed call when the route passes one, and the client gets 503 without the
 * internal message.
 */
function respondControllerError(
  res: Response,
  err: unknown,
  options: {
    translate?: (err: ControllerError) => { code?: string; status?: number };
    log?: string;
  } = {},
): void {
  if (!(err instanceof ControllerError)) {
    if (options.log) log.error(options.log, { error: (err as Error).message });
    res.status(503).json({ error: "control_plane_unavailable" });
    return;
  }
  const mapped = options.translate?.(err) ?? {};
  res.status(mapped.status ?? err.status).json({
    error: mapped.code ?? err.code,
    message: err.message,
  });
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
    // A token signed by a retired key id is refused before the hash compare, so
    // retiring a key takes effect immediately instead of when its sessions age
    // out. Legacy tokens carry no key id and are covered by the hash alone.
    if (!ringAcceptsToken(deps.config.capabilityKeys, capability)) {
      recordAuthFailure("capability_invalid");
      res.status(404).json({ error: "session_not_found" });
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
      // 90 s, not 120: the public API sits behind an edge proxy that answers 524
      // at 100 s. A long command must come back `202 pending` so the client can
      // re-poll, so the default wait stays under that ceiling.
      const waitMs =
        parsed.data.waitMs ??
        Math.min(
          90_000,
          (parsed.data.timeoutMs ?? deps.config.platformLimits.maxCommandSeconds * 1000) + 5_000,
        );
      const out = await deps.controller.operation(session.sessionId, {
        requestId: parsed.data.requestId,
        envelope: parsed.data.envelope,
        op: "operation",
        waitMs,
        ...(parsed.data.payloadHash ? { payloadHash: parsed.data.payloadHash } : {}),
      });
      if (out.pending) {
        res.status(202).json({ state: out.state, requestId: out.requestId, pending: true });
        return;
      }
      res.json({ state: out.state, requestId: out.requestId, envelope: out.envelope });
    } catch (err) {
      respondControllerError(res, err, {
        log: "operation_failed",
        // A lease that ran out mid-command is a 410, so the client stops retrying.
        translate: (e) => ({ status: e.code === "lease_expired" ? 410 : e.status }),
      });
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
    // Optional: the client-computed canonical operation hash. A malformed value
    // is refused rather than ignored, because silently falling back would hide a
    // client bug and change which payload the request id is bound to.
    const rawPayloadHash = req.query.payloadHash;
    let payloadHash: string | undefined;
    if (rawPayloadHash !== undefined) {
      if (typeof rawPayloadHash !== "string" || !payloadHashSchema.safeParse(rawPayloadHash).success) {
        res.status(400).json({ error: "invalid_payload_hash" });
        return;
      }
      payloadHash = rawPayloadHash;
    }
    try {
      const out = await deps.controller.operation(session.sessionId, {
        requestId,
        envelope,
        op: "file.get",
        waitMs: 60_000,
        ...(payloadHash ? { payloadHash } : {}),
      });
      if (out.pending) {
        res.status(202).json({ state: out.state, requestId: out.requestId, pending: true });
        return;
      }
      res.json({ state: out.state, requestId: out.requestId, envelope: out.envelope });
    } catch (err) {
      respondControllerError(res, err, {
        log: "file_get_failed",
        // The read path passes the controller's status through, 410 included,
        // rather than reinterpreting it.
        translate: (e) => ({ status: e.status === 410 ? 410 : e.status }),
      });
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
    // Clamped to the same 90 s ceiling as `waitMs` on the operation body: a poll
    // behind the public edge must not outlive the proxy's 100 s timeout either.
    const waitMs = Number.isFinite(requestedWait)
      ? Math.min(90_000, Math.max(0, requestedWait))
      : 20_000;
    try {
      const out = await deps.controller.getOperation(session.sessionId, requestId, waitMs);
      if (out.pending) {
        res.status(202).json({ state: out.state, requestId, pending: true });
        return;
      }
      res.json({ state: out.state, requestId, envelope: out.envelope });
    } catch (err) {
      respondControllerError(res, err);
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
      respondControllerError(res, err);
    }
  });

  router.post("/v1/sessions/:id/suspend", async (req, res) => {
    const session = await authorize(req, res);
    if (!session) return;
    try {
      const out = await deps.controller.suspend(session.sessionId);
      res.json(toStatus(out));
    } catch (err) {
      respondControllerError(res, err);
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
      respondControllerError(res, err);
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
