/**
 * The persistence model vocabulary: one import path, declarations elsewhere.
 *
 * The aggregates live in `store/models/`:
 *
 *   - `session.ts`     the session row, its columns, its mapper, due-state SQL
 *   - `operations.ts`  the operation row, payload binding, persisted results
 *   - `money.ts`       payments, intents, the ledger, refund claims, mappers
 *   - `admin.ts`       payer allowlist, create kill switch, challenge nonces
 *   - `health.ts`      the store's readiness answer
 *
 * This module used to hold all of them and answered six questions at once. What
 * is left is the import path consumers already use: the integration and
 * property suites and `tests/helpers` import `store/models.js` and are outside
 * this package.
 *
 * Do not add a declaration here. Add it to the slice that owns the aggregate.
 */
export * from "./models/admin.js";
export * from "./models/health.js";
export * from "./models/money.js";
export * from "./models/operations.js";
export * from "./models/session.js";
