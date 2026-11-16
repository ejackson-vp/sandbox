/**
 * `@x402s/shared/settlement` — the on-chain settlement check.
 *
 * Two modules with one job each:
 *
 *  - `settlement-verifier.ts` reads the chain: the `AuthorizationUsed` log for
 *    the nonce, then the `Transfer` in that transaction, against the server's
 *    recipient and price (F-17);
 *  - `settlement-verdict.ts` says what the answer means (`proven` is `settled`,
 *    `disproven` is `unsettled`, `not-found` is `unavailable`), parses the
 *    fail-closed chain settings, and builds the verifier.
 *
 * One implementation for the API's grant path and the controller's recovery
 * worker. The facilitator's settlement *lookup* is a different mechanism (an
 * HTTP contract the facilitator may not expose) and stays on `./runtime` with
 * the other I/O listeners.
 */
export * from "../settlement-verifier.js";
export * from "../settlement-verdict.js";
