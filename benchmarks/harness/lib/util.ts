/** Small utilities shared by the benchmark harness. */

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Summary {
  count: number;
  min: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  stdev: number;
}

export function summarize(values: number[]): Summary | null {
  const data = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (data.length === 0) return null;
  const at = (q: number): number => {
    // Nearest-rank percentile; for small samples this is conservative and we
    // always report `count` alongside so p99 is never read as meaningful from
    // a tiny sample.
    const rank = Math.ceil(q * data.length) - 1;
    return data[Math.min(data.length - 1, Math.max(0, rank))]!;
  };
  const mean = data.reduce((a, b) => a + b, 0) / data.length;
  const variance = data.length > 1 ? data.reduce((a, b) => a + (b - mean) ** 2, 0) / (data.length - 1) : 0;
  return {
    count: data.length,
    min: data[0]!,
    mean,
    p50: at(0.5),
    p90: at(0.9),
    p95: at(0.95),
    p99: at(0.99),
    max: data[data.length - 1]!,
    stdev: Math.sqrt(variance),
  };
}

export function fmtMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return "n/a";
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value.toFixed(1)}ms`;
}

export function fmtBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let v = value;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Run tasks with bounded concurrency, preserving result order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [keys.join(","), ...rows.map((r) => keys.map((k) => escape(r[k])).join(","))].join("\n") + "\n";
}

export function nowIso(): string {
  return new Date().toISOString();
}
