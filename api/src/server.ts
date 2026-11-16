/**
 * Public x402-protected API: the composition root.
 *
 * Invariants enforced by what is mounted here:
 *  - no accounts, no API keys, no cookies; access to a purchased session uses a
 *    short-lived possession capability whose SHA-256 hash is all the server keeps,
 *  - plaintext commands and file contents are never accepted: the only payload
 *    field is an opaque sealed-box `envelope`,
 *  - one settled payment creates at most one session (facilitator nonce +
 *    durable payment intent + UNIQUE payment key),
 *  - the API never logs bodies, headers or payment payloads.
 *
 * The phases live next door in `boot/`, because this function used to be 200
 * lines and 75% of the file: `boot/payment-surface.ts` builds the facilitator,
 * settle and verify half, `boot/metrics.ts` registers the families,
 * `boot/http-shell.ts` is the middleware and the probes, and `boot/routes.ts`
 * mounts the routes in the order they have to be mounted. What is left here is
 * the order itself.
 */
import express from "express";
import { createPaymentSurface } from "./boot/payment-surface.js";
import { applyMiddleware, mountProbes } from "./boot/http-shell.js";
import { mountRoutes } from "./boot/routes.js";
import { registerApiMetrics } from "./boot/metrics.js";
import type { ApiDeps } from "./boot/deps.js";

export async function createApp(deps: ApiDeps): Promise<express.Express> {
  const { config, controller } = deps;
  const app = express();
  app.disable("x-powered-by");
  // 0 = off. Set to 1 only where the API is reachable through exactly one
  // reverse proxy (the reference deployment's Tailscale L7 proxy), so `req.ip`
  // is the real client instead of the proxy pod, otherwise every remote client
  // shares one per-IP limiter bucket.
  app.set("trust proxy", config.trustProxyHops > 0 ? config.trustProxyHops : false);

  // Registered before the first route exists, so a scrape is useful before the
  // first event.
  const surface = await createPaymentSurface(deps);
  registerApiMetrics();
  applyMiddleware(app, config);
  mountProbes(app, config, controller);
  mountRoutes(app, deps, surface);
  return app;
}
