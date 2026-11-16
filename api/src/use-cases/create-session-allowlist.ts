/**
 * Free entitlement for a proven allowlisted payer (ADR 0013).
 *
 * The order is the whole security argument:
 *
 *  1. `proveCommitment` has already recovered the address that signed the
 *     client commitment, so the address used here is proven, not claimed.
 *  2. The allowlist check happens here, before any facilitator call, so a free
 *     session is never offered to a facilitator, never settled and never
 *     charged.
 *
 * The payment key is derived from the proven address and the server-issued
 * challenge nonce. That makes it unique per session, impossible to replay as a
 * real payment (the domain prefix separates the input space), and useless
 * without a live challenge. Every refusal (missing row, disabled row, tier or
 * concurrency ceiling, a signer that is not on the list) fails back to the paid
 * path; only an affirmative answer from the controller grants.
 */
import { sha256Hex } from "@x402s/shared/crypto";
import type { AllowlistDecision, SessionSpec } from "@x402s/shared/protocol";
import { log, metrics } from "@x402s/shared/runtime";
import {
  admissionUnavailable,
  type CreateSessionResult,
  type CreateSessionUseCaseDeps,
} from "./create-session-contract.js";

/**
 * A payment key for a free session: `sha256(domain | address | challengeNonce)`.
 *
 * It cannot collide with a real payment key (that is a hash of the payment
 * payload) and it cannot be replayed as one: settlement is keyed by an EIP-3009
 * nonce that no client chose here. The domain tag is versioned because changing
 * it invalidates every derived key, so it is a literal inside the function that
 * a test can pin rather than a module constant.
 */
export function allowlistPaymentKey(address: string, challengeNonce: string): string {
  return sha256Hex(`x402-allowlist:v1|${address.toLowerCase()}|${challengeNonce}`);
}

/** The budget row a free session charges, separate from the payer's own row. */
export function allowlistBudgetKey(address: string): string {
  return `allow:${address.toLowerCase()}`;
}

/** The one metric family the allowlist decision exports. */
export const ALLOWLIST_DECISIONS_TOTAL = "sandbox_allowlist_decisions_total";

/**
 * Outcomes of one consultation, as a closed enum.
 *
 * `granted` and `lookup_failed` are this module's two outcomes; the rest are the
 * controller's refusal reasons. The address and the operator label are never
 * label values: the address is customer identity and the label is free text.
 */
type DecisionOutcome =
  | "granted"
  | "lookup_failed"
  | Extract<AllowlistDecision, { allowed: false }>["reason"];

/**
 * Count one consultation.
 *
 * The free tier is bounded per entry by `max_tier` and `max_concurrent`, and
 * nothing watches its volume, so a shared or leaked wallet otherwise leaves no
 * trace beyond its ledger rows. `not_allowlisted` is the ordinary paid path and
 * is counted too, so the family answers "how much of the create traffic
 * consults the allowlist" as well as "how much of it is free".
 */
function countDecision(result: DecisionOutcome): void {
  metrics
    .counter(ALLOWLIST_DECISIONS_TOTAL, "Allowlist entitlement decisions by outcome")
    .inc({ result });
}

export type Allowance =
  | { kind: "allowed"; label: string; budgetKey: string }
  | { kind: "unavailable"; result: CreateSessionResult };

/**
 * Resolve the allowance for one create. `null` means "continue down the normal
 * x402 path"; `unavailable` means the lookup failed and the request must refuse.
 */
export async function resolveAllowance(
  deps: CreateSessionUseCaseDeps,
  authorizer: `0x${string}`,
  spec: SessionSpec,
): Promise<Allowance | null> {
  if (!deps.config.payerAllowlistEnabled) return null;

  let decision: AllowlistDecision;
  try {
    decision = await deps.controller.authorizeAllowlistedPayer(authorizer, spec.tier);
  } catch (err) {
    // Fail closed. Falling through to the paid path would charge a wallet that
    // is meant to be free, so the honest answer is a retryable refusal.
    // Stryker disable next-line CallExpression,StringLiteral,ObjectLiteral: log only; the 503 below is the behaviour
    log.error("allowlist_lookup_failed", { error: (err as Error).message });
    countDecision("lookup_failed");
    return {
      kind: "unavailable",
      result: admissionUnavailable("try again shortly; no payment was taken"),
    };
  }

  if (!decision.allowed) {
    // Every refusal is the same behavioural answer: the paid path. The log is
    // the only difference, and a free session must never be granted on a
    // missing, disabled, over-tier or over-concurrency entry.
    // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement,StringLiteral: logging only; the return below is the same for every reason
    if (decision.reason !== "not_allowlisted") {
      // Stryker disable next-line CallExpression,StringLiteral,ObjectLiteral: log only
      log.info("allowlist_refused", { reason: decision.reason, tier: spec.tier });
    }
    countDecision(decision.reason);
    return null;
  }
  countDecision("granted");
  return {
    kind: "allowed",
    label: decision.label,
    budgetKey: allowlistBudgetKey(authorizer),
  };
}
