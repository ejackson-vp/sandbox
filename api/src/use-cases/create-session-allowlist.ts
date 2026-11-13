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
import type { SessionSpec } from "@x402s/shared/protocol";
import { log } from "@x402s/shared/runtime";
import type { AllowlistDecision } from "../controller-client.js";
import {
  json,
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
    return {
      kind: "unavailable",
      result: json(503, {
        error: "admission_unavailable",
        retryable: true,
        message: "try again shortly; no payment was taken",
      }),
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
    return null;
  }
  return {
    kind: "allowed",
    label: decision.label,
    budgetKey: allowlistBudgetKey(authorizer),
  };
}
