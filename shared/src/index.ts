/**
 * Compatibility barrel: re-exports every shared module, as it always has.
 *
 * Prefer a subpath instead, so a consumer only loads what it uses:
 *   ./protocol  wire types + the pure session table (no I/O, no node builtins)
 *   ./crypto    sealing, hashing, commitments, attestation
 *   ./payment   x402 schemes, price parsing, tier table
 *   ./runtime   logging, metrics, rate limiting, readiness
 *   ./env       fail-closed environment parsing
 *   ./ip        egress-proxy address classification
 *
 * This file stays complete on purpose: it is the compatibility surface for
 * anything that has not migrated yet. Do not add modules here and call it done;
 * add them to the narrow entry under `src/entries/` as well.
 */
export * from "./env.js";
export * from "./protocol.js";
export * from "./fp.js";
export * from "./domain/session.js";
export * from "./crypto.js";
export * from "./commitment.js";
export * from "./attestation.js";
export * from "./dev-attestation.js";
export * from "./payment.js";
export * from "./tiers.js";
export * from "./ip.js";
export * from "./log.js";
export * from "./metrics.js";
export * from "./metrics-http.js";
export * from "./http-metrics.js";
export * from "./runtime-metrics.js";
export * from "./request-metrics.js";
export * from "./rate-limit.js";
export * from "./readiness.js";
