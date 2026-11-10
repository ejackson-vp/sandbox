/**
 * Minimal Prometheus-compatible metrics registry.
 *
 * Deliberately dependency-free and label-bounded: callers pass fixed label
 * sets (route, method, status class, op, result). Session ids, capabilities,
 * commands, paths and payloads must never appear here.
 *
 * The registry is intentionally small. A dedicated listener (see
 * `metrics-http.ts`) exposes `render()` on `METRICS_PORT`; the public service
 * listeners never expose it.
 */

export type Labels = Record<string, string>;

/**
 * Label names whose values are known to be low-cardinality even though they
 * may look id-shaped (a build commit is one value per release).
 */
const ID_LIKE_ALLOWED_LABEL_NAMES = new Set(["commit", "version"]);

/**
 * Values that look like an identifier rather than a bounded enum. These are
 * deliberately conservative: a false positive is cheaper than a metric that
 * grows with sessions.
 */
const ID_LIKE_VALUE_PATTERNS: RegExp[] = [
  /^sbx_[A-Za-z0-9_-]{6,}$/, // session id
  /^warm_[A-Za-z0-9_-]{6,}$/, // warm-pool session id
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // uuid
  /^[0-9a-f]{16,}$/i, // opaque hex token / request id / capability hash
  /^(req|request|op|operation)[_-][A-Za-z0-9_-]{6,}$/i, // request id
  /^[A-Za-z0-9_-]{32,}$/, // base64url/opaque token
];

/** True when a label value is plausibly bounded. Test-only guard input. */
export function isBoundedLabelValue(value: string): boolean {
  return !ID_LIKE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

export class UnboundedLabelError extends Error {
  constructor(readonly label: string) {
    // Do not echo the value: it may be the session id we are refusing to keep.
    super(`unbounded metric label "${label}" looks like an identifier`);
    this.name = "UnboundedLabelError";
  }
}

/**
 * Reject labels that look like session or request ids. Enabled explicitly
 * (tests and `METRICS_STRICT_LABELS=1`), never on the hot path by default.
 */
export function assertBoundedLabels(labels: Labels): void {
  for (const [name, value] of Object.entries(labels)) {
    if (ID_LIKE_ALLOWED_LABEL_NAMES.has(name)) continue;
    if (!isBoundedLabelValue(value)) throw new UnboundedLabelError(name);
  }
}

function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

function sanitizeHelp(help: string): string {
  return help.replace(/[\r\n]+/g, " ").trim();
}

function keyOf(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

function renderLabels(labels: Labels, extra?: Labels): string {
  const merged = { ...labels, ...(extra ?? {}) };
  const body = Object.entries(merged)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(",");
  return body ? `{${body}}` : "";
}

export interface CounterLike {
  inc(labels?: Labels, amount?: number): void;
}

class Counter implements CounterLike {
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    private readonly guard: boolean,
  ) {}

  inc(labels: Labels = {}, amount = 1): void {
    if (this.guard) assertBoundedLabels(labels);
    const key = keyOf(labels);
    const entry = this.values.get(key) ?? { labels, value: 0 };
    entry.value += amount;
    this.values.set(key, entry);
  }

  render(): string {
    if (this.values.size === 0) {
      return `# HELP ${this.name} ${sanitizeHelp(this.help)}\n# TYPE ${this.name} counter\n${this.name} 0\n`;
    }
    let out = `# HELP ${this.name} ${sanitizeHelp(this.help)}\n# TYPE ${this.name} counter\n`;
    for (const sample of this.values.values()) {
      out += `${this.name}${renderLabels(sample.labels)} ${sample.value}\n`;
    }
    return out;
  }
}

class Gauge {
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    private readonly guard: boolean,
  ) {}

  set(labels: Labels, value: number): void {
    if (this.guard) assertBoundedLabels(labels);
    this.values.set(keyOf(labels), { labels, value });
  }

  inc(labels: Labels = {}, amount = 1): void {
    if (this.guard) assertBoundedLabels(labels);
    const key = keyOf(labels);
    const entry = this.values.get(key) ?? { labels, value: 0 };
    entry.value += amount;
    this.values.set(key, entry);
  }

  dec(labels: Labels = {}, amount = 1): void {
    this.inc(labels, -amount);
  }

  render(): string {
    let out = `# HELP ${this.name} ${sanitizeHelp(this.help)}\n# TYPE ${this.name} gauge\n`;
    if (this.values.size === 0) out += `${this.name} 0\n`;
    for (const sample of this.values.values()) {
      out += `${this.name}${renderLabels(sample.labels)} ${sample.value}\n`;
    }
    return out;
  }
}

