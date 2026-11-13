/**
 * The create-session use case: the order of the x402 handshake, and nothing
 * else.
 *
 * The route (`routes/create-session.ts`) does the per-IP admission, parses the
 * body and writes the answer. This module resolves the immutable spec, then
 * walks the stages in `create-session-stages.ts` and finishes with the
 * entitlement completion. Every branch, every side effect and the order in
 * which they happen match the handler this was extracted from.
 *
 * It returns a discriminated result instead of touching the socket, so the
 * ordering of payment and capacity side effects is testable without an Express
 * response.
 */
import { sha256Hex } from "@x402s/shared/crypto";
import { resolveSessionSpec, specHash } from "@x402s/shared/payment";
import { log } from "@x402s/shared/runtime";
import { recoverSettlement } from "../payments/settlement-confirmation.js";
import {
  json,
  type CreateSessionInput,
  type CreateSessionResult,
  type CreateSessionUseCaseDeps,
  type PaymentTimings,
} from "./create-session-contract.js";
import { allowlistPaymentKey, resolveAllowance } from "./create-session-allowlist.js";
import { completeEntitlement } from "./create-session-completion.js";
import {
  admitPayer,
  burnChallenge,
  claimPaymentIntent,
  decodePayment,
  holdCapacity,
  proveCommitment,
  quoteWithoutPayment,
  reserveBudget,
  verifyAndSettle,
} from "./create-session-stages.js";

export type {
  CreateSessionInput,
  CreateSessionJsonResult,
  CreateSessionPaymentRequiredResult,
  CreateSessionResult,
  CreateSessionUseCaseDeps,
} from "./create-session-contract.js";

/**
 * Run the handshake and return the answer. The caller owns the socket; this
 * owns the order.
 */
export async function createSession(
  deps: CreateSessionUseCaseDeps,
  input: CreateSessionInput,
): Promise<CreateSessionResult> {
  const { body, sourceIp, receivedAt } = input;
  const resolution = resolveSessionSpec(body, deps.config.tiers, deps.config.platformLimits);
  if (!resolution.ok) {
    return json(400, { error: resolution.code, message: resolution.message });
  }
  const { spec, priceUsd } = resolution;
  const requirement = await deps.requirementFor(priceUsd, spec);
  const specDigest = specHash(spec);

  if (!input.paymentHeader) return quoteWithoutPayment(deps, spec, requirement);

  const decoded = decodePayment(input.paymentHeader, requirement, deps.config);
  if (!decoded.ok) return decoded.result;
  const payload = decoded.value;

  const admitted = admitPayer(deps, payload, sourceIp);
  if (!admitted.ok) return admitted.result;

  const proven = await proveCommitment(body, payload, requirement);
  if (!proven.ok) return proven.result;
  const { key, authorizer, challengeNonce } = proven.value;

  // Free entitlement for a proven allowlisted address (ADR 0013). This is the
  // check point: after the commitment signature proved the address, before any
  // facilitator call, so a free session is never settled or charged.
  const allowance = await resolveAllowance(deps, authorizer, spec);
  if (allowance?.kind === "unavailable") return allowance.result;
  const free = allowance?.kind === "allowed";
  // A free session gets its own key, derived from the proven address and the
  // burned challenge, so it cannot collide with or replay a real payment.
  const ledgerKey = free ? allowlistPaymentKey(authorizer, challengeNonce) : key;

  const burned = await burnChallenge(deps, challengeNonce, ledgerKey, requirement);
  if (!burned.ok) return burned.result;

  const budget = await reserveBudget(
    deps,
    allowance?.kind === "allowed" ? allowance.budgetKey : authorizer,
    free ? "0" : requirement.amount,
  );
  if (!budget.ok) return budget.result;
  const commitment = `${body.clientPublicKey}:${body.clientNonce}`;
  const capability = deps.capabilityFor(ledgerKey, commitment);
  const capabilityHash = sha256Hex(capability);

  const hold = await holdCapacity(deps, ledgerKey, specDigest, spec);
  if (!hold.ok) return hold.result;

  const claimed = await claimPaymentIntent(deps, ledgerKey, specDigest, requirement, commitment);
  if (!claimed.ok) return claimed.result;
  const { token: claimToken, recovered } = claimed.value;
  const timings: PaymentTimings = { verifyMs: 0, settleMs: 0 };

  const complete = (settled: { payer?: string; transaction?: string }): Promise<CreateSessionResult> =>
    completeEntitlement(
      deps,
      {
        claimToken,
        key: ledgerKey,
        commitment,
        capability,
        capabilityHash,
        spec,
        body,
        authorizer,
        requirement,
        payload,
        receivedAt,
        timings,
        ...(allowance?.kind === "allowed"
          ? { allowance: { label: allowance.label, budgetKey: allowance.budgetKey } }
          : {}),
      },
      settled,
    );

  if (free) {
    // No verify, no settle: the address is proven and the allowance is the
    // payment. The ledger row says amount 0, source allowlist, and the label.
    log.info("allowlist_entitlement_granted", {
      paymentKeyPrefix: ledgerKey.slice(0, 12),
      tier: spec.tier,
    });
    return complete({ payer: authorizer });
  }

  // Recovery path: a previous attempt may have settled before crashing. The
  // chain is asked first (F-10), then the facilitator lookup for anything the
  // chain cannot answer.
  if (recovered) {
    const existing = await recoverSettlement(deps, key, payload);
    if (existing) {
      log.warn("payment_recovered_from_settlement", { paymentKeyPrefix: key.slice(0, 12) });
      return complete({ payer: existing.payer, transaction: existing.transaction });
    }
  }

  const settled = await verifyAndSettle(deps, payload, requirement, key, timings);
  if (!settled.ok) return settled.result;
  return complete(settled.value);
}
