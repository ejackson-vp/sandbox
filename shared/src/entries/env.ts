/**
 * `@x402s/shared/env` — fail-closed environment parsing.
 *
 * Pure functions, no process reads at import time. Kept separate from the
 * payment and runtime entries so a config loader does not have to pull crypto
 * just to parse a boolean.
 */
export * from "../env.js";
