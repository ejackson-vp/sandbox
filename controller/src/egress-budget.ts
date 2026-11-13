/**
 * Egress byte budget.
 *
 * The proxy bounds connections, not volume: sixteen tunnels can move gigabytes
 * an hour, and the operator pays for the egress and answers for the abuse
 * (docs/runbooks/egress-abuse.md). This module owns the two byte bounds the
 * tunnel enforces and nothing else: no sockets, no timers, no logging, so the
 * accounting can be tested without a listener.
 *
 * Both directions count. The per-session total is the bytes one session id has
 * moved in this process, not per tunnel: a per-tunnel budget is reset by
 * reconnecting, which is one command for the client. The global total is a
 * fixed window, the same shape as the durable create budget: a client can spend
 * the whole window in one burst at a boundary, and the per-session bound is
 * what stops that from being interesting.
 *
 * Both are process-local, like the connection counters beside them. A second
 * proxy replica multiplies each budget by the replica count, which is the
 * documented limit of sharded enforcement (see the shard claim in the proxy).
 *
 * Memory is one small entry per session id the process has served, for the life
 * of the process. Sessions are paid and admission-capped, so that is bounded by
 * throughput, not by a client; a restart resets both totals and the map.
 */

/** Closed set: the only values the `scope` label of either metric takes. */
export const EGRESS_LIMIT_SCOPES = ["session", "global"] as const;

export type EgressLimitScope = (typeof EGRESS_LIMIT_SCOPES)[number];

export interface EgressBudgetOptions {
  /** Bytes one session may move in this process. 0 disables the bound. */
  maxBytesPerSession: number;
  /** Bytes all sessions may move inside one window. 0 disables the bound. */
  maxBytesGlobal: number;
  /** Length of the global fixed window. */
  windowMs: number;
  /** Test seam: the clock the window rolls on. Defaults to Date.now. */
  now?: () => number;
}

export interface EgressBudget {
  /**
   * Charge `bytes` to both budgets. Returns the scope that would be crossed, or
   * null when the whole chunk fits. A refusal charges nothing: the chunk is not
   * written, so it is not egress.
   */
  charge(sessionId: string, bytes: number): EgressLimitScope | null;
  /** Bytes charged in this process, and how many sessions have an entry. */
  totals(): { bytes: number; sessions: number; windowBytes: number };
}

export function createEgressBudget(opts: EgressBudgetOptions): EgressBudget {
  const now = opts.now ?? Date.now;
  const sessionBytes = new Map<string, number>();
  let total = 0;
  let windowBytes = 0;
  let windowStart = now();

  return {
    charge(sessionId, bytes) {
      // A chunk has a positive length by construction; a zero or nonsense
      // length is not a reason to tear down a working tunnel.
      if (!Number.isFinite(bytes) || bytes <= 0) return null;

      const at = now();
      if (opts.windowMs > 0 && at - windowStart >= opts.windowMs) {
        windowStart = at;
        windowBytes = 0;
      }

      const used = sessionBytes.get(sessionId) ?? 0;
      // The per-session bound first: it is the one that names the tenant, and a
      // global refusal for a session that is also over its own cap is less
      // useful to read.
      if (opts.maxBytesPerSession > 0 && used + bytes > opts.maxBytesPerSession) {
        return "session";
      }
      if (opts.maxBytesGlobal > 0 && windowBytes + bytes > opts.maxBytesGlobal) {
        return "global";
      }

      sessionBytes.set(sessionId, used + bytes);
      windowBytes += bytes;
      total += bytes;
      return null;
    },
    totals: () => ({ bytes: total, sessions: sessionBytes.size, windowBytes }),
  };
}
