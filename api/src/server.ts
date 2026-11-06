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
import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import type { Network, PaymentRequirements } from "@x402/core/types";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  LATENCY_BUCKETS,
  MAX_LEASE_SECONDS,
  MOCK_NETWORK,
  MockExactServerScheme,
  PAYMENT_VERSION,
  formatUsd,
  paymentKey,
  resolveSessionSpec,
  safeEqualHex,
  metrics,
  sha256Hex,
  specHash,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type SessionStatus,
  type SessionLimits,
  type SessionSpec,
} from "@x402s/shared";
import { loadConfig, type ApiConfig } from "./config.js";
import { RateLimiter, paymentPayerKey } from "./admission.js";
import { ControllerClient, ControllerError, type SessionView } from "./controller-client.js";
import { HttpSettlementLookup, UnsupportedSettlementLookup, type SettlementLookup } from "./settlement-lookup.js";
import { log } from "./log.js";

const createSchema = z.object({
  tier: z.enum(["short", "standard", "extended", "long", "custom"]).optional(),
  durationSeconds: z.number().int().min(1).max(MAX_LEASE_SECONDS).optional(),
  cpuMillis: z.number().int().positive().optional(),
  memoryMiB: z.number().int().positive().optional(),
  diskMiB: z.number().int().positive().optional(),
  clientPublicKey: z.string().min(40).max(64),
  clientNonce: z.string().min(40).max(64),
  baselineCpuMillis: z.number().int().min(50).optional(),
  baselineMemoryMiB: z.number().int().min(64).optional(),
  idlePolicy: z
    .object({
      maxIdleSeconds: z.number().int().min(1).max(28800).optional(),
      suspendedDurationSeconds: z.number().int().min(1).max(28800).optional(),
      autoResume: z.boolean().optional(),
    })
    .optional(),
  maxLifetimeSeconds: z.number().int().min(1).max(28800).optional(),
});

const requestIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);

const operationSchema = z.object({
  requestId: requestIdSchema,
  envelope: z.string().min(1).max(16 * 1024 * 1024),
  timeoutMs: z.number().int().min(100).max(3_600_000).optional(),
  waitMs: z.number().int().min(0).max(120_000).optional(),
});

/** Fields that must never be accepted as JSON: they imply plaintext. */
const FORBIDDEN_FIELDS = [
  "code",
  "source",
  "script",
  "command",
  "args",
  "argv",
  "env",
  "cwd",
  "stdin",
  "stdout",
  "stderr",
  "content",
  "data",
  "plaintext",
];

