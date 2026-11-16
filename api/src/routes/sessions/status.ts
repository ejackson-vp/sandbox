/**
 * Session status: one read, mapped for the client.
 *
 * `toStatus` is where the controller's internal view becomes the public wire
 * status, so this route does no shaping of its own.
 */
import express, { type RequestHandler } from "express";
import { toStatus } from "../../status.js";
import type { Authorizer } from "./authorize.js";

export function mountStatusRoutes(
  router: express.Router,
  rateLimit: RequestHandler,
  authorize: Authorizer,
): void {
  router.get("/v1/sessions/:id", rateLimit, async (req, res) => {
    const session = await authorize(req, res);
    if (!session) return;
    res.json(toStatus(session));
  });
}
