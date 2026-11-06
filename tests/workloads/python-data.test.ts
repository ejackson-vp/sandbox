import { describe, expect, it } from "vitest";
import { makeCsv, parseGroupedCsv } from "../../examples/python-data-processing/lib.js";

describe("Python data-processing workload fixture", () => {
  it("generates 100k deterministic rows below the current transfer limit", () => {
    const { csv, expected, grouped } = makeCsv();
    expect(expected.rows).toBe(100_000);
    expect(expected.categories).toBe(5);
    expect(expected.filteredRows).toBe(50_000);
    expect(expected.maxValue).toBe(999);
    expect(csv.byteLength).toBeLessThan(8 * 1024 * 1024);
    expect([...grouped.values()].reduce((sum, row) => sum + row.rows, 0)).toBe(100_000);
  });

  it("parses the pandas result shape", () => {
    const parsed = parseGroupedCsv("category,rows,value_sum,value_mean\nalpha,20000,10000,0.5\n");
    expect(parsed.get("alpha")).toEqual({ rows: 20_000, sum: 10_000, mean: 0.5 });
  });
});
