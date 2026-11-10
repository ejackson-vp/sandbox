import type { Express, Request, Response } from "express";
import {
  INTERNAL_RATE_LIMIT,
  metrics,
  rateLimit,
  TokenBucket,
  type MetricsRegistry,
} from "@x402s/shared";
import { log } from "@x402s/shared";
import { MAX_FRAME_BYTES, type RelayRegistry } from "./registry.js";

export interface RelayProbeOptions {
  /** Identity of this relay process; changes on every restart. */
  generation: string;
  /** Optional registry size, reported on /healthz for dashboards. */
  registry?: RelayRegistry;
}

export interface RelayControlOptions {
  /** Identity of this relay process; changes on every restart. */
  generation: string;
  /**
   * Injectable for tests. Production uses a bounded per-source-IP bucket with
   * the `INTERNAL_RATE_LIMIT` burst/refill.
   */
  internalRateLimiter?: TokenBucket;
  /** Injectable for tests; matches the relay's HTTP metrics registry. */
  metricsRegistry?: MetricsRegistry;
}

/**
 * Liveness and readiness stay on the guest listener: kubelet probes cannot
 * present a client certificate. Both bodies are bounded and carry no secrets
 * (the generation is a random per-process id).
 */
export function registerRelayProbeRoutes(app: Express, opts: RelayProbeOptions): void {
  // Liveness plus the controller's generation probe. Deliberately cheap and
  // unauthenticated: the generation is a random per-process id, not a secret.
  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      generation: opts.generation,
      ...(opts.registry ? { sessions: opts.registry.size() } : {}),
    });
  });

  // Readiness. The relay's only dependency is its own in-memory registry, so a
  // process that answers this can accept registrations. Kept separate from
  // /healthz so the probe semantics match the other components and a future
  // dependency can be added here without changing liveness.
  app.get("/readyz", (_req, res) => {
    res.json({ ok: true });
  });
}

/**
 * The controller-facing surface. Mount this only on the control listener; it
 * is never reachable from the guest WebSocket listener.
 */
export function registerRelayControlRoutes(
  app: Express,
  registry: RelayRegistry,
  opts: RelayControlOptions,
): void {
  // Bound every control route before it touches the registry. Keyed on the
  // socket peer: the controller pod on the control listener, never a forwarded
  // header.
  const internalLimiter =
    opts.internalRateLimiter ??
    new TokenBucket(
      INTERNAL_RATE_LIMIT.capacity,
      INTERNAL_RATE_LIMIT.refillPerSecond,
      INTERNAL_RATE_LIMIT.maxBuckets,
    );
  app.use("/internal", rateLimit(internalLimiter, "relay", opts.metricsRegistry ?? metrics));

  // Guest-facing relay metrics are published on the private METRICS_PORT
  // listener in the composition root, not on this control listener.

  app.post("/internal/register", (req, res) => {
    const { sessionId, tokenHash, ttlMs, generation } = req.body ?? {};
    if (typeof sessionId !== "string" || typeof tokenHash !== "string") {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    // The controller probed /healthz first and passes the generation it saw.
    // A mismatch means the caller reached a relay that is no longer the one it
    // probed (a terminating pod on a stale connection, or a rollout race), so
    // the registration would be lost. Reject and let the controller retry
    // against the current generation.
    if (typeof generation === "string" && generation !== opts.generation) {
      res.status(409).json({ error: "relay_generation_changed", generation: opts.generation });
      return;
    }
    const result = registry.register(sessionId, tokenHash, Number(ttlMs));
    if (result === "at_capacity") {
      res.status(503).json({ error: "relay_at_capacity" });
      return;
    }
    if (result === "already_connected") {
      res.status(409).json({ error: "session_already_connected", generation: opts.generation });
      return;
    }
    res.status(201).json({ ok: true, generation: opts.generation });
  });

  app.get("/internal/:sessionId/state", (req, res) => {
    res.json(registry.state(String(req.params.sessionId ?? "")));
  });

  app.post("/internal/:sessionId/request", (req: Request, res: Response) => {
    const sessionId = String(req.params.sessionId ?? "");
    const { id, envelope, deadlineMs, epoch } = req.body ?? {};
    if (typeof id !== "string" || id.length < 8 || id.length > 128) {
      res.status(400).json({ error: "invalid_request_id" });
      return;
    }
    if (typeof envelope !== "string" || envelope.length === 0 || envelope.length > MAX_FRAME_BYTES) {
      res.status(400).json({ error: "invalid_envelope" });
      return;
    }
    if (epoch !== undefined && (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch < 0)) {
      res.status(400).json({ error: "invalid_epoch" });
      return;
    }
    const result = registry.request(sessionId, id, envelope, Number(deadlineMs), Number(epoch ?? 0));
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

  app.post("/internal/:sessionId/cancel", (req: Request, res: Response) => {
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

  app.post("/internal/:sessionId/shutdown", (req: Request, res: Response) => {
    const sessionId = String(req.params.sessionId ?? "");
    const reason = String(req.body?.reason ?? "lease ended");
    if (registry.shutdown(sessionId, reason) === "not_registered") {
      res.status(404).json({ error: "session_not_registered" });
      return;
    }
    log.info("relay_shutdown_forwarded", { sessionId });
    res.status(202).json({ ok: true });
  });

  app.post("/internal/:sessionId/claim", (req: Request, res: Response) => {
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

  app.get("/internal/:sessionId/response/:requestId", async (req: Request, res: Response) => {
    const sessionId = String(req.params.sessionId ?? "");
    const requestId = String(req.params.requestId ?? "");
    const requestedWait = Number(req.query.waitMs);
    const waitMs = Number.isFinite(requestedWait)
      ? Math.min(120_000, Math.max(0, requestedWait))
      : 20_000;
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

  app.delete("/internal/:sessionId", (req, res) => {
    const sessionId = String(req.params.sessionId ?? "");
    if (!registry.remove(sessionId)) {
      res.status(404).json({ error: "session_not_registered" });
      return;
    }
    log.info("relay_session_purged", { sessionId });
    res.json({ ok: true });
  });
}
