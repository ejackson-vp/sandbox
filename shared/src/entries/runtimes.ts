/**
 * `@x402s/shared/runtimes` — the supported guest runtime profiles.
 *
 * Pure: a fixed list plus total functions over it, no I/O. A create request may
 * only name one of these, and an unknown name is rejected before pricing, so
 * this is the noun the wire contract is written against without being a wire
 * shape itself.
 */
export * from "../runtimes.js";
