/**
 * Poll and cancel: the two things a client does with a request id.
 *
 * A long operation answers `202 pending` and the client polls until it is
 * settled; a client that gives up cancels. Both refuse the same malformed ids
 * with the same code, which is why they sit in one module.
 */
import express, { type Request, type RequestHandler, type Response } from "express";
import type { Authorizer, SessionsDeps } from "./authorize.js";
import { respondControllerError, validRequestId, writeOperation } from "./respond.js";

export function mountRequestRoutes(
  router: express.Router,
  deps: SessionsDeps,
  rateLimit: RequestHandler,
  authorize: Authorizer,
): void {
  router.get("/v1/sessions/:id/requests/:requestId", rateLimit, (req, res) =>
    pollOperation(req, res, deps, authorize),
  );
  router.delete("/v1/sessions/:id/requests/:requestId", rateLimit, (req, res) =>
    cancelOperation(req, res, deps, authorize),
  );
}

async function pollOperation(
  req: Request,
  res: Response,
  deps: SessionsDeps,
  authorize: Authorizer,
): Promise<void> {
  const session = await authorize(req, res);
  if (!session) return;
  const requestId = validRequestId(req.params.requestId);
  if (requestId === null) {
    res.status(400).json({ error: "invalid_request_id" });
    return;
  }
  // Clamped to the same 90 s ceiling as `waitMs` on the operation body: a poll
  // behind the public edge must not outlive the proxy's 100 s timeout either.
  const requestedWait = Number(req.query.waitMs);
  const waitMs = Number.isFinite(requestedWait)
    ? Math.min(90_000, Math.max(0, requestedWait))
    : 20_000;
  try {
    const out = await deps.controller.getOperation(session.sessionId, requestId, waitMs);
    // The path id, not the controller's echo: a poll answers for the id the
    // caller asked about.
    writeOperation(res, requestId, out);
  } catch (err) {
    respondControllerError(res, err);
  }
}

async function cancelOperation(
  req: Request,
  res: Response,
  deps: SessionsDeps,
  authorize: Authorizer,
): Promise<void> {
  const session = await authorize(req, res);
  if (!session) return;
  const requestId = validRequestId(req.params.requestId);
  if (requestId === null) {
    res.status(400).json({ error: "invalid_request_id" });
    return;
  }
  try {
    await deps.controller.cancelOperation(session.sessionId, requestId);
    res.status(202).json({ ok: true, requestId });
  } catch (err) {
    respondControllerError(res, err);
  }
}
