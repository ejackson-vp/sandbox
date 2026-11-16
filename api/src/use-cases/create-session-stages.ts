/**
 * The create-session stages, in the order the invariants require them.
 *
 * Each stage either produces the value the next one needs or the answer that
 * ends the request. None of them writes a response, so the ordering is plain
 * control flow: the orchestrator (`create-session.ts`) calls them in sequence
 * and returns the first failure.
 *
 * Ordering is load-bearing:
 *  - per-payer admission happens before the intent claim or settlement, so a
 *    throttled payer is never charged,
 *  - the challenge nonce is burned before capacity is held or money moves,
 *  - the durable budget is reserved before the capacity hold and the claim,
 *  - capacity is held before settlement, so the hold closes the race between
 *    the advisory 402 preflight and the payment.
 *
 * The stages end with the claim. Everything that spends money is in
 * `create-session-settlement.ts`, which the orchestrator calls next and which
 * owns the failure taxonomy of verify and settle.
 */
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { verifyMessage } from "viem";
import {
  clientCommitmentMessage,
  isChallengeNonce,
  paymentAuthorizer,
} from "@x402s/shared/crypto";
import { PAYMENT_VERSION, paymentKey } from "@x402s/shared/payment";
import {
  assertNever,
  type BudgetDecision,
  type BudgetScope,
  type CapacityDecision,
  type CreateSessionRequest,
  type SessionSpec,
} from "@x402s/shared/protocol";
import type { RateLimitScope } from "@x402s/shared/runtime";
import { log, recordAuthFailure, recordRateLimited } from "@x402s/shared/runtime";
import { paymentPayerKey } from "../admission.js";
import type { ApiConfig } from "../config.js";
import {
  admissionUnavailable,
  failAfterReleasingHold,
  json,
  paymentRequired,
  rejectCapacity,
  replayedSession,
  type CreateSessionResult,
  type CreateSessionUseCaseDeps,
  type Failed,
  type Ok,
  type PaymentPayload,
} from "./create-session-contract.js";

/**
 * Unpaid request: advisory capacity preflight, then the 402. Failing the quote
 * early when the cluster cannot fit the session is a courtesy; the paid path
 * relies on holdCapacity, which is authoritative, so a create pays for one
 * capacity decision, not two.
 */
export async function quoteWithoutPayment(
  deps: CreateSessionUseCaseDeps,
  spec: SessionSpec,
  requirement: PaymentRequirements,
): Promise<CreateSessionResult> {
  let preflight: CapacityDecision;
  try {
    preflight = await deps.controller.preflightCapacity(spec);
  } catch (err) {
    log.error("capacity_preflight_failed", { error: (err as Error).message });
    return admissionUnavailable("try again shortly");
  }
  if (!preflight.admitted) return rejectCapacity(preflight);
  return paymentRequired(requirement, "payment_required");
}

/** Decode the header and refuse a payment that is not for this requirement. */
export function decodePayment(
  header: string,
  requirement: PaymentRequirements,
  config: ApiConfig,
): Ok<PaymentPayload> | Failed {
  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(header);
  } catch {
    return { ok: false, result: paymentRequired(requirement, "malformed_payment_header") };
  }
  if (payload.x402Version !== PAYMENT_VERSION) {
    return { ok: false, result: paymentRequired(requirement, "unsupported_x402_version") };
  }
  if (
    payload.accepted?.network !== config.network ||
    payload.accepted?.amount !== requirement.amount
  ) {
    return { ok: false, result: paymentRequired(requirement, "payment_requirements_mismatch") };
  }
  return { ok: true, value: payload };
}

/**
 * Per-payer admission, before the payment intent is claimed or the payment is
 * settled, so a throttled payer is never charged.
 *
 * `null` means "continue". The bucket key is a rate-limit identity rather than a
 * trust decision, so it is not returned: nothing downstream reads it.
 */
export function admitPayer(
  deps: CreateSessionUseCaseDeps,
  payload: PaymentPayload,
  sourceIp: string,
): CreateSessionResult | null {
  const payerKey = paymentPayerKey(payload, sourceIp);
  if (deps.createLimiter.take(payerKey)) return null;
  recordRateLimited("payer");
  return json(
    429,
    {
      error: "rate_limited",
      scope: "payer",
      message: "this payer is creating sessions too quickly; retry after the advertised delay",
    },
    { "Retry-After": String(deps.createLimiter.retryAfterSeconds(payerKey)) },
  );
}

