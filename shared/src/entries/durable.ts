/**
 * `@x402s/shared/durable` — the protocol for one claimed external call.
 *
 * At-least-once delivery plus dedupe and a fencing token gives effectively-once
 * effects. Two paths in this repository implement that protocol against
 * different tables and different providers:
 *
 *   - the refund worker claims a ledger row, sends an operator webhook keyed by
 *     `refund:<paymentKey>`, and completes under the claim token;
 *   - the grant path claims a payment intent, settles against the facilitator
 *     (deduped by the EIP-3009 nonce), and completes in one transaction.
 *
 * This entry holds only what they must agree on: the key convention, the claim
 * lease and its predicates, the retry policy, the outcome algebra and the small
 * `runClaimed` orchestration. No SQL, no transactions, no unique constraints:
 * those stay in the Postgres adapters where the fence is enforced.
 *
 * Pure by construction, so it is importable from the API and the controller
 * without dragging in a database client. See docs/adr/0011-durable-external-calls.md.
 */
export * from "../durable/keys.js";
export * from "../durable/claim.js";
export * from "../durable/retry.js";
export * from "../durable/outcome.js";
export * from "../durable/run-claimed.js";
