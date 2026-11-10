import { describe, expect, it } from "vitest";
import {
  MetricsRegistry,
  UnboundedLabelError,
  assertBoundedLabels,
  isBoundedLabelValue,
} from "../../shared/src/metrics.js";

function sample(text: string, name: string): number | undefined {
  const line = text.split("\n").find((entry) => entry.startsWith(`${name} `));
  return line ? Number(line.slice(name.length + 1)) : undefined;
}

describe("metrics exposition", () => {
  it("renders a counter with HELP, TYPE and sorted labels", () => {
    const registry = new MetricsRegistry({ cacheMs: 0 });
    registry
      .counter("sandbox_http_requests_total", "HTTP requests")
      .inc({ method: "POST", route: "/v1/sessions", status: "201" });

    const text = registry.render();
    expect(text).toContain("# HELP sandbox_http_requests_total HTTP requests");
    expect(text).toContain("# TYPE sandbox_http_requests_total counter");
    expect(text).toContain(
      'sandbox_http_requests_total{method="POST",route="/v1/sessions",status="201"} 1',
    );
  });

  it("renders a gauge and accumulates inc/dec", () => {
    const registry = new MetricsRegistry({ cacheMs: 0 });
    const gauge = registry.gauge("sandbox_operations_active", "Operations in flight");
    gauge.inc();
    gauge.inc();
    gauge.dec();
    expect(sample(registry.render(), "sandbox_operations_active")).toBe(1);
  });

  it("renders empty families as zero instead of omitting them", () => {
    const registry = new MetricsRegistry({ cacheMs: 0 });
    registry.counter("sandbox_empty_total", "Never incremented");
    registry.gauge("sandbox_empty_gauge", "Never set");
    registry.histogram("sandbox_empty_duration_seconds", "Never observed", [0.5, 1]);

    const text = registry.render();
    expect(text).toContain("sandbox_empty_total 0");
    expect(text).toContain("sandbox_empty_gauge 0");
    expect(text).toContain('sandbox_empty_duration_seconds_bucket{le="0.5"} 0');
    expect(text).toContain('sandbox_empty_duration_seconds_bucket{le="+Inf"} 0');
    expect(text).toContain("sandbox_empty_duration_seconds_sum 0");
    expect(text).toContain("sandbox_empty_duration_seconds_count 0");
  });

  it("renders cumulative histogram buckets and a +Inf overflow", () => {
    const registry = new MetricsRegistry({ cacheMs: 0 });
    const histogram = registry.histogram("sandbox_ready_duration_seconds", "Ready", [0.5, 1, 2]);
    histogram.observe(0.25);
    histogram.observe(0.75);
    histogram.observe(3);

    const text = registry.render();
    expect(sample(text, 'sandbox_ready_duration_seconds_bucket{le="0.5"}')).toBe(1);
    expect(sample(text, 'sandbox_ready_duration_seconds_bucket{le="1"}')).toBe(2);
    expect(sample(text, 'sandbox_ready_duration_seconds_bucket{le="2"}')).toBe(2);
    expect(sample(text, 'sandbox_ready_duration_seconds_bucket{le="+Inf"}')).toBe(3);
    expect(sample(text, "sandbox_ready_duration_seconds_sum")).toBeCloseTo(4);
    expect(sample(text, "sandbox_ready_duration_seconds_count")).toBe(3);
  });

  it("escapes quotes, backslashes and newlines in label values", () => {
    const registry = new MetricsRegistry({ cacheMs: 0 });
    registry.counter("sandbox_test_total", "Escaping").inc({ route: '/v1/a"b\\c\nd' });
    expect(registry.render()).toContain('route="/v1/a\\"b\\\\c\\nd"');
  });

  it("keeps histogram label sets independent", () => {
    const registry = new MetricsRegistry({ cacheMs: 0 });
    const histogram = registry.histogram("sandbox_http_request_duration_seconds", "HTTP", [1]);
    histogram.observe(0.1, { route: "/a" });
    histogram.observe(2, { route: "/b" });

    const text = registry.render();
    expect(sample(text, 'sandbox_http_request_duration_seconds_bucket{le="1",route="/a"}')).toBe(1);
    expect(sample(text, 'sandbox_http_request_duration_seconds_bucket{le="1",route="/b"}')).toBe(0);
    expect(sample(text, 'sandbox_http_request_duration_seconds_bucket{le="+Inf",route="/b"}')).toBe(1);
  });
});

describe("label cardinality guard", () => {
  it("accepts bounded enum labels", () => {
    expect(() =>
      assertBoundedLabels({
        result: "ok",
        status: "200",
        method: "POST",
        route: "/v1/sessions/:id",
        reason: "provisioning_timeout",
        scope: "payer",
      }),
    ).not.toThrow();
  });

  it("rejects session ids, request ids and opaque tokens", () => {
    expect(() => assertBoundedLabels({ sessionId: "sbx_0123456789abcdef" })).toThrow(
      UnboundedLabelError,
    );
    expect(() => assertBoundedLabels({ requestId: "req_0123456789abcdef" })).toThrow(
      UnboundedLabelError,
    );
    expect(() => assertBoundedLabels({ id: "9f8e7d6c5b4a39281706" })).toThrow(UnboundedLabelError);
    expect(() => assertBoundedLabels({ value: "a".repeat(40) })).toThrow(UnboundedLabelError);
  });

  it("allows build identity values that look id-shaped", () => {
    expect(() => assertBoundedLabels({ commit: "a".repeat(40), version: "0.1.18" })).not.toThrow();
    expect(isBoundedLabelValue("0.1.18")).toBe(true);
  });

  it("is opt-in: the default registry accepts anything", () => {
    const registry = new MetricsRegistry({ cacheMs: 0 });
    registry.counter("sandbox_test_total", "No guard").inc({ sessionId: "sbx_0123456789abcdef" });
    expect(registry.render()).toContain('sessionId="sbx_0123456789abcdef"');
  });

  it("rejects an unbounded value when the guard is enabled", () => {
    const registry = new MetricsRegistry({ cacheMs: 0, guardLabels: true });
    expect(() =>
      registry.counter("sandbox_test_total", "Guarded").inc({ sessionId: "sbx_0123456789abcdef" }),
    ).toThrow(UnboundedLabelError);
  });
});
