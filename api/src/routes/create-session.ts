/**
 * Create-session route: the x402 handshake, verification, settlement and
 * entitlement completion. All customer payloads remain sealed envelopes.
 */
import type { Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { x402ResourceServer } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import {
  LATENCY_BUCKETS,
  PAYMENT_VERSION,
  formatUsd,
  metrics,
  paymentKey,
  resolveSessionSpec,
  sha256Hex,
  specHash,
  type CreateSessionResponse,
  type CreateSessionRequest,
  type SessionSpec,
} from "@x402s/shared";
import type { ApiConfig } from "../config.js";
import { ControllerError, type ControllerClient } from "../controller-client.js";
import { createSchema } from "../schemas.js";
import { RateLimiter, paymentPayerKey } from "../admission.js";
import type { SettlementLookup } from "../settlement-lookup.js";
import { createResponseFrom } from "../status.js";
import { log } from "../log.js";

export interface CreateSessionDeps {
  config: ApiConfig;
  controller: ControllerClient;
  resourceServer: x402ResourceServer;
  settlementLookup: SettlementLookup;
  requirementFor(priceUsd: string, spec: SessionSpec): Promise<PaymentRequirements>;
  payment402(res: Response, requirement: PaymentRequirements, error: string): Promise<void>;
  capabilityFor(key: string): string;
  ipCreateLimiter: RateLimiter;
  createLimiter: RateLimiter;
}

export function createSessionHandler(deps: CreateSessionDeps) {
  return async (req: Request, res: Response): Promise<void> => {
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
    if (!deps.ipCreateLimiter.take(sourceIp)) {
      res.setHeader("Retry-After", String(deps.ipCreateLimiter.retryAfterSeconds(sourceIp)));
      res.status(429).json({ error: "rate_limited", scope: "ip" });
      return;
    }
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const body: CreateSessionRequest = parsed.data;
    const resolution = resolveSessionSpec(body, deps.config.tiers, deps.config.platformLimits);
    if (!resolution.ok) {
      res.status(400).json({ error: resolution.code, message: resolution.message });
      return;
    }
    const { spec, priceUsd } = resolution;
    const requirement = await deps.requirementFor(priceUsd, spec);
    const specDigest = specHash(spec);

    const header = req.header("PAYMENT-SIGNATURE") ?? req.header("X-PAYMENT");
    if (!header) {
      await deps.payment402(res, requirement, "payment_required");
      return;
    }

    let payload;
    try {
      payload = decodePaymentSignatureHeader(header);
    } catch {
      await deps.payment402(res, requirement, "malformed_payment_header");
      return;
    }
    if (payload.x402Version !== PAYMENT_VERSION) {
      await deps.payment402(res, requirement, "unsupported_x402_version");
      return;
    }
    if (payload.accepted?.network !== deps.config.network || payload.accepted?.amount !== requirement.amount) {
      await deps.payment402(res, requirement, "payment_requirements_mismatch");
      return;
    }

    // Per-payer admission happens before the payment intent is claimed or the
    // payment is settled, so a throttled payer is never charged.
    const payerKey = paymentPayerKey(payload, sourceIp);
    if (!deps.createLimiter.take(payerKey)) {
      res.setHeader("Retry-After", String(deps.createLimiter.retryAfterSeconds(payerKey)));
      res.status(429).json({
        error: "rate_limited",
        scope: "payer",
        message: "this payer is creating sessions too quickly; retry after the advertised delay",
      });
      return;
    }

    const key = paymentKey(payload);
    const capability = deps.capabilityFor(key);
    const capabilityHash = sha256Hex(capability);

    const claim = await deps.controller.claimIntent(key, specDigest, deps.config.intentStaleMs);
    if (claim.status === "in_progress") {
      res.status(409).json({ error: "payment_in_progress", message: "this payment is already being processed" });
      return;
    }
    if (claim.status === "failed") {
      await deps.payment402(res, requirement, `payment_intent_failed:${claim.reason ?? "unknown"}`);
      return;
    }
    if (claim.status === "mismatch") {
      res.status(409).json({ error: "spec_mismatch", message: "this payment was made for a different session spec" });
      return;
    }
    if (claim.status === "settled") {
      const session = await deps.controller.getSession(claim.sessionId).catch(() => null);
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
      const capabilityExpiresAt = Date.now() + (capabilityLifetime + deps.config.capabilityTtlSeconds) * 1000;
      try {
        await deps.controller.completeIntent(key, {
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
            mode: deps.config.paymentMode,
          },
        });
      } catch (err) {
        // A concurrent/recovered completion may have won the race. The
        // capability is derived from the same payment, so return that session.
        if (err instanceof ControllerError && err.status === 409) {
          const detail = err.detail as { sessionId?: string } | undefined;
          if (detail?.sessionId) {
            const existing = await deps.controller.getSession(detail.sessionId).catch(() => null);
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
      void deps.controller.wake();
      log.info("session_created", {
        sessionId,
        tier: spec.tier,
        durationSeconds: spec.durationSeconds,
        paymentKeyPrefix: key.slice(0, 12),
        payer: settled.payer,
      });
      const session = await deps.controller.getSession(sessionId).catch(() => null);
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
            mode: deps.config.paymentMode,
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
        const existing = await deps.settlementLookup.lookup(key);
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
      verify = await deps.resourceServer.verifyPayment(payload, requirement);
      paymentVerifyMs = Date.now() - verifyStarted;
      metrics
        .histogram("sandbox_payment_verify_duration_seconds", "Facilitator payment verification", LATENCY_BUCKETS)
        .observe(paymentVerifyMs / 1000);
    } catch (err) {
      log.warn("payment_verify_error", { error: (err as Error).message });
      await deps.payment402(res, requirement, "payment_verify_failed");
      return;
    }
    if (!verify.isValid) {
      await deps.payment402(res, requirement, `payment_invalid:${verify.invalidReason ?? "unknown"}`);
      return;
    }

    try {
      const health = await deps.controller.healthz();
      if (!health.ok) throw new Error("controller unhealthy");
    } catch {
      await deps.controller.failIntent(key, "control_plane_unavailable").catch(() => undefined);
      res.status(503).json({ error: "provisioning_unavailable", message: "try again later; no payment was taken" });
      return;
    }

    let settle;
    const settleStarted = Date.now();
    try {
      settle = await deps.resourceServer.settlePayment(payload, requirement);
      paymentSettleMs = Date.now() - settleStarted;
      metrics
        .histogram("sandbox_payment_settle_duration_seconds", "Facilitator settlement", LATENCY_BUCKETS)
        .observe(paymentSettleMs / 1000);
    } catch (err) {
      log.warn("payment_settle_error", { error: (err as Error).message });
      await deps.controller.failIntent(key, "settle_error").catch(() => undefined);
      await deps.payment402(res, requirement, "payment_settle_failed");
      return;
    }

    if (!settle.success) {
      // A nonce conflict may mean an earlier attempt settled but crashed before
      // the entitlement was durable. Recover instead of charging twice.
      if (settle.errorReason === "nonce_already_used" && deps.settlementLookup.supported) {
        try {
          const existing = await deps.settlementLookup.lookup(key);
          if (existing) {
            log.warn("payment_recovered_after_nonce_conflict", { paymentKeyPrefix: key.slice(0, 12) });
            await complete({ payer: existing.payer, transaction: existing.transaction });
            return;
          }
        } catch {
          /* fall through */
        }
      }
      await deps.controller.failIntent(key, settle.errorReason ?? "settlement_rejected").catch(() => undefined);
      await deps.payment402(res, requirement, `payment_settlement_rejected:${settle.errorReason ?? "unknown"}`);
      return;
    }

    await complete({ payer: settle.payer, transaction: settle.transaction });
  };
}
