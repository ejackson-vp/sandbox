/**
 * Turn a Vitest `json-summary` report into a shields.io endpoint badge.
 *
 * The README badge reads the JSON this writes to the `badges` branch, so the
 * percentage is measured in CI instead of being hard-coded in Markdown.
 *
 * Usage: node scripts/coverage-badge.mjs [summary.json] [out.json] [metric]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [
  summaryPath = "coverage/coverage-summary.json",
  outPath = "coverage.json",
  metric = "lines",
] = process.argv.slice(2);

const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const value = summary.total?.[metric]?.pct;

if (typeof value !== "number" || Number.isNaN(value)) {
  console.error(`coverage-badge: no ${metric} percentage in ${summaryPath}`);
  process.exit(1);
}

const pct = Math.round(value * 10) / 10;
const color =
  pct >= 90 ? "brightgreen"
  : pct >= 80 ? "green"
  : pct >= 70 ? "yellowgreen"
  : pct >= 60 ? "yellow"
  : pct >= 50 ? "orange"
  : "red";

const badge = {
  schemaVersion: 1,
  label: "coverage",
  message: `${pct.toFixed(1)}%`,
  color,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(badge, null, 2)}\n`);
console.log(`coverage-badge: ${metric} ${pct.toFixed(1)}% -> ${outPath}`);