function rejectPlaintextBodies(req: Request, res: Response, next: NextFunction): void {
  const body = req.body;
  if (body && typeof body === "object") {
    for (const field of FORBIDDEN_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        res.status(400).json({
          error: "plaintext_not_accepted",
          message:
            "this endpoint only accepts ciphertext; encrypt your operation for the attested guest key",
          field,
        });
        return;
      }
    }
  }
  next();
}

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
  const readLimiter = new RateLimiter(600, 40);

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

  const toStatus = (s: SessionView): SessionStatus => ({
    sessionId: s.sessionId,
    state: s.state,
    tier: s.tier,
    durationSeconds: s.durationSeconds,
    limits: s.limits,
    createdAt: new Date(s.createdAt).toISOString(),
    ...(s.paidAt ? { paidAt: new Date(s.paidAt).toISOString() } : {}),
    ...(s.readyAt ? { readyAt: new Date(s.readyAt).toISOString() } : {}),
    ...(s.leaseExpiresAt ? { leaseExpiresAt: new Date(s.leaseExpiresAt).toISOString() } : {}),
    remainingSeconds: s.remainingSeconds,
    ...(s.suspendedAt ? { suspendedAt: new Date(s.suspendedAt).toISOString() } : {}),
    ...(s.resumeCount ? { resumeCount: s.resumeCount } : {}),
    ...(s.maxLifetimeSeconds ? { maxLifetimeSeconds: s.maxLifetimeSeconds } : {}),
    ...(s.idlePolicy ? { idlePolicy: s.idlePolicy } : {}),
    ...(s.baseline ? { baseline: s.baseline } : {}),
    ...(s.terminatingAt ? { terminatingAt: new Date(s.terminatingAt).toISOString() } : {}),
    ...(s.destroyedAt ? { destroyedAt: new Date(s.destroyedAt).toISOString() } : {}),
    clientNonce: s.clientNonce,
    ...(s.guestPublicKey ? { guestPublicKey: s.guestPublicKey } : {}),
    ...(s.attestation ? { attestation: s.attestation } : {}),
    ...(s.failureCode ? { failure: { code: s.failureCode, message: s.failureMessage ?? s.failureCode } } : {}),
    ...(s.runtimeClass ? { runtimeClass: s.runtimeClass } : {}),
    ...(s.executionMode ? { executionMode: s.executionMode } : {}),
    busy: s.busy,
    ...(s.timings ? { timings: s.timings } : {}),
    payment: {
      mode: s.payment.mode,
      network: s.payment.network,
      scheme: s.payment.scheme,
      asset: s.payment.asset,
      amount: s.payment.amount,
      priceUsd: formatUsd(s.payment.amount),
      payTo: s.payment.payTo,
      ...(s.payment.payer ? { payer: s.payment.payer } : {}),
      ...(s.payment.transaction ? { transaction: s.payment.transaction } : {}),
    },
  });

  const createResponseFrom = (
    session: SessionView,
    capability: string,
    limits: SessionLimits,
  ): CreateSessionResponse => ({
    sessionId: session.sessionId,
    capability,
    state: session.state,
    tier: session.tier,
    durationSeconds: session.durationSeconds,
    limits,
    ...(session.baseline ? { baseline: session.baseline } : {}),
    capabilityExpiresAt: new Date(session.capabilityExpiresAt).toISOString(),
    clientNonce: session.clientNonce,
    payment: toStatus(session).payment,
  });

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

  app.post("/v1/sessions", rejectPlaintextBodies, async (req: Request, res: Response): Promise<void> => {
    const apiReceivedAt = Date.now();
    let paymentVerifyMs = 0;
    let paymentSettleMs = 0;
    res.on("finish", () => {
      metrics
        .histogram("sandbox_session_create_duration_seconds", "Create request duration", LATENCY_BUCKETS)
        .observe((Date.now() - apiReceivedAt) / 1000);
      metrics
        .counter("sandbox_sessions_created_total", "Session create requests by outcome")
        .inc({ result: res.statusCode < 300 ? "ok" : res.statusCode === 402 ? "payment_required" : "error" });
    });
    const sourceIp = req.ip ?? "unknown";
    if (!ipCreateLimiter.take(sourceIp)) {
      res.setHeader("Retry-After", String(ipCreateLimiter.retryAfterSeconds(sourceIp)));
      res.status(429).json({ error: "rate_limited", scope: "ip" });
      return;
    }
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const body: CreateSessionRequest = parsed.data;
    const resolution = resolveSessionSpec(body, config.tiers, config.platformLimits);
    if (!resolution.ok) {
      res.status(400).json({ error: resolution.code, message: resolution.message });
      return;
    }
    const { spec, priceUsd } = resolution;
    const requirement = await requirementFor(priceUsd, spec);
    const specDigest = specHash(spec);

    const header = req.header("PAYMENT-SIGNATURE") ?? req.header("X-PAYMENT");
    if (!header) {
      await payment402(res, requirement, "payment_required");
      return;
    }

    let payload;
    try {
      payload = decodePaymentSignatureHeader(header);
    } catch {
      await payment402(res, requirement, "malformed_payment_header");
      return;
    }
    if (payload.x402Version !== PAYMENT_VERSION) {
      await payment402(res, requirement, "unsupported_x402_version");
      return;
    }
    if (payload.accepted?.network !== config.network || payload.accepted?.amount !== requirement.amount) {
      await payment402(res, requirement, "payment_requirements_mismatch");
      return;
    }

    // Per-payer admission happens before the payment intent is claimed or the
    // payment is settled, so a throttled payer is never charged.
    const payerKey = paymentPayerKey(payload, sourceIp);
    if (!createLimiter.take(payerKey)) {
      res.setHeader("Retry-After", String(createLimiter.retryAfterSeconds(payerKey)));
      res.status(429).json({
        error: "rate_limited",
        scope: "payer",
        message: "this payer is creating sessions too quickly; retry after the advertised delay",
      });
      return;
    }

    const key = paymentKey(payload);
    const capability = capabilityFor(key);
    const capabilityHash = sha256Hex(capability);

    const claim = await controller.claimIntent(key, specDigest, config.intentStaleMs);
    if (claim.status === "in_progress") {
      res.status(409).json({ error: "payment_in_progress", message: "this payment is already being processed" });
      return;
    }
    if (claim.status === "failed") {
      await payment402(res, requirement, `payment_intent_failed:${claim.reason ?? "unknown"}`);
      return;
    }
    if (claim.status === "mismatch") {
      res.status(409).json({ error: "spec_mismatch", message: "this payment was made for a different session spec" });
      return;
    }
    if (claim.status === "settled") {
      const session = await controller.getSession(claim.sessionId).catch(() => null);
      if (!session) {
        res.status(409).json({ error: "entitlement_missing", sessionId: claim.sessionId });
        return;
      }
      log.info("payment_idempotent_replay", { sessionId: claim.sessionId, paymentKeyPrefix: key.slice(0, 12) });
      res.status(200).json(createResponseFrom(session, capability, session.limits));
      return;
    }

    const complete = async (settled: {
      payer?: string;
      transaction?: string;
    }): Promise<boolean> => {
      const sessionId = `sbx_${randomBytes(12).toString("hex")}`;
      // The capability outlives the lease by a small grace window so a client
      // can still read the final status / fetch a late result.
      // A suspended session can be resumed for its whole wall-clock lifetime,
      // so the capability must cover that window, not just the first lease.
      const capabilityLifetime = spec.maxLifetimeSeconds ?? spec.durationSeconds;
      const capabilityExpiresAt = Date.now() + (capabilityLifetime + config.capabilityTtlSeconds) * 1000;
      try {
        await controller.completeIntent(key, {
          sessionId,
          capabilityHash,
          capabilityExpiresAt,
          spec,
          clientPublicKey: body.clientPublicKey,
          clientNonce: body.clientNonce,
          timings: {
            apiReceivedAt,
            paymentVerifyMs,
            paymentSettleMs,
            entitlementMs: Date.now() - apiReceivedAt,
          },
          payment: {
            paymentKey: key,
            network: requirement.network,
            scheme: requirement.scheme,
            asset: requirement.asset,
            amount: requirement.amount,
            payTo: requirement.payTo,
            payer: settled.payer,
            transaction: settled.transaction,
            mode: config.paymentMode,
          },
        });
      } catch (err) {
        // A concurrent/recovered completion may have won the race. The
        // capability is derived from the same payment, so return that session.
        if (err instanceof ControllerError && err.status === 409) {
          const detail = err.detail as { sessionId?: string } | undefined;
          if (detail?.sessionId) {
            const existing = await controller.getSession(detail.sessionId).catch(() => null);
            if (existing) {
              res.status(200).json(createResponseFrom(existing, capability, existing.limits));
              return true;
            }
          }
        }
        log.error("entitlement_creation_failed", { error: (err as Error).message });
        res.status(503).json({ error: "provisioning_unavailable", message: "payment settled; contact support with your receipt" });
        return false;
      }
      void controller.wake();
      log.info("session_created", {
        sessionId,
        tier: spec.tier,
        durationSeconds: spec.durationSeconds,
        paymentKeyPrefix: key.slice(0, 12),
        payer: settled.payer,
      });
      const session = await controller.getSession(sessionId).catch(() => null);
      if (session) {
        res.status(201).json(createResponseFrom(session, capability, spec.limits));
      } else {
        res.status(201).json({
          sessionId,
          capability,
          state: "PAID",
          tier: spec.tier,
          durationSeconds: spec.durationSeconds,
          limits: spec.limits,
          capabilityExpiresAt: new Date(capabilityExpiresAt).toISOString(),
          clientNonce: body.clientNonce,
          payment: {
            mode: config.paymentMode,
            network: requirement.network,
            scheme: requirement.scheme,
            asset: requirement.asset,
            amount: requirement.amount,
            priceUsd: formatUsd(requirement.amount),
            payTo: requirement.payTo,
            payer: settled.payer,
            transaction: settled.transaction,
          },
        } satisfies CreateSessionResponse);
      }
      return true;
    };

    // Recovery path: a previous attempt may have settled before crashing.
    if (claim.recovered) {
      try {
        const existing = await settlementLookup.lookup(key);
        if (existing) {
          log.warn("payment_recovered_from_settlement", { paymentKeyPrefix: key.slice(0, 12) });
          await complete({ payer: existing.payer, transaction: existing.transaction });
          return;
        }
      } catch (err) {
        log.warn("settlement_lookup_failed", { error: (err as Error).message });
      }
    }

    let verify;
    const verifyStarted = Date.now();
    try {
      verify = await resourceServer.verifyPayment(payload, requirement);
      paymentVerifyMs = Date.now() - verifyStarted;
      metrics
        .histogram("sandbox_payment_verify_duration_seconds", "Facilitator payment verification", LATENCY_BUCKETS)
        .observe(paymentVerifyMs / 1000);
    } catch (err) {
      log.warn("payment_verify_error", { error: (err as Error).message });
      await payment402(res, requirement, "payment_verify_failed");
      return;
    }
    if (!verify.isValid) {
      await payment402(res, requirement, `payment_invalid:${verify.invalidReason ?? "unknown"}`);
      return;
    }

    try {
      const health = await controller.healthz();
      if (!health.ok) throw new Error("controller unhealthy");
    } catch {
      await controller.failIntent(key, "control_plane_unavailable").catch(() => undefined);
      res.status(503).json({ error: "provisioning_unavailable", message: "try again later; no payment was taken" });
      return;
    }

    let settle;
    const settleStarted = Date.now();
    try {
      settle = await resourceServer.settlePayment(payload, requirement);
      paymentSettleMs = Date.now() - settleStarted;
      metrics
        .histogram("sandbox_payment_settle_duration_seconds", "Facilitator settlement", LATENCY_BUCKETS)
        .observe(paymentSettleMs / 1000);
    } catch (err) {
      log.warn("payment_settle_error", { error: (err as Error).message });
      await controller.failIntent(key, "settle_error").catch(() => undefined);
      await payment402(res, requirement, "payment_settle_failed");
      return;
    }

    if (!settle.success) {
      // A nonce conflict may mean an earlier attempt settled but crashed before
      // the entitlement was durable. Recover instead of charging twice.
      if (settle.errorReason === "nonce_already_used" && settlementLookup.supported) {
        try {
          const existing = await settlementLookup.lookup(key);
          if (existing) {
            log.warn("payment_recovered_after_nonce_conflict", { paymentKeyPrefix: key.slice(0, 12) });
            await complete({ payer: existing.payer, transaction: existing.transaction });
            return;
          }
        } catch {
          /* fall through */
        }
      }
      await controller.failIntent(key, settle.errorReason ?? "settlement_rejected").catch(() => undefined);
      await payment402(res, requirement, `payment_settlement_rejected:${settle.errorReason ?? "unknown"}`);
      return;
    }

    await complete({ payer: settle.payer, transaction: settle.transaction });
  });

  /* ---------------------------------------------------------------- */
  /* Capability-protected endpoints                                    */
  /* ---------------------------------------------------------------- */
  const authorize = async (req: Request, res: Response): Promise<SessionView | null> => {
    if (!readLimiter.take(req.ip ?? "unknown")) {
      res.status(429).json({ error: "rate_limited" });
      return null;
    }
    const id = String(req.params.id ?? "");
    const capability = req.header("x-sandbox-capability");
    if (!capability || capability.length < 20 || capability.length > 128) {
      res.status(401).json({ error: "capability_required" });
      return null;
    }
    let session: SessionView;
    try {
      session = await controller.getSession(id);
    } catch (err) {
      if (err instanceof ControllerError && err.status === 404) {
        res.status(404).json({ error: "session_not_found" });
        return null;
      }
      log.error("session_lookup_failed", { error: (err as Error).message });
      res.status(503).json({ error: "control_plane_unavailable" });
      return null;
    }
    const presented = sha256Hex(capability);
    if (!safeEqualHex(presented, session.capabilityHash)) {
      res.status(404).json({ error: "session_not_found" });
      return null;
    }
    if (Date.now() > session.capabilityExpiresAt) {
      res.status(410).json({ error: "capability_expired" });
      return null;
    }
    return session;
  };

  app.get("/v1/sessions/:id", async (req, res) => {
    const session = await authorize(req, res);
    if (!session) return;
    res.json(toStatus(session));
  });

  /** Shared by exec and file operations: the API only sees ciphertext. */
  const runOperation = async (req: Request, res: Response, opHint: string): Promise<void> => {
    const session = await authorize(req, res);
    if (!session) return;
    if (session.state === "SUSPENDED") {
      res.status(409).json({
        error: "session_suspended",
        message: "resume the session before sending operations",
      });
      return;
    }
    const parsed = operationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    try {
      const waitMs =
        parsed.data.waitMs ??
        Math.min(
          120_000,
          (parsed.data.timeoutMs ?? config.platformLimits.maxCommandSeconds * 1000) + 5_000,
        );
      const out = await controller.operation(session.sessionId, {
        requestId: parsed.data.requestId,
        envelope: parsed.data.envelope,
        op: opHint,
        waitMs,
      });
      if (out.pending) {
        res.status(202).json({ state: out.state, requestId: out.requestId, pending: true });
        return;
      }
      res.json({ state: out.state, requestId: out.requestId, envelope: out.envelope });
    } catch (err) {
      if (err instanceof ControllerError) {
        const code = err.code;
        const status = code === "lease_expired" ? 410 : err.status;
        res.status(status).json({ error: code, message: err.message });
        return;
      }
      log.error("operation_failed", { error: (err as Error).message });
      res.status(503).json({ error: "control_plane_unavailable" });
    }
  };

  app.post("/v1/sessions/:id/exec", rejectPlaintextBodies, (req, res) => runOperation(req, res, "exec"));

  // Service and HTTP operations travel in the same opaque envelope. The API
  // never learns the command, port, headers or body.
  app.post("/v1/sessions/:id/services", rejectPlaintextBodies, (req, res) =>
    runOperation(req, res, "service"),
  );
  app.post("/v1/sessions/:id/services/list", rejectPlaintextBodies, (req, res) =>
    runOperation(req, res, "service"),
  );
  app.post("/v1/sessions/:id/services/stop", rejectPlaintextBodies, (req, res) =>
    runOperation(req, res, "service"),
  );
  app.post("/v1/sessions/:id/http", rejectPlaintextBodies, (req, res) =>
    runOperation(req, res, "http"),
  );
  app.post("/v1/sessions/:id/http/stream", rejectPlaintextBodies, (req, res) =>
    runOperation(req, res, "http"),
  );
  app.post("/v1/sessions/:id/http/stream/read", rejectPlaintextBodies, (req, res) =>
    runOperation(req, res, "http"),
  );
  app.post("/v1/sessions/:id/http/stream/close", rejectPlaintextBodies, (req, res) =>
    runOperation(req, res, "http"),
  );
  app.post("/v1/sessions/:id/ws/open", rejectPlaintextBodies, (req, res) =>
    runOperation(req, res, "ws"),
  );
  app.post("/v1/sessions/:id/ws/read", rejectPlaintextBodies, (req, res) =>
    runOperation(req, res, "ws"),
  );
  app.post("/v1/sessions/:id/ws/send", rejectPlaintextBodies, (req, res) =>
    runOperation(req, res, "ws"),
  );
  app.post("/v1/sessions/:id/ws/close", rejectPlaintextBodies, (req, res) =>
    runOperation(req, res, "ws"),
  );

  app.put("/v1/sessions/:id/files", rejectPlaintextBodies, (req, res) => runOperation(req, res, "file.put"));

  // Download/list/stat: the request (path and options) is inside the encrypted
  // envelope too, so the API never learns what is being read.
  app.get("/v1/sessions/:id/files", async (req, res) => {
    const session = await authorize(req, res);
    if (!session) return;
    const raw = req.query.request;
    const requestId = typeof req.query.requestId === "string" ? req.query.requestId : "";
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 2 * 1024 * 1024) {
      res.status(400).json({ error: "request_envelope_required" });
      return;
    }
    if (!requestIdSchema.safeParse(requestId).success) {
      res.status(400).json({ error: "invalid_request_id" });
      return;
    }
    const envelope = raw.includes("-") || raw.includes("_") ? Buffer.from(raw, "base64url").toString("base64") : raw;
    try {
      const out = await controller.operation(session.sessionId, {
        requestId,
        envelope,
        op: "file.get",
        waitMs: 60_000,
      });
      if (out.pending) {
        res.status(202).json({ state: out.state, requestId: out.requestId, pending: true });
        return;
      }
      res.json({ state: out.state, requestId: out.requestId, envelope: out.envelope });
    } catch (err) {
      if (err instanceof ControllerError) {
        res.status(err.status === 410 ? 410 : err.status).json({ error: err.code, message: err.message });
        return;
      }
      log.error("file_get_failed", { error: (err as Error).message });
      res.status(503).json({ error: "control_plane_unavailable" });
    }
  });

  app.get("/v1/sessions/:id/requests/:requestId", async (req, res) => {
    const session = await authorize(req, res);
    if (!session) return;
    const requestId = String(req.params.requestId ?? "");
    if (!requestIdSchema.safeParse(requestId).success) {
      res.status(400).json({ error: "invalid_request_id" });
      return;
    }
    const waitMs = Math.min(120_000, Number(req.query.waitMs) || 20_000);
    try {
      const out = await controller.getOperation(session.sessionId, requestId, waitMs);
      if (out.pending) {
        res.status(202).json({ state: out.state, requestId, pending: true });
        return;
      }
      res.json({ state: out.state, requestId, envelope: out.envelope });
    } catch (err) {
      if (err instanceof ControllerError) {
        res.status(err.status).json({ error: err.code, message: err.message });
        return;
      }
      res.status(503).json({ error: "control_plane_unavailable" });
    }
  });

  app.delete("/v1/sessions/:id/requests/:requestId", async (req, res) => {
    const session = await authorize(req, res);
    if (!session) return;
    const requestId = String(req.params.requestId ?? "");
    if (!requestIdSchema.safeParse(requestId).success) {
      res.status(400).json({ error: "invalid_request_id" });
      return;
    }
    try {
      await controller.cancelOperation(session.sessionId, requestId);
      res.status(202).json({ ok: true, requestId });
    } catch (err) {
      if (err instanceof ControllerError) {
        res.status(err.status).json({ error: err.code, message: err.message });
        return;
      }
      res.status(503).json({ error: "control_plane_unavailable" });
    }
  });

  app.post("/v1/sessions/:id/suspend", async (req, res) => {
    const session = await authorize(req, res);
    if (!session) return;
    try {
      const out = await controller.suspend(session.sessionId);
      res.json(toStatus(out));
    } catch (err) {
      if (err instanceof ControllerError) {
        res.status(err.status).json({ error: err.code, message: err.message });
        return;
      }
      res.status(503).json({ error: "control_plane_unavailable" });
    }
  });

  app.post("/v1/sessions/:id/resume", async (req, res) => {
    const session = await authorize(req, res);
    if (!session) return;
    try {
      const out = await controller.resume(session.sessionId);
      void controller.wake();
      res.status(202).json(toStatus(out));
    } catch (err) {
      if (err instanceof ControllerError) {
        res.status(err.status).json({ error: err.code, message: err.message });
        return;
      }
      res.status(503).json({ error: "control_plane_unavailable" });
    }
  });

  app.delete("/v1/sessions/:id", async (req, res) => {
    const session = await authorize(req, res);
    if (!session) return;
    try {
      const out = await controller.destroy(session.sessionId);
      void controller.wake();
      res.json({ state: out.state });
    } catch (err) {
      log.error("destroy_failed", { error: (err as Error).message });
      res.status(503).json({ error: "control_plane_unavailable" });
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
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
