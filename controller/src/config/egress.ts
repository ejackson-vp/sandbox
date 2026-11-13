/**
 * Egress allowlist: what a sandbox may reach through the proxy.
 *
 * Parsed as plain lists. The proxy does the enforcement (port allowlist, host
 * suffix, denied CIDRs, per-session tunnel cap, byte budgets); the loader only
 * bounds the counts and refuses malformed integers.
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
  | "egressMaxBytesPerSession"
  | "egressMaxBytesGlobalWindow"
  | "egressBytesWindowMs"
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
    // Byte budgets. 0 disables either bound, which is the operator's escape
    // hatch for a deployment with its own volume accounting. One gigabyte per
    // session is far above any legitimate download and far below a session that
    // is being used as an exit node; 20 GiB an hour across the process is a
    // fraction of a small VPS uplink, so it bounds abuse without capping a
    // busy fleet. A chunk that would cross a bound is refused whole.
    egressMaxBytesPerSession: int(env.EGRESS_MAX_BYTES_PER_SESSION, 1024 ** 3, 0, 1024 ** 4),
    egressMaxBytesGlobalWindow: int(
      env.EGRESS_MAX_BYTES_GLOBAL_WINDOW,
      20 * 1024 ** 3,
      0,
      10 * 1024 ** 4,
    ),
    // One hour: long enough that a burst cannot be laundered across a boundary,
    // short enough that a refused session can retry inside a lease.
    egressBytesWindowMs: int(env.EGRESS_BYTES_WINDOW_MS, 3_600_000, 60_000, 86_400_000),
  };
}
