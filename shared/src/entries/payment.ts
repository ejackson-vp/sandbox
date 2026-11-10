/**
 * `@x402s/shared/payment` — x402 schemes, price parsing and the tier table.
 *
 * Pulls `./crypto` (commitments and spec hashes) plus `@x402/core`. The API,
 * the mock facilitator and the SDK are the consumers; a wire-type-only caller
 * should stay on `./protocol`.
 */
export * from "../payment.js";
export * from "../tiers.js";
