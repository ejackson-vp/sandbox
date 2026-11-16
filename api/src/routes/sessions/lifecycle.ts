/**
 * Lifecycle: suspend, resume, destroy.
 *
 * Suspend and resume answer with the status the controller returned. Resume and
 * destroy also wake the reconciler: a resume is useless until the next pass, and
 * a destroy is the pass that frees the capacity. Destroy keeps its own error
 * answer rather than `respondControllerError`, because a failed destroy is not
 * something the client can act on and the reason stays in the log.
 */
import express, { type Request, type Response } from "express";
import { log } from "@x402s/shared/runtime";
import { toStatus } from "../../status.js";
import type { Authorizer, SessionsDeps } from "./authorize.js";
import { respondControllerError } from "./respond.js";

export function mountLifecycleRoutes(
  router: express.Router,
  deps: SessionsDeps,
  authorize: Authorizer,
): void {
  router.post("/v1/sessions/:id/suspend", (req, res) => suspend(req, res, deps, authorize));
  router.post("/v1/sessions/:id/resume", (req, res) => resume(req, res, deps, authorize));
  router.delete("/v1/sessions/:id", (req, res) => destroy(req, res, deps, authorize));
}

async function suspend(
  req: Request,
  res: Response,
  deps: SessionsDeps,
  authorize: Authorizer,
): Promise<void> {
  const session = await authorize(req, res);
  if (!session) return;
  try {
    const out = await deps.controller.suspend(session.sessionId);
    res.json(toStatus(out));
  } catch (err) {
    respondControllerError(res, err);
  }
}

async function resume(
  req: Request,
  res: Response,
  deps: SessionsDeps,
  authorize: Authorizer,
): Promise<void> {
  const session = await authorize(req, res);
  if (!session) return;
  try {
    const out = await deps.controller.resume(session.sessionId);
    void deps.controller.wake();
    res.status(202).json(toStatus(out));
  } catch (err) {
    respondControllerError(res, err);
  }
}

async function destroy(
  req: Request,
  res: Response,
  deps: SessionsDeps,
  authorize: Authorizer,
): Promise<void> {
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
}
