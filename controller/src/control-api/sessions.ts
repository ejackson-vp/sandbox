import type { Express, Request, Response } from "express";
import { LATENCY_BUCKETS, metrics } from "@x402s/shared";
import { LifecycleError } from "../reconciler.js";
import { log } from "@x402s/shared";
import { operationSchema, opLabel } from "../control-api-schemas.js";
import { describeSession } from "../session-view.js";
import type { ControlApiDeps } from "./types.js";

export function registerSessionRoutes(app: Express, deps: ControlApiDeps): void {
  const { cfg, store, relay } = deps;
  app.get("/internal/sessions/:id", (req: Request, res: Response) => {
    const view = describeSession(store, String(req.params.id ?? ""));
    if (!view) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(view);
  });

  app.post("/internal/sessions/:id/suspend", async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    if (!deps.suspend) {
      res.status(501).json({ error: "not_supported" });
      return;
    }
    try {
      await deps.suspend(id);
      const view = describeSession(store, id);
      if (!view) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(view);
    } catch (err) {
      if (err instanceof LifecycleError) {
        res.status(err.status).json({ error: err.code, message: err.message, ...(err.details ?? {}) });
        return;
      }
      res.status(500).json({ error: "suspend_failed", message: (err as Error).message });
    }
  });

  app.post("/internal/sessions/:id/resume", async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    if (!deps.resume) {
      res.status(501).json({ error: "not_supported" });
      return;
    }
    try {
      await deps.resume(id);
      const view = describeSession(store, id);
      if (!view) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.status(202).json(view);
    } catch (err) {
      if (err instanceof LifecycleError) {
        res.status(err.status).json({ error: err.code, message: err.message, ...(err.details ?? {}) });
        return;
      }
      res.status(500).json({ error: "resume_failed", message: (err as Error).message });
    }
  });

  app.post("/internal/sessions/:id/operations", async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const parsed = operationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const { requestId, envelope, op } = parsed.data;
    const operationStarted = Date.now();
    res.on("finish", () => {
      const label = opLabel(op);
      metrics
        .histogram("sandbox_exec_duration_seconds", "Operation duration (controller view)", LATENCY_BUCKETS)
        .observe((Date.now() - operationStarted) / 1000, { op: label });
      metrics
        .counter("sandbox_exec_total", "Operations by result")
        .inc({ op: label, result: res.statusCode < 300 ? (res.statusCode === 202 ? "pending" : "ok") : "error" });
    });

    const session = store.getSession(id);
    if (!session) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (session.state !== "SUSPENDED") store.touchActivity(id);
    const claim = store.claimOperation(id, requestId, op ?? "operation");
    if (!claim.ok) {
      if (claim.code === "duplicate") {
        // Idempotent retry: return the (possibly still pending) response.
        const existing = await relay.response(id, requestId, parsed.data.waitMs ?? 1000).catch(() => ({ kind: "pending" as const }));
        if (existing.kind === "envelope") {
          res.json({ state: store.getSession(id)?.state ?? session.state, requestId, envelope: existing.envelope });
          return;
        }
        res.status(202).json({ state: store.getSession(id)?.state ?? session.state, requestId, pending: true });
        return;
      }
      if (claim.code === "busy") {
        res.status(409).json({
          error: "busy",
          state: claim.state,
          requestId: claim.requestId,
          message: "another operation is already running in this session",
        });
        return;
      }
      if (claim.code === "lease_expired") {
        store.requestTermination(id, "lease_expired");
        res.status(410).json({
          error: "lease_expired",
          state: "TERMINATING",
          message: "the session lease has ended",
        });
        return;
      }
      res.status(409).json({
        error: "session_not_usable",
        state: claim.state,
        message: `the session is not accepting operations (state ${claim.state})`,
      });
      return;
    }

    const leaseDeadline = session.leaseExpiresAt ?? Date.now();
    const deadline = Math.min(leaseDeadline + 1000, Date.now() + 10 * 60_000);
    try {
      await relay.request(id, requestId, envelope, deadline);
    } catch (err) {
      store.finishOperation(id, requestId, "abandoned");
      const status = (err as { status?: number }).status;
      log.warn("operation_delivery_failed", { sessionId: id, requestId, status, error: (err as Error).message });
      res.status(409).json({ error: "guest_not_available", state: store.getSession(id)?.state });
      return;
    }

    const waitMs = Math.max(
      0,
      Math.min(
        parsed.data.waitMs ?? cfg.relayResponseWaitMs,
        Math.max(0, leaseDeadline - Date.now()) + 1000,
      ),
    );
    let outcome;
    try {
      outcome = await relay.response(id, requestId, waitMs);
    } catch (err) {
      log.warn("operation_response_failed", { sessionId: id, requestId, error: (err as Error).message });
      res.status(202).json({ state: store.getSession(id)?.state, requestId, pending: true });
      return;
    }
    if (outcome.kind === "envelope") {
      store.finishOperation(id, requestId, "done");
      res.json({ state: store.getSession(id)?.state, requestId, envelope: outcome.envelope });
      return;
    }
    if (outcome.kind === "guest_error") {
      store.finishOperation(id, requestId, "error");
      res.status(502).json({ error: "guest_error", message: outcome.message, requestId });
      return;
    }
    res.status(202).json({ state: store.getSession(id)?.state, requestId, pending: true });
  });

  app.get("/internal/sessions/:id/operations/:requestId", async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const requestId = String(req.params.requestId ?? "");
    const record = store.getExecRequest(id, requestId);
    if (!record) {
      res.status(404).json({ error: "request_not_found" });
      return;
    }
    const waitMs = Math.min(120_000, Number(req.query.waitMs) || 20_000);
    try {
      const outcome = await relay.response(id, requestId, waitMs);
      if (outcome.kind === "envelope") {
        if (record.state === "pending") store.finishOperation(id, requestId, "done");
        res.json({ state: store.getSession(id)?.state, requestId, envelope: outcome.envelope });
        return;
      }
      if (outcome.kind === "guest_error") {
        res.status(502).json({ error: "guest_error", message: outcome.message, requestId });
        return;
      }
    } catch {
      /* fall through to pending/expired */
    }
    if (record.state === "pending") {
      res.status(202).json({ state: store.getSession(id)?.state, requestId, pending: true });
      return;
    }
    res.status(410).json({ error: "result_expired", requestId });
  });

  app.delete("/internal/sessions/:id/operations/:requestId", async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const requestId = String(req.params.requestId ?? "");
    const record = store.getExecRequest(id, requestId);
    if (!record) {
      res.status(404).json({ error: "request_not_found" });
      return;
    }
    try {
      await relay.cancel(id, requestId);
    } catch (err) {
      log.warn("cancel_failed", { sessionId: id, requestId, error: (err as Error).message });
    }
    res.status(202).json({ ok: true, requestId });
  });

  app.delete("/internal/sessions/:id", (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const session = store.getSession(id);
    if (!session) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    store.requestDestroy(id);
    deps.wake?.();
    log.info("session_destroy_requested", { sessionId: id, state: session.state });
    res.json({ state: store.getSession(id)?.state ?? session.state });
  });

}
