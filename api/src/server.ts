/**
 * Public x402-protected API.
 *
 * Invariants enforced here:
 *  - No accounts, no API keys, no cookies. Access to a purchased sandbox uses a
 *    short-lived possession capability whose SHA-256 hash is all the server keeps.
 *  - Plaintext customer code is never accepted: the only execution field is an
 *    opaque sealed-box `envelope`.
 *  - One settled payment creates at most one entitlement (facilitator nonce +
 *    controller-side unique payment key).
 *  - The API never logs bodies or payment payloads.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  MAX_DURATION_SECONDS,
  MOCK_NETWORK,
  MockExactServerScheme,
  PAYMENT_VERSION,
  formatUsd,
  paymentKey,
  safeEqualHex,
  sha256Hex,
  type CreateSandboxRequest,
  type SandboxStatus,
  type SandboxState,
} from "@x402s/shared";
import { loadConfig, type ApiConfig } from "./config.js";
import { ControllerClient, ControllerError, type SessionView } from "./controller-client.js";
import { log } from "./log.js";

const createSchema = z.object({
  durationSeconds: z.number().int().min(1).max(MAX_DURATION_SECONDS),
  clientPublicKey: z.string().min(40).max(64),
  clientNonce: z.string().min(40).max(64),
  language: z.literal("python3"),
});

const executeSchema = z.object({
  envelope: z.string().min(1).max(1_500_000),
});

/** Fields that must never be accepted as normal JSON: they imply plaintext. */
const FORBIDDEN_FIELDS = ["code", "source", "script", "stdout", "stderr", "plaintext"];

function rejectPlaintextBodies(req: Request, res: Response, next: NextFunction): void {
  const body = req.body;
  if (body && typeof body === "object") {
    for (const field of FORBIDDEN_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        res.status(400).json({
          error: "plaintext_not_accepted",
          message:
            "this endpoint only accepts ciphertext; encrypt your payload for the attested guest key",
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

class RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number }>();
  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {}
  take(key: string): boolean {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, updated: now };
    const elapsed = (now - b.updated) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSecond);
    b.updated = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) this.buckets.clear();
    return true;
  }
}

export interface ApiDeps {
  config: ApiConfig;
  controller: ControllerClient;
  /** Injectable for tests: bypasses HTTP facilitator setup. */
  resourceServer?: x402ResourceServer;
}

