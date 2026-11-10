/**
 * `@x402s/shared/ip` — address classification for the egress proxy.
 *
 * Pure: CIDR tables and parsers, no DNS, no sockets. The controller's egress
 * proxy is the only consumer today.
 */
export * from "../ip.js";
