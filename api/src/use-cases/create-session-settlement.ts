/**
 * The paid half of the create path: verify, then settle, then prove it.
 *
 * This runs once the payment intent is claimed, which is where the stages in
 * `create-session-stages.ts` end. Settlement is the only step that moves money,
 * so its ordering and its failure taxonomy are the whole point:
 *
 *  - the facilitator verifies before the controller is asked to hold anything,
 *    and a failed verify releases the provisional hold;
 *  - the controller is checked before the settle call, so a control plane that
 *    is down refuses without charging;
 *  - a settle that threw, timed out, or answered "broadcast, not confirmed" is
 *    `unknown`, never a refusal (ADR 0011). The intent stays claimed and the
 *    hold keeps its TTL, which is what lets recovery resolve the payment
 *    instead of charging the payer twice;
 *  - a `success` is a claim about a nonce, so it is confirmed on chain before a
 *    session is granted: a buggy or hostile facilitator must not be able to mint
 *    one by answering `success` (F-10).
 *
 * Each step answers "the value the next one needs" or "the answer that ends the
 * request", so `verifyAndSettle` reads as that list.
 */
import type { PaymentRequirements, SettleResponse } from "@x402/core/types";
import { paymentAuthorizer } from "@x402s/shared/crypto";
import { classifyThrown, settlementKey, toFailure } from "@x402s/shared/durable";
import { LATENCY_BUCKETS, log, metrics } from "@x402s/shared/runtime";
import {
  confirmSettledOnChain,
  recoveryAvailable,
  recoverSettlement,
} from "../payments/settlement-confirmation.js";
import {
  failAfterReleasingHold,
  json,
  paymentRequired,
  type CreateSessionUseCaseDeps,
  type Failed,
  type Ok,
  type PaymentPayload,
  type PaymentTimings,
  type SettledPayment,
} from "./create-session-contract.js";

/**
 * Facilitator error reasons that mean "we do not know", never "we refused".
 *
 * `settlement_pending` is the x402 mechanism reporting that it broadcast a
 * transaction and could not confirm it: a transfer may exist, so the attempt
 * must not be recorded as a definite failure (ADR 0011).
 */
const AMBIGUOUS_SETTLE_REASONS: ReadonlySet<string> = new Set(["settlement_pending", "settlement_timeout"]);

function settleVerdict(errorReason: string | undefined): "definite_failure" | "unknown" {
  return errorReason !== undefined && AMBIGUOUS_SETTLE_REASONS.has(errorReason)
    ? "unknown"
    : "definite_failure";
}

/**
 * An unknown settlement is not a failure. With a settlement lookup, or an
 * on-chain verifier that can answer for the nonce, the intent stays `claimed`,
 * which is what lets `SettlementRecovery` and the client's retry resolve it.
 * With neither, nothing could ever resolve it, so the intent is failed exactly
 * as before: a terminal row an operator can see beats a claim that ages out into
 * nothing.
 */
async function deferUnknownSettlement(
  deps: CreateSessionUseCaseDeps,
  key: string,
  reason: string,
): Promise<void> {
  if (recoveryAvailable(deps)) return;
  await deps.controller.failIntent(key, reason).catch(() => undefined);
}

/**
 * A settle whose answer was lost may still have landed. Ask the chain before
 * answering: a proven transfer completes the entitlement now, instead of leaving
 * the client to retry into `payment_in_progress` until the claim goes stale.
 */
async function recoverLostSettle(
  deps: CreateSessionUseCaseDeps,
  payload: PaymentPayload,
  key: string,
  requirement: PaymentRequirements,
): Promise<Ok<SettledPayment> | null> {
  if (!deps.settlementVerifier) return null;
  if ((await confirmSettledOnChain(deps.settlementVerifier, payload, requirement)) !== "settled") {
    return null;
  }
  log.warn("payment_recovered_after_lost_settle", { paymentKeyPrefix: key.slice(0, 12) });
  const payer = paymentAuthorizer(payload) ?? undefined;
  return { ok: true, value: payer ? { payer } : {} };
}

/**
 * Ask the facilitator to verify. A thrown call and a refusal are both "do not
 * settle", and both give the provisional capacity hold back.
 */