export async function createApp(deps: ApiDeps): Promise<express.Express> {
  const { config, controller } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);

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
  // The facilitator may still be starting when the API comes up (rolling
  // deploy). Retry rather than crash-looping.
  await retry(
    () => resourceServer.initialize(),
    Number(process.env.FACILITATOR_INIT_TIMEOUT_MS ?? 60_000),
    "facilitator initialization",
  );

  const built = await resourceServer.buildPaymentRequirements({
    scheme: "exact",
    network: config.network as Network,
    payTo: config.payTo,
    price: config.priceUsd,
    maxTimeoutSeconds: 300,
  });
  const requirement = built[0];
  if (!requirement) throw new Error("failed to build payment requirements");

  const resourceInfo = {
    url: `${config.publicBaseUrl}/v1/sandboxes`,
    description: "One confidential sandbox execution session, up to 60 seconds",
    mimeType: "application/json",
    serviceName: "x402 confidential sandbox",
  };

  const createLimiter = new RateLimiter(30, 1);
  const readLimiter = new RateLimiter(240, 20);

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

  const payment402 = async (res: Response, error: string) => {
    const required = await resourceServer.createPaymentRequiredResponse(
      [requirement],
      resourceInfo,
      error,
    );
    res
      .status(402)
      .setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(required))
      .json({ ...required, error });
  };

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, paymentMode: config.paymentMode, network: config.network });
  });

  app.get("/v1/pricing", (_req, res) => {
    res.json({
      priceUsd: config.priceUsd,
      amount: requirement.amount,
      asset: requirement.asset,
      network: requirement.network,
      scheme: requirement.scheme,
      payTo: config.payTo,
      maxDurationSeconds: MAX_DURATION_SECONDS,
      paymentMode: config.paymentMode,
    });
  });

  /* ---------------------------------------------------------------- */
  /* Create sandbox (x402 protected)                                   */
  /* ---------------------------------------------------------------- */
  app.post(
    "/v1/sandboxes",
    rejectPlaintextBodies,
    async (req: Request, res: Response): Promise<void> => {
      const ip = req.ip ?? "unknown";
      if (!createLimiter.take(ip)) {
        res.status(429).json({ error: "rate_limited" });
        return;
      }

      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const body: CreateSandboxRequest = parsed.data;

      const header = req.header("PAYMENT-SIGNATURE") ?? req.header("X-PAYMENT");
      if (!header) {
        await payment402(res, "payment_required");
        return;
      }

      let payload;
      try {
        payload = decodePaymentSignatureHeader(header);
      } catch {
        await payment402(res, "malformed_payment_header");
        return;
      }
      if (payload.x402Version !== PAYMENT_VERSION) {
        await payment402(res, "unsupported_x402_version");
        return;
      }
      if (payload.accepted?.network !== config.network || payload.accepted?.amount !== requirement.amount) {
        await payment402(res, "payment_requirements_mismatch");
        return;
      }

      // 1) Verify (cryptographic + business checks, no state change).
      let verify;
      try {
        verify = await resourceServer.verifyPayment(payload, requirement);
      } catch (err) {
        log.warn("payment_verify_error", { error: (err as Error).message });
        await payment402(res, "payment_verify_failed");
        return;
      }
      if (!verify.isValid) {
        await payment402(res, `payment_invalid:${verify.invalidReason ?? "unknown"}`);
        return;
      }

      // 1b) Pre-flight: never charge a customer when the control plane cannot
      //     provision. This narrows (but cannot eliminate) the settle-without-
      //     entitlement window; production needs a settlement outbox.
      try {
        const health = await controller.healthz();
        if (!health.ok) throw new Error("controller unhealthy");
      } catch {
        res.status(503).json({ error: "provisioning_unavailable", message: "try again later; no payment was taken" });
        return;
      }

      // 2) Settle. The facilitator (or the chain) enforces single-use nonces, so
      //    concurrent duplicates cannot both settle.
      let settle;
      try {
        settle = await resourceServer.settlePayment(payload, requirement);
      } catch (err) {
        log.warn("payment_settle_error", { error: (err as Error).message });
        await payment402(res, "payment_settle_failed");
        return;
      }
      if (!settle.success) {
        await payment402(res, `payment_settlement_rejected:${settle.errorReason ?? "unknown"}`);
        return;
      }

      // 3) Atomically create the entitlement. Payment key is UNIQUE.
      const capability = randomBytes(32).toString("base64url");
      const capabilityHash = sha256Hex(capability);
      const sessionId = `sbx_${randomBytes(12).toString("hex")}`;
      const capabilityExpiresAt = Date.now() + config.capabilityTtlSeconds * 1000;

      let entitlement;
      try {
        entitlement = await controller.createEntitlement({
          sessionId,
          capabilityHash,
          capabilityExpiresAt,
          durationSeconds: body.durationSeconds,
          clientPublicKey: body.clientPublicKey,
          clientNonce: body.clientNonce,
          payment: {
            paymentKey: paymentKey(payload),
            network: requirement.network,
            scheme: requirement.scheme,
            asset: requirement.asset,
            amount: requirement.amount,
            payTo: requirement.payTo,
            payer: settle.payer,
            transaction: settle.transaction,
            mode: config.paymentMode,
          },
        });
      } catch (err) {
        if (err instanceof ControllerError && err.status === 409) {
          // Payment was already redeemed (or is being redeemed concurrently).
          res.status(409).json({
            error: "payment_already_redeemed",
            message: "this payment has already funded a sandbox; one payment buys one execution",
          });
          return;
        }
        log.error("entitlement_creation_failed", { error: (err as Error).message });
        res.status(503).json({ error: "provisioning_unavailable" });
        return;
      }

      log.info("sandbox_created", {
        sandboxId: sessionId,
        paymentKeyPrefix: paymentKey(payload).slice(0, 12),
        payer: settle.payer,
        durationSeconds: body.durationSeconds,
        state: entitlement.state,
      });

      res.status(201).json({
        sandboxId: sessionId,
        capability,
        state: entitlement.state,
        durationSeconds: body.durationSeconds,
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
          payer: settle.payer,
          transaction: settle.transaction,
        },
      });
    },
  );

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
        res.status(404).json({ error: "sandbox_not_found" });
        return null;
      }
      log.error("session_lookup_failed", { error: (err as Error).message });
      res.status(503).json({ error: "control_plane_unavailable" });
      return null;
    }
    const presented = sha256Hex(capability);
    if (!safeEqualHex(presented, session.capabilityHash)) {
      // Same response for "wrong capability" and "unknown session": no oracle.
      res.status(404).json({ error: "sandbox_not_found" });
      return null;
    }
    if (Date.now() > session.capabilityExpiresAt) {
      res.status(410).json({ error: "capability_expired" });
      return null;
    }
    return session;
  };

  const toStatus = (s: SessionView): SandboxStatus => ({
    sandboxId: s.sessionId,
    state: s.state as SandboxState,
    durationSeconds: s.durationSeconds,
    createdAt: new Date(s.createdAt).toISOString(),
    ...(s.paidAt ? { paidAt: new Date(s.paidAt).toISOString() } : {}),
    ...(s.readyAt ? { readyAt: new Date(s.readyAt).toISOString() } : {}),
    ...(s.executionDeadlineAt
      ? { executionDeadline: new Date(s.executionDeadlineAt).toISOString() }
      : {}),
    ...(s.completedAt ? { completedAt: new Date(s.completedAt).toISOString() } : {}),
    ...(s.destroyedAt ? { destroyedAt: new Date(s.destroyedAt).toISOString() } : {}),
    clientNonce: s.clientNonce,
    ...(s.guestPublicKey ? { guestPublicKey: s.guestPublicKey } : {}),
    ...(s.attestation ? { attestation: s.attestation as SandboxStatus["attestation"] } : {}),
    ...(s.failureCode
      ? { failure: { code: s.failureCode, message: s.failureMessage ?? s.failureCode } }
      : {}),
    ...(s.runtimeClass ? { runtimeClass: s.runtimeClass } : {}),
    ...(s.executionMode ? { executionMode: s.executionMode } : {}),
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

  app.get("/v1/sandboxes/:id", async (req, res) => {
    const session = await authorize(req, res);
    if (!session) return;
    res.json(toStatus(session));
  });

  app.post("/v1/sandboxes/:id/execute", rejectPlaintextBodies, async (req, res) => {
    const session = await authorize(req, res);
    if (!session) return;
    const parsed = executeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    if (session.state === "COMPLETED" || session.state === "DESTROYED") {
      res.status(409).json({ error: "session_finished", state: session.state });
      return;
    }
    if (session.state === "EXPIRED" || session.state === "FAILED") {
      res.status(410).json({ error: "session_no_longer_usable", state: session.state });
      return;
    }
    if (session.state !== "READY" && session.state !== "RUNNING") {
      res.status(409).json({ error: "not_ready", state: session.state });
      return;
    }
    try {
      const out = await controller.execute(session.sessionId, parsed.data.envelope);
      log.info("execution_submitted", {
        sandboxId: session.sessionId,
        envelopeBytes: Buffer.from(parsed.data.envelope, "base64").length,
      });
      res.status(202).json(out);
    } catch (err) {
      if (err instanceof ControllerError) {
        res.status(err.status).json({ error: err.code, message: err.message });
        return;
      }
      log.error("execute_failed", { error: (err as Error).message });
      res.status(503).json({ error: "control_plane_unavailable" });
    }
  });

  app.get("/v1/sandboxes/:id/result", async (req, res) => {
    const session = await authorize(req, res);
    if (!session) return;
    try {
      const out = await controller.result(session.sessionId);
      if (out.envelope) {
        res.json({ state: out.state, envelope: out.envelope });
        return;
      }
      res.status(202).json({ state: out.state });
    } catch (err) {
      if (err instanceof ControllerError) {
        res.status(err.status).json({ error: err.code, message: err.message });
        return;
      }
      log.error("result_fetch_failed", { error: (err as Error).message });
      res.status(503).json({ error: "control_plane_unavailable" });
    }
  });

  app.delete("/v1/sandboxes/:id", async (req, res) => {
    const session = await authorize(req, res);
    if (!session) return;
    try {
      const out = await controller.destroy(session.sessionId);
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
