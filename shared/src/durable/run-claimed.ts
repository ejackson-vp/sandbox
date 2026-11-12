/**
 * One claimed external call, from send to recorded outcome (ADR 0011).
 *
 * This is the only shared orchestration in the durable module, and it is small
 * on purpose. It owns the order of events that both consumers have to get right:
 *
 *   1. make the call, already classified as `ok` / `definite_failure` / `unknown`;
 *   2. on unknown, record nothing, so the lease makes the work due again;
 *   3. on a definite refusal, hand the caller a retry decision and let it
 *      release the claim in its own transaction;
 *   4. on ok, let the caller commit in its own transaction, and treat "zero
 *      rows" as a lost claim rather than a success.
 *
 * What it deliberately does **not** own: the fence, the transaction and the
 * table. `complete` and `fail` are callbacks, so the refund worker keeps its
 * conditional `UPDATE`, and the grant path keeps its payment + ledger + session
 * transaction. `runClaimed` never invents a token and never writes a row.
 */
import { backoffMs, isExhausted, type RetryPolicy } from "./retry.js";
import { toFailure, type ExternalOutcome, type Failure } from "./outcome.js";

export interface RetryDecision {
  /** Attempts recorded after this refusal, including it. */
  readonly attempts: number;
  /** True when this refusal reached the limit. */
  readonly exhausted: boolean;
  /** When the work becomes due again. */
  readonly nextAttemptAtMs: number;
}

export type ClaimedCallResult<TValue> =
  | { readonly kind: "completed"; readonly value: TValue }
  | { readonly kind: "refused"; readonly failure: Failure; readonly retry: RetryDecision }
  | { readonly kind: "unknown"; readonly failure: Failure }
  | { readonly kind: "record_failed"; readonly failure: Failure; readonly value: TValue }
  | {
      readonly kind: "claim_lost";
      /** The completion lost the fence: the provider paid, another owner records it. */
      readonly stage: "complete";
      readonly value: TValue;
    }
  | {
      readonly kind: "claim_lost";
      /** The release lost the fence: this pass records nothing, not even an attempt. */
      readonly stage: "fail";
      readonly failure: Failure;
      readonly value?: TValue;
    };

export interface ClaimedCall<TValue> {
  readonly policy: RetryPolicy;
  /** Definitive refusals already recorded for this work. */
  readonly attemptsSoFar: number;
  /** The pass's clock, so the backoff and the query agree on "now". */
  readonly nowMs: number;
  /**
   * The provider call. The caller classifies it because only the caller knows
   * its protocol; a throw here is treated as unknown, never as a refusal.
   */
  readonly call: () => Promise<ExternalOutcome<TValue>>;
  /** Record success. `false` means another owner holds the claim. */
  readonly complete: (value: TValue) => Promise<boolean>;
  /** Record a definite refusal. `false` means another owner holds the claim. */
  readonly fail: (failure: Failure, retry: RetryDecision) => Promise<boolean>;
}

export function retryDecision(policy: RetryPolicy, attemptsSoFar: number, nowMs: number): RetryDecision {
  const attempts = attemptsSoFar + 1;
  return {
    attempts,
    exhausted: isExhausted(policy, attempts),
    nextAttemptAtMs: nowMs + backoffMs(policy, attemptsSoFar),
  };
}

export async function runClaimed<TValue>(work: ClaimedCall<TValue>): Promise<ClaimedCallResult<TValue>> {
  let outcome: ExternalOutcome<TValue>;
  try {
    outcome = await work.call();
  } catch (err) {
    // An unclassified throw is ambiguous by construction: the request may have
    // been received and answered after the answer was lost. Never a refusal.
    outcome = { kind: "unknown", failure: toFailure(err) };
  }

  if (outcome.kind === "unknown") {
    // No release and no attempt: leave the work to the lease reclaim, with the
    // same key it was sent with.
    return { kind: "unknown", failure: outcome.failure };
  }

  if (outcome.kind === "definite_failure") {
    const retry = retryDecision(work.policy, work.attemptsSoFar, work.nowMs);
    const released = await work.fail(outcome.failure, retry);
    if (!released) return { kind: "claim_lost", stage: "fail", failure: outcome.failure };
    return { kind: "refused", failure: outcome.failure, retry };
  }

  let completed: boolean;
  try {
    completed = await work.complete(outcome.value);
  } catch (err) {
    // The provider paid but the ledger write did not land. The claim is still
    // owned, so leaving it in place is correct: the reclaim resends the same
    // key and the provider answers with the original result.
    return { kind: "record_failed", failure: toFailure(err), value: outcome.value };
  }
  if (!completed) return { kind: "claim_lost", stage: "complete", value: outcome.value };
  return { kind: "completed", value: outcome.value };
}
