export const CATEGORIES = ["alpha", "beta", "gamma", "delta", "epsilon"];
export const FILTER = 500;

export interface Summary {
  rows: number;
  filteredRows: number;
  categories: number;
  maxValue: number;
  meanValue: number;
}

export function makeCsv(rows = 100_000): {
  csv: Buffer;
  expected: Summary;
  grouped: Map<string, { rows: number; sum: number }>;
} {
  const lines = ["id,category,value"];
  const grouped = new Map<string, { rows: number; sum: number }>();
  let filtered = 0;
  let max = 0;
  let total = 0;
  for (let i = 0; i < rows; i += 1) {
    const category = CATEGORIES[i % CATEGORIES.length]!;
    const value = (i * 37) % 1000;
    lines.push(`${i},${category},${value}`);
    const bucket = grouped.get(category) ?? { rows: 0, sum: 0 };
    bucket.rows += 1;
    bucket.sum += value;
    grouped.set(category, bucket);
    if (value >= FILTER) filtered += 1;
    max = Math.max(max, value);
    total += value;
  }
  return {
    csv: Buffer.from(`${lines.join("\n")}\n`),
    expected: {
      rows,
      filteredRows: filtered,
      categories: CATEGORIES.length,
      maxValue: max,
      meanValue: total / rows,
    },
    grouped,
  };
}

export function parseGroupedCsv(text: string): Map<string, { rows: number; sum: number; mean: number }> {
  const [header, ...rows] = text.trim().split("\n");
  if (header !== "category,rows,value_sum,value_mean") {
    throw new Error(`unexpected result header: ${header}`);
  }
  return new Map(rows.map((line) => {
    const [category, count, sum, mean] = line.split(",");
    return [category!, { rows: Number(count), sum: Number(sum), mean: Number(mean) }];
  }));
}
