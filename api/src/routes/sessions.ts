/**
 * Session routes: status, the single operations surface, and lifecycle.
 *
 * This file used to be one 243-line function that built the router, the read
 * limiter, the capability check and six route groups inline. The limiter and the
 * check are one authorizer (`./sessions/authorize.ts`), each route group is one
 * module under `./sessions/`, and what is left here is the mount order. The
 * three shared answers live in `./sessions/respond.ts`.
 */
import express from "express";
import { createAuthorizer, createReadLimit, type SessionsDeps } from "./sessions/authorize.js";
import { mountLifecycleRoutes } from "./sessions/lifecycle.js";
import { mountOperationRoutes } from "./sessions/operations.js";
import { mountRequestRoutes } from "./sessions/requests.js";
import { mountStatusRoutes } from "./sessions/status.js";

export function createSessionsRouter(deps: SessionsDeps): express.Router {
  const router = express.Router();
  const readLimit = createReadLimit(deps);
  const authorize = createAuthorizer(deps);
  mountStatusRoutes(router, readLimit, authorize);
  mountOperationRoutes(router, deps, readLimit, authorize);
  mountRequestRoutes(router, deps, readLimit, authorize);
  mountLifecycleRoutes(router, deps, readLimit, authorize);
  return router;
}
