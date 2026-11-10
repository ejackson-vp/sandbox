/**
 * `@x402s/shared/domain` — the pure lifecycle decision core.
 *
 * `transition()` and its guards: no clock, no I/O, no configuration. Callers
 * pass the snapshot and the current time in.
 */
export * from "../domain/session.js";
