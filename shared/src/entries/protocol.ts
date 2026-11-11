/**
 * `@x402s/shared/protocol` — the wire contract and the pure session table.
 *
 * Types plus total functions over them. No I/O, no crypto, no node builtins:
 * importing a wire type must not drag `node:crypto` or `libsodium-wrappers`
 * into the process. `scripts/check-structure.mjs` enforces that.
 *
 * The session state machine lives under `./domain` too; it is included here
 * because every wire reply is defined in terms of the states it produces.
 */
export * from "../protocol.js";
export * from "../domain/session.js";
