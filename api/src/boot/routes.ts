/**
 * The routes `createApp` mounts, in the order they have to be mounted.
 *
 * The catalogue is read-only; the create route owns the x402 handshake and the
 * limiters in front of it; the session router owns everything a capability
 * unlocks. `errorBackstop` is last and has to stay last.
 */
import express from "express";
import type { ApiDeps } from "./deps.js";
import type { PaymentSurface } from "./payment-surface.js";
import { RateLimiter } from "../admission.js";
import { createCatalogueRouter } from "../routes/catalogue.js";
import { errorBackstop } from "../routes/errors.js";
import { createSessionHandler } from "../routes/create-session.js";
import { createSessionsRouter } from "../routes/sessions.js";
import { rejectPlaintextBodies } from "../schemas.js";

export function mountRoutes(
  app: express.Express,
  deps: ApiDeps,
  surface: PaymentSurface,
): void {
  const { config, controller } = deps;

  // Coarse per-IP guard before the payment is decoded, then a per-payer bucket
  // once the payload is available. The per-payer limit is the product limit;
  // the IP limit only bounds unauthenticated abuse.
  const ipCreateLimiter = new RateLimiter(config.createIpRateBurst, config.createIpRateRefill);
  const createLimiter = new RateLimiter(config.createRateBurst, config.createRateRefill);

  // Read-only catalogue: what this deployment sells and what it runs.
  app.use(createCatalogueRouter(config));

  /* ---------------------------------------------------------------- */
  /* Create session (x402 protected)                                   */
  /* ---------------------------------------------------------------- */
  app.post(
    "/v1/sessions",
    rejectPlaintextBodies,
    createSessionHandler({
      config,
      controller,
      resourceServer: surface.resourceServer,
      settlementLookup: surface.settlementLookup,
      settlementVerifier: surface.settlementVerifier,
      requirementFor: surface.requirementFor,
      payment402: surface.payment402,
      capabilityFor: surface.capabilityFor,
      recoverCapability: surface.recoverCapability,
      ipCreateLimiter,
      createLimiter,
    }),
  );

  app.use(createSessionsRouter({ config, controller }));

  app.use(errorBackstop);
}
