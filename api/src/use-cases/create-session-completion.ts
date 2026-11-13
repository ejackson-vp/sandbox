/**
 * Entitlement completion: the settled payment becomes a session, once.
 *
 * This is the durable half of the create path, so it is explicit about the two
 * races it can lose:
 *
 *  - a capacity race at completion time keeps the payment recoverable (503 with
 *    the same payment), because the money already moved;
 *  - a concurrent or recovered completion returns the session the winner
 *    created, with the capability re-derived from the same payment, so the
 *    client gets one handle and is never charged twice.
 *
 * The caller passes everything the completion needs rather than the function
 * closing over the request, so the completion is testable with a plain object.
 */
import { randomBytes } from "node:crypto";
import type { PaymentRequirements } from "@x402/core/types";
import { settlementNonce } from "@x402s/shared/crypto";
import { formatUsd } from "@x402s/shared/money";
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  SessionSpec,
} from "@x402s/shared/protocol";
import { log, metrics } from "@x402s/shared/runtime";
import { ControllerError, type IntentCompletion } from "../controller-client.js";
import { createResponseFrom } from "../status.js";
import {
  json,
  rejectRetiredCapabilityKey,
  type CreateSessionResult,
  type CreateSessionUseCaseDeps,
  type PaymentPayload,
  type PaymentTimings,
  type SettledPayment,
} from "./create-session-contract.js";

/** Everything a completion needs, captured once the intent is claimed. */
interface CompletionContext {
  claimToken: string;
  key: string;
  commitment: string;
  capability: string;
  capabilityHash: string;
  spec: SessionSpec;
  body: CreateSessionRequest;
  authorizer: `0x${string}`;
  requirement: PaymentRequirements;
  payload: PaymentPayload;
  receivedAt: number;
  timings: PaymentTimings;
  /**
   * Present when the session was granted by the payer allowlist (ADR 0013):
   * amount 0, source `allowlist`, the label in the ledger's reason, and a
   * budget row namespaced away from the payer's own.
   */
  allowance?: { label: string; budgetKey: string };
}

/** The settlement the payment facilitator reported, if any. */
/**
 * Map a failed `completeIntent` to an answer. A lost capacity race keeps the
 * settled payment recoverable, and a 409 that names a session means a
 * concurrent attempt already completed it, so return that session rather than
 * charging twice.
 */
async function completeFailure(
  deps: CreateSessionUseCaseDeps,
  err: unknown,
  key: string,
  commitment: string,
): Promise<CreateSessionResult> {
  if (err instanceof ControllerError && err.code === "capacity_unavailable") {
    return json(503, {
      error: "capacity_unavailable",
      retryable: true,
      message: "payment settled but capacity is no longer available; retry with the same payment",
      ...(err.detail && typeof err.detail === "object" ? err.detail : {}),
    });
  }
  if (err instanceof ControllerError && err.status === 409) {
    const detail = err.detail as { sessionId?: string } | undefined;
    if (detail?.sessionId) {
      const existing = await deps.controller.getSession(detail.sessionId).catch(() => null);
      if (existing) {
        const replayCapability = deps.recoverCapability(key, commitment, existing.capabilityHash);
        if (!replayCapability) return rejectRetiredCapabilityKey(existing.sessionId);
        return json(200, createResponseFrom(existing, replayCapability, existing.limits));
      }
    }
  }
  log.error("entitlement_creation_failed", { error: (err as Error).message });
  return json(503, {
    error: "provisioning_unavailable",
    message: "payment settled; contact support with your receipt",
  });
}

/**
 * Durably complete the entitlement for a settled payment, and answer with the
 * session.
 */
export async function completeEntitlement(
  deps: CreateSessionUseCaseDeps,
  ctx: CompletionContext,
  settled: SettledPayment,
): Promise<CreateSessionResult> {
  const { key, commitment, capability, capabilityHash, spec, body, authorizer } = ctx;
  const requirement = ctx.requirement;
  // A free session records what actually moved: nothing. The claimed
  // authorisation value is never written, because no authorisation was used.
  const amount = ctx.allowance ? "0" : requirement.amount;
  const source = ctx.allowance ? "allowlist" : "x402";
  const sessionId = `sbx_${randomBytes(12).toString("hex")}`;
  // The capability outlives the lease by a small grace window so a client can
  // still read the final status / fetch a late result.
  // A suspended session can be resumed for its whole wall-clock lifetime, so
  // the capability must cover that window, not just the first lease.
  const capabilityLifetime = spec.maxLifetimeSeconds ?? spec.durationSeconds;
  const capabilityExpiresAt =
    Date.now() + (capabilityLifetime + deps.config.capabilityTtlSeconds) * 1000;
  let completion: IntentCompletion;
  try {
    completion = await deps.controller.completeIntent(key, {
      claimToken: ctx.claimToken,
      sessionId,
      capabilityHash,
      capabilityExpiresAt,
      spec,
      clientPublicKey: body.clientPublicKey,
      clientNonce: body.clientNonce,
      clientSigner: authorizer,
      timings: {
        apiReceivedAt: ctx.receivedAt,
        paymentVerifyMs: ctx.timings.verifyMs,
        paymentSettleMs: ctx.timings.settleMs,
        entitlementMs: Date.now() - ctx.receivedAt,
      },
      payment: {
        paymentKey: key,
        network: requirement.network,
        scheme: requirement.scheme,
        asset: requirement.asset,
        amount,
        payTo: requirement.payTo,
        payer: settled.payer,
        transaction: settled.transaction,
        mode: deps.config.paymentMode,
        settlementNonce: ctx.allowance ? null : settlementNonce(ctx.payload),
        source,
        ...(ctx.allowance
          ? { label: ctx.allowance.label, budgetKey: ctx.allowance.budgetKey }
          : {}),
      },
    });
  } catch (err) {
    return completeFailure(deps, err, key, commitment);
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
      return json(503, {
        error: "provisioning_unavailable",
        message: "payment settled; contact support with your receipt",
      });
    }
    log.info("payment_idempotent_completion", {
      sessionId: winner.sessionId,
      paymentKeyPrefix: key.slice(0, 12),
    });
    const replayCapability = deps.recoverCapability(key, commitment, winner.capabilityHash);
    if (!replayCapability) return rejectRetiredCapabilityKey(winner.sessionId);
    return json(200, createResponseFrom(winner, replayCapability, winner.limits));
  }
  metrics
    .counter("sandbox_sessions_total", "Sessions created by entitlement source")
    .inc({ source });
  log.info("session_created", {
    sessionId,
    tier: spec.tier,
    durationSeconds: spec.durationSeconds,
    paymentKeyPrefix: key.slice(0, 12),
    payer: settled.payer,
  });
  // Newer controllers return the view with the completion, which removes one
  // API -> controller round trip from the create critical path. Keep the lookup
  // as the fallback for an older controller.
  const session = completion.session ?? (await deps.controller.getSession(sessionId).catch(() => null));
  if (session) {
    return json(201, createResponseFrom(session, capability, spec.limits));
  }
  return json(
    201,
    {
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
        amount,
        priceUsd: formatUsd(amount),
        payTo: requirement.payTo,
        payer: settled.payer,
        transaction: settled.transaction,
      },
    } satisfies CreateSessionResponse,
  );
}
