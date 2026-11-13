import { createHash } from "node:crypto";
import type { Express, Request, Response } from "express";
import { LATENCY_BUCKETS, log, metrics } from "@x402s/shared/runtime";
import { LifecycleError } from "../reconciler.js";
import { operationSchema, opLabel } from "../control-api-schemas.js";
import { describeSession } from "../session-view.js";
import type { ControlApiDeps } from "./types.js";

/**
 * Relay failure classes that mean the frame was accepted and the link was lost
 * before an outcome existed. The command may have run, so the outcome is
 * unknown: never a guest error, never a cache expiry, never a duplicate.
 */
function isLinkLoss(code: string): boolean {
  return code === "guest_disconnected" || code === "request_superseded";
}

/** The answer for a fenced request, wherever the client asks about it. */
function outcomeUnknown(requestId: string): Record<string, unknown> {
  return {
    error: "outcome_unknown",
    requestId,
    message: "the relay link was lost while this operation was in flight; its outcome is unknown",
  };
}

export function registerSessionRoutes(app: Express, deps: ControlApiDeps): void {
  const { cfg, store, relay } = deps;
  app.get("/internal/sessions/:id", async (req: Request, res: Response) => {
    const view = await describeSession(store, String(req.params.id ?? ""));
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
      const view = await describeSession(store, id);
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
      const view = await describeSession(store, id);
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

    const session = await store.getSession(id);
    if (!session) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (session.state !== "SUSPENDED") await store.touchActivity(id);
    // The claim is the authority on the single operation slot, not the read
    // above: the row may have moved on in between, and `claimOperation`
    // refuses in one transaction rather than on a stale snapshot.
    //
    // `requestId` is the idempotency key, so it has to travel with the payload
    // it was first used for. Prefer the client's hash of the canonical
    // operation plaintext: sealing is non-deterministic, so hashing the
    // ciphertext would turn a re-sealed retry of the same operation into a
    // mismatch. The ciphertext hash stays as the fallback for clients that do
    // not send one. Neither value is trusted for anything but idempotency.
    const payloadHash =
      parsed.data.payloadHash ?? createHash("sha256").update(envelope).digest("hex");
    const claim = await store.claimOperation(id, requestId, op ?? "operation", payloadHash);
    if (!claim.ok) {
      if (claim.code === "idempotency_key_reused") {
        // Same id, different payload: the cached result belongs to another
        // operation, so neither running this one nor returning that result is
        // correct.
        res.status(409).json({ error: "idempotency_key_reused", requestId });
        return;
      }
      if (claim.code === "duplicate") {
        // Idempotent retry: return the (possibly still pending) response.
        const record = await store.getExecRequest(id, requestId);
        const existing = await relay.response(id, requestId, parsed.data.waitMs ?? 1000).catch(() => ({ kind: "pending" as const }));
        if (existing.kind === "envelope") {
          // Keep the result with the row, as the owning POST and the GET path
          // do, so this answer is still available after the relay evicts it.
          // The store's `state = 'pending'` guard means a fenced request is
          // left as `outcome_unknown` either way.
          if (record?.state === "pending" || record?.state === "outcome_unknown") {
            await store.finishOperation(id, requestId, "done", existing.envelope);
          }
          res.json({
            state: (await store.getSession(id))?.state ?? session.state,
            requestId,
            envelope: existing.envelope,
          });
          return;
        }
        if (record?.resultEnvelope) {
          // The relay has evicted the result but the controller still has the
          // ciphertext it was given. It is sealed to the client key: opening it
          // is the client's job, and the controller cannot.
          res.json({
            state: (await store.getSession(id))?.state ?? session.state,
            requestId,
            envelope: record.resultEnvelope,
          });
          return;
        }
        // A retry that arrives after the link died must learn the outcome is
        // unknown, not see a pending 202 or a reused-key error. The retry is not
        // forwarded again: `claimOperation` stopped at the duplicate row.
        if (existing.kind === "guest_error" && isLinkLoss(existing.code) && record?.state === "pending") {
          await store.finishOperation(id, requestId, "outcome_unknown");
        }
        const latest = (await store.getExecRequest(id, requestId)) ?? record;
        if (latest?.state === "outcome_unknown") {
          res.status(409).json(outcomeUnknown(requestId));
          return;
        }
        res.status(202).json({
          state: (await store.getSession(id))?.state ?? session.state,
          requestId,
          pending: true,
        });
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
        await store.requestTermination(id, "lease_expired");
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
      await relay.request(id, requestId, envelope, deadline, claim.epoch);
    } catch (err) {
      await store.finishOperation(id, requestId, "abandoned");
      const status = (err as { status?: number }).status;
      if (status === 409 && (err as Error).message === "stale_epoch") {
        // The relay refused the frame because this controller's epoch is below
        // the session's: another generation has already recovered the session.
        log.warn("operation_stale_epoch", { sessionId: id, requestId, epoch: claim.epoch });
        res.status(409).json({
          error: "stale_epoch",
          state: (await store.getSession(id))?.state,
          requestId,
          message: "the request belongs to an older controller generation",
        });
        return;
      }
      log.warn("operation_delivery_failed", { sessionId: id, requestId, status, error: (err as Error).message });
      res.status(409).json({ error: "guest_not_available", state: (await store.getSession(id))?.state });
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
      res.status(202).json({ state: (await store.getSession(id))?.state, requestId, pending: true });
      return;
    }
    if (outcome.kind === "envelope") {
      await store.finishOperation(id, requestId, "done", outcome.envelope);
      res.json({ state: (await store.getSession(id))?.state, requestId, envelope: outcome.envelope });
      return;
    }
    if (outcome.kind === "guest_error") {
      if (isLinkLoss(outcome.code)) {
        // The relay accepted the frame and then lost the link. Marking the
        // request `outcome_unknown` leaves the single-operation gate closed;
        // the operation fence or relay recovery releases it once the guest is
        // idle. Never report this as a guest failure.
        await store.finishOperation(id, requestId, "outcome_unknown");
        log.warn("operation_outcome_unknown", {
          sessionId: id,
          requestId,
          relayCode: outcome.code,
        });
        res.status(409).json({
          ...outcomeUnknown(requestId),
          state: (await store.getSession(id))?.state,
        });
        return;
      }
      // The guest ran the operation and reported a failure: a real outcome.
      await store.finishOperation(id, requestId, "error");
      res.status(502).json({ error: "guest_error", message: outcome.message, requestId });
      return;
    }
    res.status(202).json({ state: (await store.getSession(id))?.state, requestId, pending: true });
  });

  app.get("/internal/sessions/:id/operations/:requestId", async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const requestId = String(req.params.requestId ?? "");
    const record = await store.getExecRequest(id, requestId);
    if (!record) {
      res.status(404).json({ error: "request_not_found" });
      return;
    }
    const requestedWait = Number(req.query.waitMs);
    const waitMs = Number.isFinite(requestedWait)
      ? Math.min(120_000, Math.max(0, requestedWait))
      : 20_000;
    try {
      const outcome = await relay.response(id, requestId, waitMs);
      if (outcome.kind === "envelope") {
        if (record.state === "pending" || record.state === "outcome_unknown") {
          await store.finishOperation(id, requestId, "done", outcome.envelope);
        }
        res.json({
          state: (await store.getSession(id))?.state,
          requestId,
          envelope: outcome.envelope,
        });
        return;
      }
      if (outcome.kind === "guest_error") {
        if (record.state === "pending" && isLinkLoss(outcome.code)) {
          // The link died while this lookup was waiting. Fence the request and
          // fall through to the outcome_unknown answer below; the row is the
          // only place the outcome can be recorded.
          await store.finishOperation(id, requestId, "outcome_unknown");
        } else if (record.state === "pending") {
          await store.finishOperation(id, requestId, "error");
          res.status(502).json({ error: "guest_error", message: outcome.message, requestId });
          return;
        }
        // A fenced request can receive `stale_epoch` from the guest; that is a
        // fence rejection, not the outcome of the interrupted operation.
      }
    } catch {
      /* fall through to stored/pending/expired */
    }
    // The relay holds a result for 5 minutes and 64 entries per session. Past
    // that the row is the only copy: `result_envelope` is the same sealed
    // ciphertext the relay had, so answering from it opens nothing. Re-read it
    // because the wait above may have outlived the snapshot taken before it.
    const latest = (await store.getExecRequest(id, requestId)) ?? record;
    if (latest.resultEnvelope) {
      res.json({
        state: (await store.getSession(id))?.state,
        requestId,
        envelope: latest.resultEnvelope,
      });
      return;
    }
    if (latest.state === "pending") {
      res.status(202).json({ state: (await store.getSession(id))?.state, requestId, pending: true });
      return;
    }
    if (latest.state === "outcome_unknown") {
      // The controller restarted, or the relay link was lost, with this request
      // in flight. It may still be executing in the guest; the result was never
      // observed. Never report success/failure or a plain cache expiry for it.
      res.status(409).json(outcomeUnknown(requestId));
      return;
    }
    // Nothing in the relay and nothing on the row: the result is gone.
    res.status(410).json({ error: "result_expired", requestId });
  });

  app.delete("/internal/sessions/:id/operations/:requestId", async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const requestId = String(req.params.requestId ?? "");
    const record = await store.getExecRequest(id, requestId);
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

  app.delete("/internal/sessions/:id", async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const session = await store.getSession(id);
    if (!session) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await store.requestDestroy(id);
    deps.wake?.();
    log.info("session_destroy_requested", { sessionId: id, state: session.state });
    res.json({ state: (await store.getSession(id))?.state ?? session.state });
  });

}
