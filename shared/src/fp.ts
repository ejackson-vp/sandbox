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
