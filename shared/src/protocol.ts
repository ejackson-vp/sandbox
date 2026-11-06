/**
 * Wire protocol types shared by the API server, SDK/CLI, controller and (by
 * hand-written mirror) the Go guest runtime.
 *
 * Design rule: nothing in this file may carry customer plaintext. Every
 * `envelope` field is an opaque base64 libsodium sealed box. Commands, file
 * contents, stdout and stderr only ever exist inside those envelopes.
 *
 * The contract is split by concept; import from `@x402s/shared` as before.
 */
export * from "./protocol/lifecycle.js";
export * from "./protocol/session.js";
export * from "./protocol/operations.js";
export * from "./protocol/attestation.js";
export * from "./protocol/relay.js";
export * from "./protocol/control.js";
