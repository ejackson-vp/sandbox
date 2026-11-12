/**
 * What an external call is allowed to tell us (ADR 0011).
 *
 * A call over a network has three outcomes, not two:
 *
 *  - `ok`: the provider did the thing and named the result;
 *  - `definite_failure`: the provider answered, and it refused. It is safe to
 *    count an attempt and back off;
 *  - `unknown`: the answer was lost, or the provider said something we cannot
 *    read as a refusal. The thing may have happened.
 *
 * The algebra exists so that the third case cannot be mistaken for the second,
 * which is the failure mode that loses money: recording an unknown as a
 * refusal consumes the retry budget and then stops retrying work that may have
 * already moved funds. Nothing here decides policy, it only classifies.
 *
 * The HTTP classifier is deliberately conservative. Only a response we know the
 * provider generated can be a refusal, so 2xx is `ok`, a plain 4xx is a
 * `definite_failure`, and everything else (5xx, 408, 425, 429, redirects,
 * unreadable statuses) is `unknown`.
 */

export interface Failure {
  readonly reason: string;
}

export type ExternalOutcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "definite_failure"; readonly failure: Failure }
  | { readonly kind: "unknown"; readonly failure: Failure };

export type Verdict = ExternalOutcome<unknown>["kind"];

export function ok<T>(value: T): ExternalOutcome<T> {
  return { kind: "ok", value };
}

export function definiteFailure(reason: string): ExternalOutcome<never> {
  return { kind: "definite_failure", failure: { reason } };
}

export function unknown(reason: string): ExternalOutcome<never> {
  return { kind: "unknown", failure: { reason } };
}

export function isOk<T>(outcome: ExternalOutcome<T>): outcome is { kind: "ok"; value: T } {
  return outcome.kind === "ok";
}

export function isDefiniteFailure<T>(
  outcome: ExternalOutcome<T>,
): outcome is { kind: "definite_failure"; failure: Failure } {
  return outcome.kind === "definite_failure";
}

export function isUnknown<T>(outcome: ExternalOutcome<T>): outcome is { kind: "unknown"; failure: Failure } {
  return outcome.kind === "unknown";
}

export function valueOf<T>(outcome: ExternalOutcome<T>): T | null {
  return outcome.kind === "ok" ? outcome.value : null;
}

export function failureOf<T>(outcome: ExternalOutcome<T>): Failure | null {
  return outcome.kind === "ok" ? null : outcome.failure;
}

/**
 * Whether the outcome consumes one of the finite attempts. Only a definite
 * refusal does; unknown may be retried for as long as the work is visible.
 */
export function countsAsAttempt<T>(outcome: ExternalOutcome<T>): boolean {
  return outcome.kind === "definite_failure";
}

export function mapOutcome<A, B>(outcome: ExternalOutcome<A>, map: (value: A) => B): ExternalOutcome<B> {
  return outcome.kind === "ok" ? ok(map(outcome.value)) : outcome;
}

/** The classifier for a provider's HTTP status. */
export function classifyStatus(status: number): Verdict {
  if (!Number.isInteger(status) || status < 100 || status > 599) return "unknown";
  if (status >= 200 && status <= 299) return "ok";
  // Retryable or transient by definition: the provider did not refuse, it
  // could not answer, or asked us to come back later.
  if (status === 408 || status === 425 || status === 429) return "unknown";
  if (status >= 500) return "unknown";
  if (status >= 400) return "definite_failure";
  // 1xx and 3xx never describe a completed, refused transfer.
  return "unknown";
}

/** The classifier for a call that threw instead of answering. */
export function classifyThrown(err: unknown): ExternalOutcome<never> {
  return unknown(toFailure(err).reason);
}

/** A normalised reason for a thrown value, safe to store and log. */
export function toFailure(err: unknown): Failure {
  const message = err instanceof Error ? err.message : String(err);
  return { reason: message === "" ? "external call failed without a message" : message };
}
