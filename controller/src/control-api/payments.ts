/**
 * The internal money surface: eight routes, mounted in one place.
 *
 * The modules under `payments/` own one route group each: the claim and its
 * read, the completion, the fail and refund writes, and the ledger reads. This
 * file is only the mount order, so adding a route means choosing a group rather
 * than growing a handler.
 *
 * Every path, status code and body here is a wire contract shared with the API
 * and the SDK. Moving a handler must not change any of them.
 */
import type { Express } from "express";
import type { ControlApiDeps } from "./types.js";
import { mountClaimRoutes } from "./payments/claim.js";
import { mountCompleteRoutes } from "./payments/complete.js";
import { mountReadRoutes } from "./payments/read.js";
import { mountReconcileRoutes } from "./payments/reconcile.js";

export function registerPaymentRoutes(app: Express, deps: ControlApiDeps): void {
  mountClaimRoutes(app, deps);
  mountCompleteRoutes(app, deps);
  mountReconcileRoutes(app, deps);
  mountReadRoutes(app, deps);
}
