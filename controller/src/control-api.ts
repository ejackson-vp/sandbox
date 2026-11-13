/**
 * Internal control API (controller-owned).
 *
 * Reached only by the API server, over the cluster network, with a shared
 * admin token and a NetworkPolicy that permits nothing else. It is never
 * exposed through the ingress path.
 *
 * All customer payloads here are opaque sealed-box envelopes; commands, file
 * contents and results never appear in this process.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import {
  httpMetricsMiddleware,
  INTERNAL_RATE_LIMIT,
  log,
  metrics,
  rateLimit,
  ReadinessCache,
  recordAuthFailure,
  registerRequestMetrics,
  TokenBucket,
  type ComponentCheck,
} from "@x402s/shared/runtime";
import { constantTimeEqual } from "./secrets.js";
import { createCapacityRouter } from "./capacity/routes.js";
import { registerAllowlistRoutes } from "./control-api/allowlist.js";
import { registerBudgetRoutes } from "./control-api/budgets.js";
import { registerChallengeNonceRoutes } from "./control-api/challenges.js";
import { registerPaymentRoutes } from "./control-api/payments.js";
import { registerSessionRoutes } from "./control-api/sessions.js";
import type { ControlApiDeps } from "./control-api/types.js";

export type { ControlApiDeps } from "./control-api/types.js";

export function createControlApi(deps: ControlApiDeps): express.Express {
  const { cfg } = deps;
  const app = express();
  app.disable("x-powered-by");
  registerRequestMetrics(metrics);
  app.use(httpMetricsMiddleware(metrics));
  app.use(express.json({ limit: "32mb" }));

  // Liveness only: if this handler runs, the event loop is turning. Kubernetes
  // restarts the process when this stops answering. Dependency health belongs
  // in /internal/readyz; a store or relay blip must not restart a live process.
  app.get("/internal/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  const readinessChecks: Record<string, ComponentCheck> = {
    store: async () => {
      const health = await deps.store.healthCheck();
      return health.ok ? { ok: true } : { ok: false, reason: health.reason };
    },
    relay: async () => {
      try {
        await deps.relay.health(1_500);
        return { ok: true };
      } catch {
        return { ok: false, reason: "unreachable" };
      }
    },
  };
  const provisionerHealth = deps.provisioner?.healthCheck?.bind(deps.provisioner);
  if (provisionerHealth) {
    readinessChecks.provisioner = async () => {
      try {
        await provisionerHealth();
        return { ok: true };
      } catch {
        return { ok: false, reason: "unreachable" };
      }
    };
  }
  // The Service must route to the writer, not to any replica that is up. A
  // follower reports 503 here, so the API never sends a create to a process that
  // will refuse the write.
  if (deps.leadership) {
    const leadership = deps.leadership;
    readinessChecks.leadership = () =>
      leadership.isLeader() ? { ok: true } : { ok: false, reason: "not_leader" };
  }
  // Holding the Lease is not the same as being able to write. Acquire enables
  // writes and then runs startup recovery; if recovery fails or hangs, the
  // leadership check is still true and the store may still look writable. This
  // keeps readiness false until the whole acquire step has settled.
  if (deps.acquireSettled) {
    const acquireSettled = deps.acquireSettled;
    readinessChecks.acquire = () =>
      acquireSettled() ? { ok: true } : { ok: false, reason: "not_acquired" };
  }
  const readiness = new ReadinessCache(readinessChecks);
  // A leadership change must be visible on the next probe, not after the TTL.
  deps.leadership?.onChange(() => readiness.invalidate());

  // Readiness: can this controller serve creates right now? Unauthenticated for
  // the same reason as liveness (kubelet has no admin token); the body contains
  // only bounded component states, never tokens, paths or session ids.
  app.get("/internal/readyz", async (_req, res) => {
    const report = await readiness.check();
    res.status(report.ok ? 200 : 503).json(report);
  });

  // Bound the authenticated control surface before any handler that reads the
  // store or forwards to the relay. Probe endpoints above stay unthrottled so a
  // saturated limiter can never make a healthy pod look unready. The key is the
  // socket peer (the API/relay pod), never a forwarded header.
  const internalLimiter =
    deps.internalRateLimiter ??
    new TokenBucket(
      INTERNAL_RATE_LIMIT.capacity,
      INTERNAL_RATE_LIMIT.refillPerSecond,
      INTERNAL_RATE_LIMIT.maxBuckets,
    );
  app.use("/internal", rateLimit(internalLimiter, "internal"));

  // A client certificate signed by the internal CA with CN=api is an
  // authenticated caller. Anything else must present the bearer token, which is
  // what the relay (wake) and in-cluster tooling use on the HTTP listener.
  const mtlsCn = (req: Request): string | undefined => {
    const socket = req.socket as {
      authorized?: boolean;
      getPeerCertificate?: () => { subject?: { CN?: string } };
    };
    if (socket.authorized !== true || typeof socket.getPeerCertificate !== "function") {
      return undefined;
    }
    return socket.getPeerCertificate().subject?.CN;
  };

  // The current token plus, during a rotation, the previous one. Accepting a
  // set is what lets the caller switch tokens without a window where one side
  // of the rollout is rejected; it does not weaken the check, and the previous
  // token is removed from the deployment as soon as the overlap ends.
  const adminTokens = [cfg.adminToken, cfg.adminTokenPrevious].filter(
    (token): token is string => Boolean(token),
  );
  const isAdminToken = (supplied: string): boolean =>
    adminTokens.some((token) => constantTimeEqual(supplied, token));

  // codeql[js/missing-rate-limiting] bounded by the TokenBucket middleware mounted above; CodeQL models only third-party limiter packages (security-review/FINDINGS.md F-16).
  app.post("/internal/wake", (req, res) => {
    // The relay holds only this token; it can nudge the reconciler but cannot
    // reach any other internal endpoint.
    const token = req.header("x-wake-token") ?? req.header("x-internal-token") ?? "";
    // The API holds the admin token; the relay holds only the wake token.
    const authorized =
      mtlsCn(req) === "api" ||
      (Boolean(cfg.wakeToken) && constantTimeEqual(token, cfg.wakeToken)) ||
      isAdminToken(token);
    if (!authorized) {
      recordAuthFailure("internal_token");
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    deps.wake?.();
    res.status(202).json({ ok: true });
  });

  // Aggregate metrics are served by the private METRICS_PORT listener; this
  // listener is reachable from the API and relay and must not expose them.

  // codeql[js/missing-rate-limiting] bounded by the TokenBucket middleware mounted above; CodeQL models only third-party limiter packages (security-review/FINDINGS.md F-16).
  app.use("/internal", (req: Request, res: Response, next: NextFunction) => {
    const token = req.header("x-internal-token") ?? "";
    const mtls = mtlsCn(req) === "api";
    if (!mtls && !isAdminToken(token)) {
      recordAuthFailure("internal_token");
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });
  app.use("/internal", createCapacityRouter(deps.capacity));

  /* ---------------- payment intent outbox ---------------- */

  registerPaymentRoutes(app, deps);

  registerChallengeNonceRoutes(app, deps);

  registerBudgetRoutes(app, deps);

  registerAllowlistRoutes(app, deps);

  registerSessionRoutes(app, deps);

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    // A body the parser rejected is the caller's fault, not an outage. The
    // public API's backstop already answers these two the same way, and the two
    // surfaces disagreed on the same malformed input until this did too.
    if (err.name === "PayloadTooLargeError" || (err as { type?: string }).type === "entity.too.large") {
      res.status(413).json({ error: "payload_too_large" });
      return;
    }
    if (err.name === "SyntaxError") {
      res.status(400).json({ error: "invalid_json" });
      return;
    }
    log.error("control_api_error", { error: err.message });
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}