async function verifyWithFacilitator(
  deps: CreateSessionUseCaseDeps,
  payload: PaymentPayload,
  requirement: PaymentRequirements,
  key: string,
  timings: PaymentTimings,
): Promise<Failed | null> {
  let verify;
  const started = Date.now();
  try {
    verify = await deps.resourceServer.verifyPayment(payload, requirement);
    timings.verifyMs = Date.now() - started;
    metrics
      .histogram("sandbox_payment_verify_duration_seconds", "Facilitator payment verification", LATENCY_BUCKETS)
      .observe(timings.verifyMs / 1000);
  } catch (err) {
    log.warn("payment_verify_error", { error: (err as Error).message });
    return failAfterReleasingHold(deps, key, paymentRequired(requirement, "payment_verify_failed"));
  }
  if (verify.isValid) return null;
  return failAfterReleasingHold(
    deps,
    key,
    paymentRequired(requirement, `payment_invalid:${verify.invalidReason ?? "unknown"}`),
  );
}

/**
 * Do not move money through a control plane that cannot answer. The controller
 * is what turns a settlement into a durable entitlement, so a settle against an
 * unreachable one is money spent on nothing.
 */
async function refuseWhenControllerUnavailable(
  deps: CreateSessionUseCaseDeps,
  key: string,
): Promise<Failed | null> {
  try {
    const health = await deps.controller.healthz();
    if (!health.ok) throw new Error("controller unhealthy");
  } catch {
    await deps.controller.failIntent(key, "control_plane_unavailable").catch(() => undefined);
    return failAfterReleasingHold(
      deps,
      key,
      json(503, { error: "provisioning_unavailable", message: "try again later; no payment was taken" }),
    );
  }
  return null;
}

/**
 * The facilitator answered `success: false`. That is not necessarily a refusal:
 * a nonce conflict can mean an earlier attempt settled and crashed, and a
 * "broadcast, not confirmed" reason means a transfer may exist. Only a definite
 * refusal fails the intent and releases the hold.
 */
async function resolveRefusedSettle(
  deps: CreateSessionUseCaseDeps,
  payload: PaymentPayload,
  requirement: PaymentRequirements,
  key: string,
  settle: SettleResponse,
): Promise<Ok<SettledPayment> | Failed> {
  // A nonce conflict may mean an earlier attempt settled but crashed before
  // the entitlement was durable. The chain answers that for an EVM payment
  // whether or not the facilitator exposes a settlement lookup, so recover
  // instead of charging twice.
  if (settle.errorReason === "nonce_already_used" && recoveryAvailable(deps)) {
    const resolution = await recoverSettlement(deps, key, payload, requirement);
    if (resolution.status === "settled") {
      log.warn("payment_recovered_after_nonce_conflict", { paymentKeyPrefix: key.slice(0, 12) });
      return {
        ok: true,
        value: {
          payer: resolution.settlement.payer,
          transaction: resolution.settlement.transaction,
        },
      };
    }
    if (resolution.status === "unknown") {
      // The facilitator says the nonce is used, but the chain cannot place the
      // payment (outside the window, or unreadable) and no lookup can answer.
      // That is not a refusal: failing the intent would hide the debt from the
      // recovery worker, which only walks claimed intents. Keep the intent
      // claimed and the hold until its TTL, and ask the client to retry with
      // the same payment, exactly as the lost-settle path does.
      log.warn("payment_settlement_unresolved", {
        paymentKeyPrefix: key.slice(0, 12),
        operation: settlementKey(key).kind,
      });
      await deferUnknownSettlement(deps, key, "settlement_unresolved");
      return {
        ok: false,
        result: json(503, {
          error: "payment_unconfirmed",
          reason: "unavailable",
          retryable: true,
          message: "settlement could not be confirmed on chain; retry with the same payment",
        }),
      };
    }
    // A positive disproof falls through: it is a real refusal.
  }
  // The facilitator answered, but an answer that says "broadcast, not yet
  // confirmed" is not a refusal. Same rule as a thrown call: keep the intent
  // claimed for recovery and the hold until its TTL.
  if (settleVerdict(settle.errorReason) === "unknown") {
    log.warn("payment_settle_unknown", {
      paymentKeyPrefix: key.slice(0, 12),
      operation: settlementKey(key).kind,
      reason: settle.errorReason,
    });
    await deferUnknownSettlement(deps, key, settle.errorReason ?? "settlement_pending");
    const recovered = await recoverLostSettle(deps, payload, key, requirement);
    if (recovered) return recovered;
    return { ok: false, result: paymentRequired(requirement, "payment_settle_failed") };
  }
  await deps.controller.failIntent(key, settle.errorReason ?? "settlement_rejected").catch(() => undefined);
  return failAfterReleasingHold(
    deps,
    key,
    paymentRequired(requirement, `payment_settlement_rejected:${settle.errorReason ?? "unknown"}`),
  );
}

