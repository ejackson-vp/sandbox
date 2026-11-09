/**
 * Public x402-protected API.
 *
 * Invariants enforced here:
 *  - no accounts, no API keys, no cookies; access to a purchased session uses a
 *    short-lived possession capability whose SHA-256 hash is all the server keeps,
 *  - plaintext commands and file contents are never accepted: the only payload
 *    field is an opaque sealed-box `envelope`,
 *  - one settled payment creates at most one session (facilitator nonce +
 *    durable payment intent + UNIQUE payment key),
 *  - the API never logs bodies, headers or payment payloads.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { createHmac } from "node:crypto";
import { ZodError } from "zod";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import type { Network, PaymentRequirements } from "@x402/core/types";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  LATENCY_BUCKETS,
  MOCK_NETWORK,
  MockExactServerScheme,
  metrics,
  type SessionSpec,
} from "@x402s/shared";
import type { ApiConfig } from "./config.js";
import { RateLimiter } from "./admission.js";
import { ControllerClient } from "./controller-client.js";
import { HttpSettlementLookup, UnsupportedSettlementLookup, type SettlementLookup } from "./settlement-lookup.js";
import { log } from "./log.js";
import { rejectPlaintextBodies } from "./schemas.js";
import { createSessionsRouter } from "./routes/sessions.js";
import { createSessionHandler } from "./routes/create-session.js";

async function retry<T>(fn: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  let delay = 250;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      log.warn("dependency_not_ready", { dependency: label, error: (err as Error).message });
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 5000);
    }
  }
  throw new Error(`${label} did not become available: ${(lastErr as Error)?.message ?? "timeout"}`);
}

export interface ApiDeps {
  config: ApiConfig;
  controller: ControllerClient;
  /** Injectable for tests: bypasses HTTP facilitator setup. */
  resourceServer?: x402ResourceServer;
  /** Injectable for tests. */
  settlementLookup?: SettlementLookup;
}