/** The proven identity of the payer and the challenge it signed. */
interface Commitment {
  key: string;
  authorizer: `0x${string}`;
  challengeNonce: string;
}

/**
 * The receipt alone is not authority. The wallet that signed the payment must
 * also sign this exact client key *and* the server-issued challenge nonce, so a
 * captured PAYMENT-SIGNATURE cannot bind the session to another client, and a
 * captured complete request stops working once its challenge is burned or
 * expires (F-07).
 */
export async function proveCommitment(
  body: CreateSessionRequest,
  payload: PaymentPayload,
  requirement: PaymentRequirements,
): Promise<Ok<Commitment> | Failed> {
  const key = paymentKey(payload);
  const authorizer = paymentAuthorizer(payload);
  if (!authorizer) {
    return { ok: false, result: paymentRequired(requirement, "malformed_payment_authorization") };
  }
  if (!body.clientSignature) {
    recordAuthFailure("client_proof_missing");
    return { ok: false, result: json(401, { error: "client_proof_required" }) };
  }
  if (!isChallengeNonce(body.challengeNonce)) {
    // An older client sent a v1 commitment. Answer with a challenge so a
    // current client can retry instead of failing without guidance.
    recordAuthFailure("challenge_nonce_missing");
    return { ok: false, result: paymentRequired(requirement, "challenge_nonce_required") };
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
    return { ok: false, result: json(401, { error: "client_proof_invalid" }) };
  }
  return { ok: true, value: { key, authorizer, challengeNonce } };
}

/**
 * Burn the challenge before any capacity is held or money is moved. A `replay`
 * is the same payment retrying (the documented crash-recovery path) and
 * continues; every other non-ok answer ends the request with a fresh challenge,
 * so the client can re-sign for the same payment.
 */
export async function burnChallenge(
  deps: CreateSessionUseCaseDeps,
  challengeNonce: string,
  key: string,
  requirement: PaymentRequirements,
): Promise<Ok<null> | Failed> {
  let burn: { status: "burned" | "replay" | "expired" | "unknown" | "reused" };
  try {
    burn = await deps.controller.burnChallengeNonce(challengeNonce, key);
  } catch (err) {
    // Fail closed: an unproven freshness value must not buy an entitlement.
    log.error("challenge_nonce_burn_failed", { error: (err as Error).message });
    return {
      ok: false,
      result: json(503, {
        error: "challenge_unavailable",
        retryable: true,
        message: "try again shortly; no payment was taken",
      }),
    };
  }
  if (burn.status !== "burned" && burn.status !== "replay") {
    recordAuthFailure(`challenge_nonce_${burn.status}`);
    return { ok: false, result: paymentRequired(requirement, `challenge_nonce_${burn.status}`) };
  }
  return { ok: true, value: null };
}

/**
 * Which admission bucket a refused budget belongs to.
 *
 * Total over the closed scope union: the label `sandbox_rate_limited_total`
 * carries is the point of that union, so a new scope has to be classified here
 * instead of falling through a string prefix. `startsWith("global_")` did the
 * opposite: a new scope compiled, and was counted as a payer refusal.
 */
function budgetRateLimitScope(scope: BudgetScope): RateLimitScope {
  switch (scope) {
    case "global_create":
    case "global_concurrent":
      return "global_budget";
    case "payer_create":
    case "payer_spend":
    case "payer_concurrent":
      return "payer_budget";
    default:
      return assertNever(scope, "BudgetScope");
  }
}

/**
 * Durable per-payer and global budget (#48), before any capacity hold, intent
 * claim or settlement. The in-memory buckets are the first line; this one
 * survives a restart, and the global row cannot be influenced by a client-chosen
 * field. `payerKey` is proven here: the commitment signature recovers to the
 * address, so the budget key is a key the caller controls. An allowlisted payer
 * passes `allow:<address>` so a free session charges its own row rather than
 * the paying one (ADR 0013).
 */
