/**
 * Create-session route: the x402 handshake, verification, settlement and
 * entitlement completion. All customer payloads remain sealed envelopes.
 */
import type { Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { verifyMessage } from "viem";
import type { x402ResourceServer } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import {
  clientCommitmentMessage,
  isChallengeNonce,
  paymentAuthorizer,
  settlementNonce,
  sha256Hex,
} from "@x402s/shared/crypto";
import {
  PAYMENT_VERSION,
  paymentKey,
  resolveSessionSpec,
  specHash,
} from "@x402s/shared/payment";
import { formatUsd } from "@x402s/shared/money";
import type {
  CreateSessionResponse,
  CreateSessionRequest,
  SessionSpec,
} from "@x402s/shared/protocol";
import type { ApiConfig } from "../config.js";
import {
  ControllerError,
  type BudgetDecision,
  type CapacityDecision,
  type ControllerClient,
  type IntentCompletion,
} from "../controller-client.js";
import { createSchema } from "../schemas.js";
import { RateLimiter, paymentPayerKey } from "../admission.js";
import type { SettlementLookup } from "../settlement-lookup.js";
import { createResponseFrom } from "../status.js";
import {
  LATENCY_BUCKETS,
  log,
  metrics,
  recordAuthFailure,
  recordRateLimited,
} from "@x402s/shared/runtime";

export interface CreateSessionDeps {
  config: ApiConfig;
  controller: ControllerClient;
  resourceServer: x402ResourceServer;
  settlementLookup: SettlementLookup;
  requirementFor(priceUsd: string, spec: SessionSpec): Promise<PaymentRequirements>;
  payment402(res: Response, requirement: PaymentRequirements, error: string): Promise<void>;
  capabilityFor(key: string, commitment: string): string;
  /**
   * Re-derive the capability an existing session was issued, across a key
   * rotation. Null means no key in the ring reproduces the stored hash.
   */
  recoverCapability(key: string, commitment: string, storedHash: string): string | null;
  ipCreateLimiter: RateLimiter;
  createLimiter: RateLimiter;
}

function rejectCapacity(res: Response, decision: Extract<CapacityDecision, { admitted: false }>): void {
  res.setHeader("Retry-After", decision.retryable ? "5" : "0");
  res.status(decision.retryable ? 503 : 409).json({
    error: "capacity_unavailable",
    retryable: decision.retryable,
    reason: decision.reason,
    requested: decision.requested,
  });
}

/**
 * Fail-closed response for a replay whose session was signed with a key that
 * has been retired. Returning a token signed by the current key would look
 * valid and then fail every request, so say what happened instead.
 */
function rejectRetiredCapabilityKey(res: Response, sessionId: string): void {
  res.status(409).json({
    error: "capability_key_retired",
    sessionId,
    message: "this payment's capability was signed with a retired key and cannot be reissued; create a new session",
  });
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
      recordRateLimited("ip");
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
      // Advisory: fail the quote early when the cluster cannot fit the session.
      // The paid path skips this and relies on holdCapacity, which is
      // authoritative, so a create pays for one capacity decision, not two.
      let preflight: CapacityDecision;
      try {
        preflight = await deps.controller.preflightCapacity(spec);
      } catch (err) {
        log.error("capacity_preflight_failed", { error: (err as Error).message });
        res.status(503).json({ error: "admission_unavailable", retryable: true, message: "try again shortly" });
        return;
      }
      if (!preflight.admitted) {
        rejectCapacity(res, preflight);
        return;
      }
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
      recordRateLimited("payer");
      res.setHeader("Retry-After", String(deps.createLimiter.retryAfterSeconds(payerKey)));
      res.status(429).json({
        error: "rate_limited",
        scope: "payer",
        message: "this payer is creating sessions too quickly; retry after the advertised delay",
      });
      return;
    }

    const key = paymentKey(payload);

    // The receipt alone is not authority. The wallet that signed the payment
    // must also sign this exact client key *and* the server-issued challenge
    // nonce, so a captured PAYMENT-SIGNATURE cannot bind the session to another
    // client, and a captured complete request stops working once its challenge
    // is burned or expires (F-07).
    const authorizer = paymentAuthorizer(payload);
    if (!authorizer) {
      await deps.payment402(res, requirement, "malformed_payment_authorization");
      return;
    }
    if (!body.clientSignature) {
      recordAuthFailure("client_proof_missing");
      res.status(401).json({ error: "client_proof_required" });
      return;
    }
    if (!isChallengeNonce(body.challengeNonce)) {
      // An older client sent a v1 commitment. Answer with a challenge so a
      // current client can retry instead of failing without guidance.
      recordAuthFailure("challenge_nonce_missing");
      await deps.payment402(res, requirement, "challenge_nonce_required");
      return;
    }
    const challengeNonce = body.challengeNonce;
    let proofOk = false;
    try {
      proofOk = await verifyMessage({
        address: authorizer,
        message: clientCommitmentMessage({
          paymentKey: key,
          clientPublicKey: body.clientPublicKey,
          clientNonce: body.clientNonce,
          challengeNonce,
        }),
        signature: body.clientSignature as `0x${string}`,
      });
    } catch {
      proofOk = false;
    }
    if (!proofOk) {
      recordAuthFailure("client_proof_invalid");
      log.warn("client_commitment_invalid", { paymentKeyPrefix: key.slice(0, 12) });
      res.status(401).json({ error: "client_proof_invalid" });
      return;
    }

    // Burn the challenge before any capacity is held or money is moved. A
    // `replay` is the same payment retrying (the documented crash-recovery
    // path) and continues; every other non-ok answer ends the request with a
    // fresh challenge, so the client can re-sign for the same payment.
    let burn: { status: "burned" | "replay" | "expired" | "unknown" | "reused" };
    try {
      burn = await deps.controller.burnChallengeNonce(challengeNonce, key);
    } catch (err) {
      // Fail closed: an unproven freshness value must not buy an entitlement.
      log.error("challenge_nonce_burn_failed", { error: (err as Error).message });
      res.status(503).json({
        error: "challenge_unavailable",
        retryable: true,
        message: "try again shortly; no payment was taken",
      });
      return;
    }
    if (burn.status !== "burned" && burn.status !== "replay") {
      recordAuthFailure(`challenge_nonce_${burn.status}`);
      await deps.payment402(res, requirement, `challenge_nonce_${burn.status}`);
      return;
    }

    // Durable per-payer and global budget (#48), before any capacity hold, intent
    // claim or settlement. The in-memory buckets above are the first line; this
    // one survives a restart, and the global row cannot be influenced by a
    // client-chosen field. `authorizer` is proven here: the commitment signature
    // recovers to it, so the budget key is a key the caller controls.
    let budget: BudgetDecision;
    try {
      budget = await deps.controller.reserveBudget(authorizer, requirement.amount);
    } catch (err) {
      log.error("budget_reservation_failed", { error: (err as Error).message });
      res.status(503).json({
        error: "admission_unavailable",
        retryable: true,
        message: "try again shortly; no payment was taken",
      });
      return;
    }
    if (!budget.ok) {
      const globalScope = budget.scope.startsWith("global_");
      recordRateLimited(globalScope ? "global_budget" : "payer_budget");
      res.setHeader("Retry-After", String(budget.retryAfterSeconds));
      res.status(429).json({
        error: "budget_exhausted",
        scope: budget.scope,
        retryAfterSeconds: budget.retryAfterSeconds,
        windowResetsAt: new Date(budget.windowResetsAt).toISOString(),
        // What the payer has left, so a client can back off without guessing.
        remaining: budget.remaining,
        message: "this payer's create budget is exhausted; no payment was taken",
      });
      return;
    }

    const commitment = `${body.clientPublicKey}:${body.clientNonce}`;
    const capability = deps.capabilityFor(key, commitment);
    const capabilityHash = sha256Hex(capability);

    // Authoritative capacity hold happens before settlement. The preflight at
    // 402 time is advisory; this closes the race between the 402 and payment.
    let hold: CapacityDecision;
    try {
      hold = await deps.controller.holdCapacity(key, specDigest, spec);
    } catch (err) {
      log.error("capacity_hold_failed", { error: (err as Error).message });
      res.status(503).json({ error: "admission_unavailable", retryable: true, message: "try again shortly" });
      return;
    }
    if (!hold.admitted) {
      rejectCapacity(res, hold);
      return;
    }

    const claim = await deps.controller.claimIntent(key, specDigest, deps.config.intentStaleMs, {
      network: requirement.network,
      scheme: requirement.scheme,
      asset: requirement.asset,
      amount: requirement.amount,
      payTo: requirement.payTo,
    });
    if (claim.status === "in_progress") {
      res.status(409).json({ error: "payment_in_progress", message: "this payment is already being processed" });
      return;
    }
    if (claim.status === "failed") {
      await deps.controller.releaseCapacity(key);
      await deps.payment402(res, requirement, `payment_intent_failed:${claim.reason ?? "unknown"}`);
      return;
    }
    if (claim.status === "mismatch") {
      await deps.controller.releaseCapacity(key);
      res.status(409).json({ error: "spec_mismatch", message: "this payment was made for a different session spec" });
      return;
    }
    if (claim.status === "settled") {
      // A replay must not leave a fresh provisional hold behind. This only
      // releases HELD rows; an existing session reservation is untouched.
      await deps.controller.releaseCapacity(key);
      const session = await deps.controller.getSession(claim.sessionId).catch(() => null);
      if (!session) {
        res.status(409).json({ error: "entitlement_missing", sessionId: claim.sessionId });
        return;
      }
      log.info("payment_idempotent_replay", { sessionId: claim.sessionId, paymentKeyPrefix: key.slice(0, 12) });
      // The token may have been signed before a rotation: re-derive the one
      // that matches the stored hash rather than signing a new one.
      const replayCapability = deps.recoverCapability(key, commitment, session.capabilityHash);
      if (!replayCapability) {
        rejectRetiredCapabilityKey(res, session.sessionId);
        return;
      }
      res.status(200).json(createResponseFrom(session, replayCapability, session.limits));
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
      let completion: IntentCompletion;
      try {
        completion = await deps.controller.completeIntent(key, {
          claimToken: claim.token,
          sessionId,
          capabilityHash,
          capabilityExpiresAt,
          spec,
          clientPublicKey: body.clientPublicKey,
          clientNonce: body.clientNonce,
          clientSigner: authorizer,
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
            settlementNonce: settlementNonce(payload),
          },
        });
      } catch (err) {
        // A concurrent/recovered completion may have won the race. The
        // capability is derived from the same payment, so return that session.
        if (err instanceof ControllerError && err.code === "capacity_unavailable") {
          res.status(503).json({
            error: "capacity_unavailable",
            retryable: true,
            message: "payment settled but capacity is no longer available; retry with the same payment",
            ...(err.detail && typeof err.detail === "object" ? err.detail : {}),
          });
          return false;
        }
        if (err instanceof ControllerError && err.status === 409) {
          const detail = err.detail as { sessionId?: string } | undefined;
          if (detail?.sessionId) {
            const existing = await deps.controller.getSession(detail.sessionId).catch(() => null);
            if (existing) {
              const replayCapability = deps.recoverCapability(key, commitment, existing.capabilityHash);
              if (!replayCapability) {
                rejectRetiredCapabilityKey(res, existing.sessionId);
                return true;
              }
              res.status(200).json(createResponseFrom(existing, replayCapability, existing.limits));
              return true;
            }
          }
        }
        log.error("entitlement_creation_failed", { error: (err as Error).message });
        res.status(503).json({ error: "provisioning_unavailable", message: "payment settled; contact support with your receipt" });
        return false;
      }
      void deps.controller.wake();
      if (completion.created === false) {
        // A concurrent worker won the completion race. Return the session it
        // created, with the capability derived from the same payment. Newer
        // controllers fold the view into the completion; older ones need the
        // lookup.
        const winner =
          completion.session ?? (await deps.controller.getSession(completion.sessionId).catch(() => null));
        if (!winner) {
          log.error("entitlement_missing_after_idempotent_completion", {
            sessionId: completion.sessionId,
            paymentKeyPrefix: key.slice(0, 12),
          });
          res.status(503).json({ error: "provisioning_unavailable", message: "payment settled; contact support with your receipt" });
          return false;
        }
        log.info("payment_idempotent_completion", {
          sessionId: winner.sessionId,
          paymentKeyPrefix: key.slice(0, 12),
        });
        const replayCapability = deps.recoverCapability(key, commitment, winner.capabilityHash);
        if (!replayCapability) {
          rejectRetiredCapabilityKey(res, winner.sessionId);
          return true;
        }
        res.status(200).json(createResponseFrom(winner, replayCapability, winner.limits));
        return true;
      }
      log.info("session_created", {
        sessionId,
        tier: spec.tier,
        durationSeconds: spec.durationSeconds,
        paymentKeyPrefix: key.slice(0, 12),
        payer: settled.payer,
      });
      // Newer controllers return the view with the completion, which removes
      // one API -> controller round trip from the create critical path. Keep
      // the lookup as the fallback for an older controller.
      const session = completion.session ?? (await deps.controller.getSession(sessionId).catch(() => null));
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
          runtime: spec.runtime,
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
      await deps.controller.releaseCapacity(key);
      await deps.payment402(res, requirement, "payment_verify_failed");
      return;
    }
    if (!verify.isValid) {
      await deps.controller.releaseCapacity(key);
      await deps.payment402(res, requirement, `payment_invalid:${verify.invalidReason ?? "unknown"}`);
      return;
    }

    try {
      const health = await deps.controller.healthz();
      if (!health.ok) throw new Error("controller unhealthy");
    } catch {
      await deps.controller.failIntent(key, "control_plane_unavailable").catch(() => undefined);
      await deps.controller.releaseCapacity(key);
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
      // Settlement may have succeeded even though the call failed. Keep the
      // hold until its TTL so recovery cannot over-allocate capacity.
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
      await deps.controller.releaseCapacity(key);
      await deps.payment402(res, requirement, `payment_settlement_rejected:${settle.errorReason ?? "unknown"}`);
      return;
    }

    await complete({ payer: settle.payer, transaction: settle.transaction });
  };
}
