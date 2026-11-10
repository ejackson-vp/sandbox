import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { MetricsRegistry } from "../../shared/src/metrics.js";
import { httpMetricsMiddleware, routeTemplate } from "../../shared/src/http-metrics.js";
import { createMetricsServer, listenMetricsServer } from "../../shared/src/metrics-http.js";

const servers: http.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      servers.push(server);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

describe("HTTP route metrics", () => {
  it("uses the route template, never the concrete session id", async () => {
    const registry = new MetricsRegistry({ cacheMs: 0 });
    const app = express();
    app.use(httpMetricsMiddleware(registry));
    app.get("/v1/sessions/:id", (_req, res) => {
      res.json({ ok: true });
    });
    const port = await listen(http.createServer(app));

    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/sbx_0123456789abcdef`);
    expect(res.status).toBe(200);

    const text = registry.render();
    expect(text).toContain(
      'sandbox_http_requests_total{method="GET",route="/v1/sessions/:id",status="200"} 1',
    );
    expect(text).not.toContain("sbx_0123456789abcdef");
    expect(text).toContain(
      'sandbox_http_request_duration_seconds_count{method="GET",route="/v1/sessions/:id"} 1',
    );
  });

  it("collapses an unmatched path to `unmatched`", async () => {
    const registry = new MetricsRegistry({ cacheMs: 0 });
    const app = express();
    app.use(httpMetricsMiddleware(registry));
    const port = await listen(http.createServer(app));

    const res = await fetch(`http://127.0.0.1:${port}/sbx_0123456789abcdef`);
    expect(res.status).toBe(404);
    expect(registry.render()).toContain(
      'sandbox_http_requests_total{method="GET",route="unmatched",status="404"} 1',
    );
  });

  it("maps unknown methods and missing routes to bounded labels", () => {
    expect(routeTemplate({})).toBe("unmatched");
    expect(routeTemplate({ baseUrl: "/internal", route: { path: "/:sessionId/state" } })).toBe(
      "/internal/:sessionId/state",
    );
  });
});

describe("private metrics listener", () => {
  it("serves only /metrics and refreshes collectors on scrape", async () => {
    const registry = new MetricsRegistry({ cacheMs: 0 });
    let scrapes = 0;
    const server = createMetricsServer({
      port: 0,
      host: "127.0.0.1",
      registry,
      onScrape: () => {
        scrapes += 1;
        registry.gauge("sandbox_sqlite_size_bytes", "size").set({}, 42);
      },
    });
    await listenMetricsServer(server, { port: 0, host: "127.0.0.1" });
    servers.push(server);

    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const metrics = await fetch(`${base}/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("content-type")).toContain("text/plain; version=0.0.4");
    expect(await metrics.text()).toContain("sandbox_sqlite_size_bytes 42");
    expect(scrapes).toBe(1);

    const other = await fetch(`${base}/v1/sessions`);
    expect(other.status).toBe(404);
  });
});
