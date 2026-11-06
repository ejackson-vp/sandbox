/**
 * Minimal Prometheus-compatible metrics registry.
 *
 * Deliberately dependency-free and label-bounded: callers pass fixed label
 * sets (route, method, status class, op, result). Session ids, capabilities,
 * commands, paths and payloads must never appear here.
 */

export type Labels = Record<string, string>;

interface Sample {
  labels: Labels;
  value: number;
}

function keyOf(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([k, v]) => `${k}="${v.replace(/["\\]/g, "_")}"`).join(",");
}

function renderLabels(labels: Labels, extra?: Labels): string {
  const merged = { ...labels, ...(extra ?? {}) };
  const body = Object.entries(merged)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}="${v.replace(/["\\]/g, "_")}"`)
    .join(",");
  return body ? `{${body}}` : "";
}

class Counter {
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, amount = 1): void {
    const key = keyOf(labels);
    const entry = this.values.get(key) ?? { labels, value: 0 };
    entry.value += amount;
    this.values.set(key, entry);
  }

  render(): string {
    if (this.values.size === 0) {
      return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} counter\n${this.name} 0\n`;
    }
    let out = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} counter\n`;
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
  ) {}

  set(labels: Labels, value: number): void {
    this.values.set(keyOf(labels), { labels, value });
  }

  inc(labels: Labels = {}, amount = 1): void {
    const key = keyOf(labels);
    const entry = this.values.get(key) ?? { labels, value: 0 };
    entry.value += amount;
    this.values.set(key, entry);
  }

  dec(labels: Labels = {}, amount = 1): void {
    this.inc(labels, -amount);
  }

  render(): string {
    let out = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} gauge\n`;
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
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value) || value < 0) return;
    const key = keyOf(labels);
    let entry = this.values.get(key);
    if (!entry) {
      entry = { labels, counts: new Array(this.buckets.length + 1).fill(0), sum: 0, count: 0 };
      this.values.set(key, entry);
    }
    // Cumulative buckets: count everything <= bucket.
    let placed = false;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) {
        entry.counts[i]! += 1;
        placed = true;
      }
    }
    if (!placed) entry.counts[this.buckets.length]! += 1;
    entry.sum += value;
    entry.count += 1;
  }

  render(): string {
    let out = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} histogram\n`;
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

export class MetricsRegistry {
  private readonly counters = new Map<string, Counter>();
  private readonly gauges = new Map<string, Gauge>();
  private readonly histograms = new Map<string, Histogram>();
  private renderedCache: { at: number; text: string } | null = null;

  counter(name: string, help: string): Counter {
    let c = this.counters.get(name);
    if (!c) {
      c = new Counter(name, help);
      this.counters.set(name, c);
    }
    return c;
  }

  gauge(name: string, help: string): Gauge {
    let g = this.gauges.get(name);
    if (!g) {
      g = new Gauge(name, help);
      this.gauges.set(name, g);
    }
    return g;
  }

  histogram(name: string, help: string, buckets: number[]): Histogram {
    const cacheKey = `${name}:${buckets.join(",")}`;
    let h = this.histograms.get(cacheKey);
    if (!h) {
      h = new Histogram(name, help, buckets);
      this.histograms.set(cacheKey, h);
    }
    return h;
  }

  render(): string {
    const now = Date.now();
    if (this.renderedCache && now - this.renderedCache.at < 500) return this.renderedCache.text;
    const parts: string[] = [];
    for (const c of this.counters.values()) parts.push(c.render());
    for (const g of this.gauges.values()) parts.push(g.render());
    for (const h of this.histograms.values()) parts.push(h.render());
    const text = parts.join("");
    this.renderedCache = { at: now, text };
    return text;
  }
}

/** Latency buckets (seconds) used across the service. */
export const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 20, 30, 60];

export const metrics = new MetricsRegistry();
