/**
 * Private metrics listener.
 *
 * Every role exposes the registry on `METRICS_PORT`, bound to the pod network,
 * and never on the service listener. The public ingress routes `/` to the API's
 * service port, so this module is what keeps `/metrics` unreachable from the
 * tailnet.
 */
import http from "node:http";
import { metrics, type MetricsRegistry } from "./metrics.js";

export interface MetricsServerOptions {
  /** 0 asks the OS for an ephemeral port (tests). */
  port: number;
  /** Defaults to 0.0.0.0: the pod network, filtered by NetworkPolicy. */
  host?: string;
  registry?: MetricsRegistry;
  /**
   * Refresh scrape-time gauges (store size, relay registry size, runtime
   * counters) before rendering. Errors are swallowed so one collector cannot
   * take the scrape endpoint down.
   */
  onScrape?: () => void | Promise<void>;
}

/** A plain HTTP server: no Express, no auth, no other routes. */
export function createMetricsServer(options: MetricsServerOptions): http.Server {
  const registry = options.registry ?? metrics;
  return http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if ((req.method !== "GET" && req.method !== "HEAD") || path !== "/metrics") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found\n");
      return;
    }
    void (async () => {
      try {
        await options.onScrape?.();
      } catch {
        // A collector is diagnostic; render whatever the registry already has.
      }
      const body = registry.render();
      res.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(req.method === "HEAD" ? undefined : body);
    })();
  });
}

export function listenMetricsServer(
  server: http.Server,
  options: MetricsServerOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "0.0.0.0", () => resolve());
  });
}

/** Convenience for `main`: create and bind in one call. */
export async function startMetricsServer(options: MetricsServerOptions): Promise<http.Server> {
  const server = createMetricsServer(options);
  await listenMetricsServer(server, options);
  return server;
}
