/**
 * Bounded HTTP request families.
 *
 * The route label is an Express *template* (`/v1/sessions/:id`), never the
 * concrete path: a raw path would make cardinality a function of session
 * count. Unmatched requests (404, body-parser failures) collapse to
 * `unmatched`. Method and status are fixed small sets.
 */
import { LATENCY_BUCKETS, metrics, type MetricsRegistry } from "./metrics.js";

interface MetricsRequest {
  method?: string;
  baseUrl?: string;
  route?: { path?: string };
}

interface MetricsResponse {
  statusCode: number;
  on(event: "finish", listener: () => void): unknown;
}

type MetricsNext = (err?: unknown) => void;

const HTTP_REQUESTS_TOTAL = "sandbox_http_requests_total";
const HTTP_REQUEST_DURATION = "sandbox_http_request_duration_seconds";

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** Map anything unexpected to `other` instead of accepting client input. */
function httpMethodLabel(method: string | undefined): string {
  const upper = (method ?? "").toUpperCase();
  return METHODS.has(upper) ? upper : "other";
}

/** The Express route template, or `unmatched`. Never contains a raw id. */
export function routeTemplate(req: MetricsRequest): string {
  const path = req.route?.path;
  if (typeof path !== "string" || path.length === 0) return "unmatched";
  const full = `${req.baseUrl ?? ""}${path}`;
  return full.length <= 128 ? full : "other";
}

export function registerHttpMetrics(registry: MetricsRegistry = metrics): void {
  registry.counter(HTTP_REQUESTS_TOTAL, "HTTP requests by route template, method and status");
  registry.histogram(
    HTTP_REQUEST_DURATION,
    "HTTP request duration by route template and method",
    LATENCY_BUCKETS,
  );
}

function observeHttpRequest(
  registry: MetricsRegistry,
  route: string,
  method: string,
  status: number,
  durationSeconds: number,
): void {
  registry.counter(HTTP_REQUESTS_TOTAL, "HTTP requests by route template, method and status").inc({
    route,
    method,
    status: String(status),
  });
  registry
    .histogram(
      HTTP_REQUEST_DURATION,
      "HTTP request duration by route template and method",
      LATENCY_BUCKETS,
    )
    .observe(durationSeconds, { route, method });
}

export function httpMetricsMiddleware(registry: MetricsRegistry = metrics) {
  registerHttpMetrics(registry);
  return (req: MetricsRequest, res: MetricsResponse, next: MetricsNext): void => {
    const started = process.hrtime.bigint();
    const method = httpMethodLabel(req.method);
    res.on("finish", () => {
      observeHttpRequest(
        registry,
        routeTemplate(req),
        method,
        res.statusCode,
        Number(process.hrtime.bigint() - started) / 1e9,
      );
    });
    next();
  };
}