export async function reserveBudget(
  deps: CreateSessionUseCaseDeps,
  payerKey: string,
  amountAtomic: string,
): Promise<Ok<BudgetDecision> | Failed> {
  let budget: BudgetDecision;
  try {
    budget = await deps.controller.reserveBudget(payerKey, amountAtomic);
  } catch (err) {
    log.error("budget_reservation_failed", { error: (err as Error).message });
    return { ok: false, result: admissionUnavailable("try again shortly; no payment was taken") };
  }
  if (!budget.ok) {
    recordRateLimited(budgetRateLimitScope(budget.scope));
    return {
      ok: false,
      result: json(
        429,
        {
          error: "budget_exhausted",
          scope: budget.scope,
          retryAfterSeconds: budget.retryAfterSeconds,
          windowResetsAt: new Date(budget.windowResetsAt).toISOString(),
          // What the payer has left, so a client can back off without guessing.
          remaining: budget.remaining,
          message: "this payer's create budget is exhausted; no payment was taken",
        },
        { "Retry-After": String(budget.retryAfterSeconds) },
      ),
    };
  }
  return { ok: true, value: budget };
}

/**
 * Authoritative capacity hold, before settlement. The preflight at 402 time is
 * advisory; this closes the race between the 402 and payment.
 */
export async function holdCapacity(
  deps: CreateSessionUseCaseDeps,
  key: string,
  specDigest: string,
  spec: SessionSpec,
): Promise<Ok<CapacityDecision> | Failed> {
  let hold: CapacityDecision;
  try {
    hold = await deps.controller.holdCapacity(key, specDigest, spec);
  } catch (err) {
    log.error("capacity_hold_failed", { error: (err as Error).message });
    return { ok: false, result: admissionUnavailable("try again shortly") };
  }
  if (!hold.admitted) return { ok: false, result: rejectCapacity(hold) };
  return { ok: true, value: hold };
}

/**
 * Claim the payment intent, which is also where a replay of a settled payment
 * is answered. The provisional capacity hold is released on every outcome but
 * `claimed`: the paid path re-holds authoritatively, and a settled session owns
 * its own reservation.
 */
export async function claimPaymentIntent(
  deps: CreateSessionUseCaseDeps,
  key: string,
  specDigest: string,
  requirement: PaymentRequirements,
  commitment: string,
  attribution: { authorizer: string; settlementNonce: string | null },
): Promise<Ok<{ token: string; recovered: boolean }> | Failed> {
  const claim = await deps.controller.claimIntent(key, specDigest, deps.config.intentStaleMs, {
    network: requirement.network,
    scheme: requirement.scheme,
    asset: requirement.asset,
    amount: requirement.amount,
    payTo: requirement.payTo,
  }, attribution);
  switch (claim.status) {
    case "in_progress":
      return {
        ok: false,
        result: json(409, {
          error: "payment_in_progress",
          message: "this payment is already being processed",
        }),
      };
    case "failed":
      return failAfterReleasingHold(
        deps,
        key,
        paymentRequired(requirement, `payment_intent_failed:${claim.reason ?? "unknown"}`),
      );
    case "mismatch":
      return failAfterReleasingHold(
        deps,
        key,
        json(409, {
          error: "spec_mismatch",
          message: "this payment was made for a different session spec",
        }),
      );
    case "settled": {
      // A replay must not leave a fresh provisional hold behind. This only
      // releases HELD rows; an existing session reservation is untouched.
      await deps.controller.releaseCapacity(key);
      const session = await deps.controller.getSession(claim.sessionId).catch(() => null);
      if (!session) {
        return {
          ok: false,
          result: json(409, { error: "entitlement_missing", sessionId: claim.sessionId }),
        };
      }
      log.info("payment_idempotent_replay", {
        sessionId: claim.sessionId,
        paymentKeyPrefix: key.slice(0, 12),
      });
      return { ok: false, result: replayedSession(deps, key, commitment, session) };
    }
    case "claimed":
      return { ok: true, value: { token: claim.token, recovered: claim.recovered } };
    default:
      // Unreachable while both sides share one union: a status this API cannot
      // read throws rather than being treated as a claim, so a create never
      // settles on a body nobody understood.
      return assertNever(claim, "IntentClaimResult");
  }
}
