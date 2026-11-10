/**
 * A small Result type for expected, recoverable failures.
 *
 * Use it at boundaries (validation, lifecycle decisions, parsing). Throw only
 * for programmer error. No monad transformers, no fp-ts.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/**
 * Exhaustiveness check for a closed union.
 *
 * A switch that handles every variant leaves `value` as `never` here, so it
 * compiles. Add a variant without handling it and the call fails `tsc`
 * instead of silently falling through. Reaching it at runtime means a value was
 * smuggled past the types.
 */
export function assertNever(value: never, context = "unhandled union member"): never {
  throw new Error(`${context}: ${JSON.stringify(value)}`);
}
