/**
 * Egress allowlist: what a sandbox may reach through the proxy.
 *
 * Parsed as plain lists. The proxy does the enforcement (port allowlist, host
 * suffix, denied CIDRs, per-session tunnel cap); the loader only bounds the
 * connection counts and refuses malformed integers.
 */
import { envInt as int } from "@x402s/shared/env";
import type { ControllerConfig } from "./types.js";

type EgressSettings = Pick<
  ControllerConfig,
  | "allowedPorts"
  | "allowedHostSuffixes"
  | "deniedCidrs"
  | "egressMaxConnectionsPerSession"
  | "egressMaxGlobalConnections"
>;

export function parseEgress(env: NodeJS.ProcessEnv): EgressSettings {
  return {
    allowedPorts: (env.EGRESS_ALLOWED_PORTS ?? "443").split(",").map((p) => Number(p.trim())).filter((n) => Number.isInteger(n)),
    allowedHostSuffixes: (env.EGRESS_ALLOWED_HOST_SUFFIXES ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    deniedCidrs: (env.EGRESS_DENIED_CIDRS ?? "10.244.0.0/16,10.96.0.0/12")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    egressMaxConnectionsPerSession: int(env.EGRESS_MAX_CONNECTIONS_PER_SESSION, 16, 1, 1024),
    egressMaxGlobalConnections: int(env.EGRESS_MAX_GLOBAL_CONNECTIONS, 512, 1, 65_536),
  };
}
