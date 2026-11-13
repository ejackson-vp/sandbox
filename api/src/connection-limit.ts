/**
 * Concurrent request cap, per client and process-wide.
 *
 * The API was tailnet-only, where one operator's client could not exhaust the
 * process; that assumption is gone once the listener sits behind a public
 * tunnel. `HTTP_REQUEST_TIMEOUT_MS` eventually reaps a slow client, but it
 * reaps one timeout at a time while the client holds as many sockets as it
 * likes, so a single peer can still own the event loop and the connection
 * table in the meantime.
 *
 * This counts requests in flight, not sockets. HTTP/1.1 keep-alive means one
 * socket may carry many requests, and a request that has been answered must not
 * keep a slot. A client is keyed by `req.ip`, which respects `TRUST_PROXY_HOPS`:
 * behind the tunnel that is the real client, not the tunnel pod.
 *
 * Probes are exempt. A saturated client must not be able to make a healthy pod
 * look unready, because that is the one failure the cap would then cause by
 * itself.
 *
 * A rejection is deliberately not logged per request: shedding load is the
 * point, and a log line per rejected request would move the flood from the
 * response path to stderr. `sandbox_connection_limit_total{scope}` plus the 429
 * in `sandbox_http_requests_total` are the signal.
 */
import type { NextFunction, Request, Response } from "express";
import { metrics, type MetricsRegistry } from "@x402s/shared/runtime";

/**
 * Closed set: the only values the `scope` label of the rejection counter takes.
 * A new rejection path adds a value here first, so cardinality cannot grow by
 * accident.
 */
export const CONNECTION_LIMIT_SCOPES = ["client", "global"] as const;

export type ConnectionLimitScope = (typeof CONNECTION_LIMIT_SCOPES)[number];

const METRIC = "sandbox_connection_limit_total";
const METRIC_HELP = "Requests refused by the concurrent request cap, by scope";

/** Liveness and readiness, always exempt, matched on the path only. */
const PROBE_PATHS = new Set(["/healthz", "/readyz"]);

export interface ConnectionLimitOptions {
  /** In-flight requests one client may hold. 0 disables the per-client check. */
  maxPerClient: number;
  /** In-flight requests the process accepts at once. 0 disables the check. */
  maxGlobal: number;
  /** Test seam: the process registry is the default. */
  registry?: MetricsRegistry;
}

export interface ConnectionLimiter {
  middleware(req: Request, res: Response, next: NextFunction): void;
  /** In-flight requests and tracked clients now, for a test or a future gauge. */
  state(): { inFlight: number; clients: number };
}

export function createConnectionLimiter(opts: ConnectionLimitOptions): ConnectionLimiter {
  const registry = opts.registry ?? metrics;
  const refusals = registry.counter(METRIC, METRIC_HELP);

  /** Client key -> requests it currently holds. An empty entry is deleted. */
  const held = new Map<string, number>();
  let inFlight = 0;

  return {
    middleware(req, res, next) {
      if (PROBE_PATHS.has(req.path)) {
        next();
        return;
      }

      const client = req.ip ?? req.socket?.remoteAddress ?? "unknown";
      const mine = held.get(client) ?? 0;
      // The per-client check first: it is the actionable one, and a client over
      // its own cap should be told that rather than blamed on the shared pool.
      let scope: ConnectionLimitScope | null = null;
      if (opts.maxPerClient > 0 && mine >= opts.maxPerClient) scope = "client";
      else if (opts.maxGlobal > 0 && inFlight >= opts.maxGlobal) scope = "global";
      if (scope !== null) {
        refusals.inc({ scope });
        res.status(429).json({ error: "connection_limit" });
        return;
      }

      // Taken synchronously, before the request is dispatched: concurrent
      // arrivals within one tick cannot all observe the same free slot.
      held.set(client, mine + 1);
      inFlight += 1;

      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        inFlight -= 1;
        const left = (held.get(client) ?? 1) - 1;
        if (left <= 0) held.delete(client);
        else held.set(client, left);
      };
      // `finish` is a normal answer, `close` is an abort, a destroyed socket or
      // a response a timeout tore down. Either can arrive without the other, so
      // both are registered and the release above is idempotent.
      res.on("finish", release);
      res.on("close", release);
      next();
    },
    state: () => ({ inFlight, clients: held.size }),
  };
}
