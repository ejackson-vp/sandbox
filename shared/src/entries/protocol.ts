/**
 * `@x402s/shared/protocol` — the wire contract and the pure session table it is
 * defined against.
 *
 * Three pure modules, one home:
 *   protocol/*       the wire types (lifecycle, session, operations, relay, ...)
 *   domain/session   `transition()` and the guards that produce those states
 *   fp               `Result`, `Ok`, `Err`, `assertNever`, the vocabulary the
 *                    table returns and the shell exhausts on
 *
 * No I/O, no crypto, no node builtins: importing a wire type must not drag
 * `node:crypto` or `libsodium-wrappers` into the process.
 * `scripts/check-structure.mjs` enforces that, and also that no symbol is
 * reachable from two entries.
 */
export * from "../protocol.js";
export * from "../domain/session.js";
export * from "../fp.js";
