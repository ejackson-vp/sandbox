/**
 * The HTTP shell every route sits inside: the metrics, connection cap, body
 * parser and request log, then the two probes.
 *
 * Order is the point. The metrics middleware is added before the body parser so
 * a malformed body is still attributed to its route; the connection cap is
 * added before the parser so a refused request costs no parse; and the probes
 * are mounted after both, because a saturated client must not be able to fail
 * readiness.
 */
import express from "express";
import {
  ReadinessCache,
  httpMetricsMiddleware,
  log,
  metrics,
} from "@x402s/shared/runtime";
import type { ApiConfig } from "../config.js";
import { createConnectionLimiter } from "../connection-limit.js";
import type { ControllerClient } from "../controller-client.js";

export function applyMiddleware(app: express.Express, config: ApiConfig): void {
  // Counts every request by route template, method and status.
  app.use(httpMetricsMiddleware(metrics));
  // Concurrent-request cap. Probes are exempt inside the limiter.
  app.use(
    createConnectionLimiter({
      maxPerClient: config.maxConnectionsPerClient,
      maxGlobal: config.maxConnectionsGlobal,
    }).middleware,
  );
  app.use(express.json({ limit: config.maxBodyBytes }));
  app.use((req, res, next) => {
    const started = Date.now();
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.on("finish", () => {
      log.info("request", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - started,
        ip: req.ip,
      });
    });
    next();
  });
}

export function mountProbes(
  app: express.Express,
  config: ApiConfig,
  controller: ControllerClient,
): void {
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, paymentMode: config.paymentMode, network: config.network });
  });

  // Readiness: the API holds no durable state, so its dependency is the
  // controller (which in turn checks the store, relay and provisioner). Do not
  // forward the controller's component detail: /readyz is reachable through the
  // ingress, while the controller's report is cluster-internal.
  const readiness = new ReadinessCache({
    controller: async () => {
      try {
        const report = await controller.readiness();
        return report.ok ? { ok: true } : { ok: false, reason: "not_ready" };
      } catch {
        return { ok: false, reason: "unreachable" };
      }
    },
  });

  app.get("/readyz", async (_req, res) => {
    const report = await readiness.check();
    res.status(report.ok ? 200 : 503).json(report);
  });

  // Aggregate metrics are published on the private METRICS_PORT listener, not
  // here: the ingress routes `/` to this port, so a public /metrics would leak
  // operational data to the tailnet.
}
