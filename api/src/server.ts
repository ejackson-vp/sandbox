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
import { ZodError } from "zod";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import type { Network, PaymentRequirements } from "@x402/core/types";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { mintCapability, recoverCapability } from "@x402s/shared/crypto";
import { MOCK_NETWORK, MockExactServerScheme } from "@x402s/shared/payment";
import type { SessionSpec } from "@x402s/shared/protocol";
import {
  HttpSettlementLookup,
  LATENCY_BUCKETS,
  ReadinessCache,
  UnsupportedSettlementLookup,
  httpMetricsMiddleware,
  log,
  metrics,
  registerRequestMetrics,
  type SettlementLookup,
} from "@x402s/shared/runtime";
import type { ApiConfig } from "./config.js";
import { RateLimiter } from "./admission.js";
import { ControllerClient } from "./controller-client.js";
import { buildSettlementVerifier } from "./payments/settlement-confirmation.js";
import type { ChainSettlementVerifier } from "./payments/settlement-verifier.js";
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

interface ApiDeps {
  config: ApiConfig;
  controller: ControllerClient;
  /** Injectable for tests: bypasses HTTP facilitator setup. */
  resourceServer?: x402ResourceServer;
  /** Injectable for tests. */
  settlementLookup?: SettlementLookup;
  /** Injectable for tests: bypasses the viem client. */
  settlementVerifier?: ChainSettlementVerifier;
}

export async function createApp(deps: ApiDeps): Promise<express.Express> {
  const { config, controller } = deps;
  const app = express();
  app.disable("x-powered-by");
  // 0 = off. Set to 1 only where the API is reachable through exactly one
  // reverse proxy (the homelab's Tailscale L7 proxy), so `req.ip` is the real
  // client instead of the proxy pod — otherwise every remote client shares one
  // per-IP limiter bucket.
  app.set("trust proxy", config.trustProxyHops > 0 ? config.trustProxyHops : false);

  const settlementLookup: SettlementLookup =
    deps.settlementLookup ??
    (config.paymentMode === "mock"
      ? new HttpSettlementLookup(config.facilitatorUrl)
      : new UnsupportedSettlementLookup());

  // F-10: a chain read is authoritative and needs no facilitator answer, so it
  // replaces the unsupported lookup for EVM networks. Absent here, the previous
  // behaviour is unchanged.
  const settlementVerifier = deps.settlementVerifier ?? buildSettlementVerifier(config);

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
      // Testnet and mainnet register the same scheme against the configured
      // network, so enabling mainnet is a configuration change, not a code
      // change: Base Sepolia today, Base mainnet when PAYMENT_MODE=mainnet.
      resourceServer.register(config.network as Network, new ExactEvmScheme());
    }
  }
  await retry(
    () => resourceServer.initialize(),
    Number(process.env.FACILITATOR_INIT_TIMEOUT_MS ?? 60_000),
    "facilitator initialization",
  );

  // Register metric families eagerly so a scrape is useful before the first
  // event. HTTP/auth/rate-limit families live in shared so every role has the
  // same names.
  registerRequestMetrics(metrics);
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

  // Counts every request by route template, method and status. Added before
  // the body parser so a malformed body is still attributed to its route.
  app.use(httpMetricsMiddleware(metrics));
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

  const payment402 = async (res: Response, requirement: PaymentRequirements, error: string) => {
    // One fresh, single-use challenge per 402 (#47). The value is bound into the
    // signed client commitment, so the wallet signature is only good for this
    // challenge. Merge into `extra` rather than replacing it: @x402/evm keeps
    // the token's EIP-712 domain fields there.
    let challenge: { nonce: string; expiresAt: number };
    try {
      challenge = await controller.issueChallengeNonce();
    } catch (err) {
      log.error("challenge_nonce_unavailable", { error: (err as Error).message });
      res.setHeader("Retry-After", "2");
      res.status(503).json({ error: "challenge_unavailable", retryable: true, message: "try again shortly" });
      return;
    }
    const withNonce: PaymentRequirements = {
      ...requirement,
      extra: { ...(requirement.extra ?? {}), challengeNonce: challenge.nonce },
    };
    const required = await resourceServer.createPaymentRequiredResponse([withNonce], resourceInfo, error);
    res
      .status(402)
      .setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(required))
      .json({
        ...required,
        error,
        // Also top-level: a client can read it without unpacking `accepts`.
        challengeNonce: challenge.nonce,
        challengeNonceExpiresAt: new Date(challenge.expiresAt).toISOString(),
      });
  };

  // Bound to the payment *and* the client commitment: the same receipt with a
  // different client key derives a different capability. Signed with the
  // current key of the ring; see docs/runbooks/secret-rotation.md.
  const capabilityFor = (key: string, commitment: string): string =>
    mintCapability(config.capabilityKeys.signing, key, commitment);

  // A replay must hand back the token the client already holds, which may have
  // been signed by the previous key. Null means no key in the ring can produce
  // the stored hash, i.e. the signing key was retired too early.
  const recoverCapabilityFor = (key: string, commitment: string, storedHash: string): string | null =>
    recoverCapability(config.capabilityKeys, key, commitment, storedHash);

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
      settlementVerifier,
      requirementFor,
      payment402,
      capabilityFor,
      recoverCapability: recoverCapabilityFor,
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