/**
 * The facilitator said settled, which on a chain is a claim about a nonce.
 * Confirm the transfer before granting: a refusal here is recoverable because
 * the intent stays claimed while the chain can still answer.
 */
async function confirmOnChain(
  deps: CreateSessionUseCaseDeps,
  payload: PaymentPayload,
  requirement: PaymentRequirements,
  key: string,
  settle: SettleResponse,
): Promise<Ok<SettledPayment> | Failed> {
  if (deps.settlementVerifier) {
    const verdict = await confirmSettledOnChain(deps.settlementVerifier, payload, requirement);
    if (verdict !== "settled") {
      log.warn("payment_not_confirmed_on_chain", {
        paymentKeyPrefix: key.slice(0, 12),
        verdict,
      });
      await deferUnknownSettlement(
        deps,
        key,
        verdict === "unsettled" ? "chain_transfer_disproven" : "chain_check_failed",
      );
      return {
        ok: false,
        result: json(503, {
          error: "payment_unconfirmed",
          reason: verdict,
          retryable: true,
          message: "settlement could not be confirmed on chain; retry with the same payment",
        }),
      };
    }
  }
  return { ok: true, value: { payer: settle.payer, transaction: settle.transaction } };
}

/**
 * The payload as the facilitator should see it when discovery is on.
 *
 * The Bazaar indexes from the settled call, not from the 402: it reads
 * `resource` and `extensions.bazaar` off the payment payload it is asked to
 * settle. Without them the resource is advertised to buyers and never
 * catalogued, which is the failure that looks like success.
 *
 * Only the envelope is extended. The EIP-3009 authorization inside
 * `payload.payload` is untouched, so the signature still covers exactly what it
 * covered before, and a facilitator that ignores unknown envelope fields is
 * unaffected.
 */
function withDiscovery(
  deps: CreateSessionUseCaseDeps,
  payload: PaymentPayload,
): PaymentPayload {
  if (!deps.discovery) return payload;
  return {
    ...payload,
    resource: { ...deps.discovery.resource },
    extensions: deps.discovery.extensions,
  };
}

/**
 * Verify, check the controller is up, then settle, then prove the settle.
 *
 * A settlement failure keeps the capacity hold until its TTL so recovery cannot
 * over-allocate. The nonce-conflict recovery resolves to a settlement here
 * because it happens instead of settlement, before completion.
 */
export async function verifyAndSettle(
  deps: CreateSessionUseCaseDeps,
  payload: PaymentPayload,
  requirement: PaymentRequirements,
  key: string,
  timings: PaymentTimings,
): Promise<Ok<SettledPayment> | Failed> {
  const notVerified = await verifyWithFacilitator(deps, payload, requirement, key, timings);
  if (notVerified) return notVerified;

  const unavailable = await refuseWhenControllerUnavailable(deps, key);
  if (unavailable) return unavailable;

  const settlePayload = withDiscovery(deps, payload);

  let settle: SettleResponse;
  const settleStarted = Date.now();
  try {
    settle = await deps.resourceServer.settlePayment(settlePayload, requirement);
    timings.settleMs = Date.now() - settleStarted;
    metrics
      .histogram("sandbox_payment_settle_duration_seconds", "Facilitator settlement", LATENCY_BUCKETS)
      .observe(timings.settleMs / 1000);
  } catch (err) {
    // The facilitator may have submitted the transfer before the answer was
    // lost. A thrown settle is `unknown`, never a refusal (ADR 0011), so it is
    // not recorded as a failed attempt and the intent is not failed while a
    // settlement lookup can still resolve it. Keep the hold until its TTL so
    // recovery cannot over-allocate capacity.
    const failure = toFailure(err);
    log.warn("payment_settle_error", {
      paymentKeyPrefix: key.slice(0, 12),
      operation: settlementKey(key).kind,
      outcome: classifyThrown(err).kind,
      error: failure.reason,
    });
    await deferUnknownSettlement(deps, key, "settle_error");
    const recovered = await recoverLostSettle(deps, payload, key, requirement);
    if (recovered) return recovered;
    return { ok: false, result: paymentRequired(requirement, "payment_settle_failed") };
  }

  if (!settle.success) return resolveRefusedSettle(deps, payload, requirement, key, settle);
  return confirmOnChain(deps, payload, requirement, key, settle);
}