class Histogram {
  private readonly buckets: number[];
  private readonly values = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    buckets: number[],
    private readonly guard: boolean,
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value) || value < 0) return;
    if (this.guard) assertBoundedLabels(labels);
    const key = keyOf(labels);
    let entry = this.values.get(key);
    if (!entry) {
      entry = { labels, counts: new Array(this.buckets.length + 1).fill(0), sum: 0, count: 0 };
      this.values.set(key, entry);
    }
    // Cumulative buckets: count everything <= bucket.
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) entry.counts[i]! += 1;
    }
    entry.sum += value;
    entry.count += 1;
  }

  render(): string {
    let out = `# HELP ${this.name} ${sanitizeHelp(this.help)}\n# TYPE ${this.name} histogram\n`;
    if (this.values.size === 0) {
      for (const bucket of this.buckets) {
        out += `${this.name}_bucket${renderLabels({}, { le: String(bucket) })} 0\n`;
      }
      out += `${this.name}_bucket${renderLabels({}, { le: "+Inf" })} 0\n`;
      out += `${this.name}_sum 0\n${this.name}_count 0\n`;
      return out;
    }
    for (const entry of this.values.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        out += `${this.name}_bucket${renderLabels(entry.labels, { le: String(this.buckets[i]) })} ${entry.counts[i]}\n`;
      }
      out += `${this.name}_bucket${renderLabels(entry.labels, { le: "+Inf" })} ${entry.count}\n`;
      out += `${this.name}_sum${renderLabels(entry.labels)} ${entry.sum}\n`;
      out += `${this.name}_count${renderLabels(entry.labels)} ${entry.count}\n`;
    }
    return out;
  }
}

export interface MetricsRegistryOptions {
  /** Render cache TTL. 0 disables caching (tests, per-scrape collectors). */
  cacheMs?: number;
  /** Reject id-shaped label values. Test-only; off by default. */
  guardLabels?: boolean;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, Counter>();
  private readonly gauges = new Map<string, Gauge>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly cacheMs: number;
  private readonly guardLabels: boolean;
  private renderedCache: { at: number; text: string } | null = null;

  constructor(options: MetricsRegistryOptions = {}) {
    this.cacheMs = options.cacheMs ?? 500;
    this.guardLabels = options.guardLabels ?? false;
  }

  counter(name: string, help: string): Counter {
    let c = this.counters.get(name);
    if (!c) {
      c = new Counter(name, help, this.guardLabels);
      this.counters.set(name, c);
    }
    return c;
  }

  gauge(name: string, help: string): Gauge {
    let g = this.gauges.get(name);
    if (!g) {
      g = new Gauge(name, help, this.guardLabels);
      this.gauges.set(name, g);
    }
    return g;
  }

  histogram(name: string, help: string, buckets: number[]): Histogram {
    const cacheKey = `${name}:${buckets.join(",")}`;
    let h = this.histograms.get(cacheKey);
    if (!h) {
      h = new Histogram(name, help, buckets, this.guardLabels);
      this.histograms.set(cacheKey, h);
    }
    return h;
  }

  render(): string {
    const now = Date.now();
    if (this.cacheMs > 0 && this.renderedCache && now - this.renderedCache.at < this.cacheMs) {
      return this.renderedCache.text;
    }
    const parts: string[] = [];
    for (const c of this.counters.values()) parts.push(c.render());
    for (const g of this.gauges.values()) parts.push(g.render());
    for (const h of this.histograms.values()) parts.push(h.render());
    const text = parts.join("");
    if (this.cacheMs > 0) this.renderedCache = { at: now, text };
    return text;
  }
}

/** Latency buckets (seconds) used across the service. */
export const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 20, 30, 60];

/**
 * Default private metrics port. Each role runs in its own pod, so they can all
 * use 9100; a local single-host run must override `METRICS_PORT` per process.
 */
export const DEFAULT_METRICS_PORT = 9100;

export const metrics = new MetricsRegistry({
  guardLabels: process.env.METRICS_STRICT_LABELS === "1",
});