export async function createApp(deps: ApiDeps): Promise<express.Express> {
  const { config, controller } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);

  const settlementLookup: SettlementLookup =
    deps.settlementLookup ??
    (config.paymentMode === "mock"
      ? new HttpSettlementLookup(config.facilitatorUrl)
      : new UnsupportedSettlementLookup());

  const resourceServer =
    deps.resourceServer ??
    (() => {
      const client = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
      const s = new x402ResourceServer(client);
      return s;
    })();

  if (!deps.resourceServer) {
    if (config.paymentMode === "mock") {
      resourceServer.register(MOCK_NETWORK, new MockExactServerScheme());
    } else {
      resourceServer.register("eip155:84532", new ExactEvmScheme());
    }
  }
  await retry(
    () => resourceServer.initialize(),
    Number(process.env.FACILITATOR_INIT_TIMEOUT_MS ?? 60_000),
    "facilitator initialization",
  );

  // Register metric families eagerly so /metrics is useful before the first event.
  metrics.histogram("sandbox_payment_verify_duration_seconds", "Facilitator payment verification", LATENCY_BUCKETS);
  metrics.histogram("sandbox_payment_settle_duration_seconds", "Facilitator settlement", LATENCY_BUCKETS);
  metrics.histogram("sandbox_session_create_duration_seconds", "Create request duration", LATENCY_BUCKETS);
  metrics.counter("sandbox_sessions_created_total", "Session create requests by outcome");

  const resourceInfo = {
    url: `${config.publicBaseUrl}/v1/sessions`,
    description: "A temporary Linux sandbox session purchased with x402",
    mimeType: "application/json",
    serviceName: "x402 sandbox sessions",
  };

  // Payment requirements are built per price (tiers have different prices).
  const requirementCache = new Map<string, PaymentRequirements>();
  const requirementFor = async (priceUsd: string, spec: SessionSpec): Promise<PaymentRequirements> => {
    const key = `${priceUsd}|${spec.tier}|${spec.durationSeconds}`;
    const cached = requirementCache.get(key);
    if (cached) return cached;
    const built = await resourceServer.buildPaymentRequirements({
      scheme: "exact",
      network: config.network as Network,
      payTo: config.payTo,
      price: priceUsd,
      maxTimeoutSeconds: 300,
      extra: { tier: spec.tier, durationSeconds: spec.durationSeconds },
    });
    const requirement = built[0];
    if (!requirement) throw new Error("failed to build payment requirements");
    requirementCache.set(key, requirement);
    return requirement;
  };

  // Coarse per-IP guard before the payment is decoded, then a per-payer bucket
  // once the payload is available. The per-payer limit is the product limit;
  // the IP limit only bounds unauthenticated abuse.
  const ipCreateLimiter = new RateLimiter(config.createIpRateBurst, config.createIpRateRefill);
  const createLimiter = new RateLimiter(config.createRateBurst, config.createRateRefill);

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
      });
    });
    next();
  });

  const payment402 = async (res: Response, requirement: PaymentRequirements, error: string) => {
    const required = await resourceServer.createPaymentRequiredResponse([requirement], resourceInfo, error);
    res
      .status(402)
      .setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(required))
      .json({ ...required, error });
  };

  const capabilityFor = (key: string): string =>
    createHmac("sha256", config.capabilitySecret).update(`x402-capability:${key}`).digest("base64url");

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, paymentMode: config.paymentMode, network: config.network });
  });

  // Aggregate metrics only; bounded labels, no session ids or payload data.
  app.get("/metrics", (_req, res) => {
    res.setHeader("content-type", "text/plain; version=0.0.4");
    res.send(metrics.render());
  });

  app.get("/v1/pricing", (_req, res) => {
    res.json({
      paymentMode: config.paymentMode,
      network: config.network,
      scheme: "exact",
      asset: config.paymentMode === "mock" ? "mock:usdc" : "USDC",
      payTo: config.payTo,
      tiers: Object.fromEntries(
        Object.entries(config.tiers).map(([name, t]) => [
          name,
          {
            durationSeconds: t.durationSeconds,
            priceUsd: t.priceUsd,
            cpuMillis: t.cpuMillis,
            memoryMiB: t.memoryMiB,
            diskMiB: t.diskMiB,
          },
        ]),
      ),
      customSessions: {
        allowed: config.platformLimits.allowCustom,
        maxLeaseSeconds: config.platformLimits.maxLeaseSeconds,
        maxCpuMillis: config.platformLimits.maxCpuMillis,
        maxMemoryMiB: config.platformLimits.maxMemoryMiB,
        maxDiskMiB: config.platformLimits.maxDiskMiB,
        maxCommandSeconds: config.platformLimits.maxCommandSeconds,
        maxFileBytes: config.platformLimits.maxFileBytes,
        maxOutputBytes: config.platformLimits.maxOutputBytes,
      },
    });
  });

  /* ---------------------------------------------------------------- */
  /* Create session (x402 protected)                                   */
  /* ---------------------------------------------------------------- */
  // Read-only image catalog. One operator-pinned guest image today; the
  // endpoint establishes the lifecycle noun and surfaces the digest.
  app.get("/v1/images", (_req, res) => {
    res.json({
      images: [
        {
          id: "guest",
          digest: process.env.GUEST_IMAGE_DIGEST ?? "sha256:dev-unpinned-image",
          reference: process.env.GUEST_IMAGE ?? "x402-sandbox/guest:dev",
          runtimeClass: process.env.RUNTIME_CLASS ?? "x402-sandbox",
          executionMode: process.env.EXECUTION_MODE ?? "dev",
          current: true,
        },
      ],
    });
  });

  app.post(
    "/v1/sessions",
    rejectPlaintextBodies,
    createSessionHandler({
      config,
      controller,
      resourceServer,
      settlementLookup,
      requirementFor,
      payment402,
      capabilityFor,
      ipCreateLimiter,
      createLimiter,
    }),
  );

  app.use(createSessionsRouter({ config, controller }));

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    // Every current route uses safeParse and answers 400 itself. This is the
    // backstop for a handler that throws a schema error instead: a validation
    // failure is a client error, never a 500.
    if (err instanceof ZodError) {
      res.status(400).json({ error: "invalid_request", issues: err.issues });
      return;
    }
    if (err.name === "PayloadTooLargeError" || (err as { type?: string }).type === "entity.too.large") {
      res.status(413).json({ error: "payload_too_large" });
      return;
    }
    if (err.name === "SyntaxError") {
      res.status(400).json({ error: "invalid_json" });
      return;
    }
    log.error("unhandled_error", { error: err.message });
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
