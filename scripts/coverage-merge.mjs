/**
 * Merge Vitest `lcov` reports from more than one suite into one summary.
 *
 * The badge used to be whatever the unit suite alone reached, which scored the
 * client and wiring code at zero because its only tests are end-to-end. Merging
 * the integration report with the unit one takes lines from 69.6% to 77.7% and
 * costs no new tests: the suites already ran, they were just measured
 * separately.
 *
 * Coverage is a union, not an average. A line counts as covered if any suite
 * ran it, so the merge takes the maximum hit count per line, per function and
 * per branch. Averages would punish a file that only one suite can reach, which
 * is the whole class of file this is meant to account for.
 *
 * Usage:
 *   node scripts/coverage-merge.mjs <out-dir> <lcov...> [--floor-lines N]
 *
 * Writes `<out-dir>/lcov.info` and `<out-dir>/coverage-summary.json` in the
 * shape `scripts/coverage-badge.mjs` already reads, so the badge job only has to
 * point at a different directory. Exits non-zero when a floor is given and the
 * merged total is under it, which is the gate the unit run cannot express: it
 * only sees its own suite.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const args = process.argv.slice(2);
const floors = {};
const positional = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  const floor = arg.match(/^--floor-(lines|branches|functions)$/);
  if (floor) {
    floors[floor[1]] = Number(args[index + 1]);
    index += 1;
    continue;
  }
  positional.push(arg);
}

const [outDir, ...inputs] = positional;
if (!outDir || inputs.length === 0) {
  console.error("usage: node scripts/coverage-merge.mjs <out-dir> <lcov...> [--floor-lines N]");
  process.exit(2);
}

/**
 * Lcov paths are absolute in CI and relative locally. Reduce both to the
 * repo-relative form the summary and the include globs use.
 */
function normalize(file) {
  const absolute = resolve(root, file);
  return absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : file;
}

/** file -> line -> hits, plus function and branch counters keyed the same way. */
function emptyEntry() {
  return { lines: new Map(), functions: new Map(), branches: new Map() };
}

const merged = new Map();

for (const input of inputs) {
  let current;
  for (const raw of readFileSync(input, "utf8").split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("SF:")) {
      const file = normalize(line.slice(3));
      if (!merged.has(file)) merged.set(file, emptyEntry());
      current = merged.get(file);
      continue;
    }
    if (!current) continue;

    // Increment records: DA:<line>,<hits>; FNDA:<hits>,<name>; BRDA:<line>,<block>,<branch>,<taken>
    if (line.startsWith("DA:")) {
      const [number, hits] = line.slice(3).split(",");
      const key = Number(number);
      current.lines.set(key, Math.max(current.lines.get(key) ?? 0, Number(hits) || 0));
    } else if (line.startsWith("FNDA:")) {
      const comma = line.indexOf(",");
      const hits = Number(line.slice(5, comma)) || 0;
      const name = line.slice(comma + 1);
      current.functions.set(name, Math.max(current.functions.get(name) ?? 0, hits));
    } else if (line.startsWith("BRDA:")) {
      const [number, block, branch, taken] = line.slice(5).split(",");
      const key = `${number},${block},${branch}`;
      // `-` means the branch was never reached, which is not the same as zero
      // hits for the purpose of a union: another suite may have reached it.
      const hits = taken === "-" ? 0 : Number(taken) || 0;
      current.branches.set(key, Math.max(current.branches.get(key) ?? 0, hits));
    }
  }
}

const pct = (covered, total) =>
  total === 0 ? 100 : Math.round((covered / total) * 10_000) / 100;

const summary = {};
const totals = { lines: [0, 0], functions: [0, 0], branches: [0, 0] };
const lcov = [];

for (const [file, entry] of [...merged.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const count = (map) => {
    let covered = 0;
    for (const hits of map.values()) if (hits > 0) covered += 1;
    return [covered, map.size];
  };
  const [lineCovered, lineTotal] = count(entry.lines);
  const [functionCovered, functionTotal] = count(entry.functions);
  const [branchCovered, branchTotal] = count(entry.branches);

  summary[`${root}/${file}`] = {
    lines: { total: lineTotal, covered: lineCovered, skipped: 0, pct: pct(lineCovered, lineTotal) },
    // Lcov does not separate statements from lines; the badge only reads lines.
    statements: { total: lineTotal, covered: lineCovered, skipped: 0, pct: pct(lineCovered, lineTotal) },
    functions: {
      total: functionTotal,
      covered: functionCovered,
      skipped: 0,
      pct: pct(functionCovered, functionTotal),
    },
    branches: {
      total: branchTotal,
      covered: branchCovered,
      skipped: 0,
      pct: pct(branchCovered, branchTotal),
    },
  };

  totals.lines[0] += lineCovered;
  totals.lines[1] += lineTotal;
  totals.functions[0] += functionCovered;
  totals.functions[1] += functionTotal;
  totals.branches[0] += branchCovered;
  totals.branches[1] += branchTotal;

  lcov.push(
    `SF:${file}`,
    ...[...entry.functions].map(([name, hits]) => `FNDA:${hits},${name}`),
    ...[...entry.functions].map(([name], index) => `FN:${index + 1},${name}`).reverse(),
    ...[...entry.branches].map(([key, hits]) => `BRDA:${key},${hits}`),
    ...[...entry.lines].sort(([a], [b]) => a - b).map(([number, hits]) => `DA:${number},${hits}`),
    `LF:${lineTotal}`,
    `LH:${lineCovered}`,
    "end_of_record",
  );
}

summary.total = {
  lines: {
    total: totals.lines[1],
    covered: totals.lines[0],
    skipped: 0,
    pct: pct(totals.lines[0], totals.lines[1]),
  },
  statements: {
    total: totals.lines[1],
    covered: totals.lines[0],
    skipped: 0,
    pct: pct(totals.lines[0], totals.lines[1]),
  },
  functions: {
    total: totals.functions[1],
    covered: totals.functions[0],
    skipped: 0,
    pct: pct(totals.functions[0], totals.functions[1]),
  },
  branches: {
    total: totals.branches[1],
    covered: totals.branches[0],
    skipped: 0,
    pct: pct(totals.branches[0], totals.branches[1]),
  },
};

mkdirSync(dirname(`${outDir}/coverage-summary.json`), { recursive: true });
writeFileSync(`${outDir}/coverage-summary.json`, `${JSON.stringify(summary)}\n`);
writeFileSync(`${outDir}/lcov.info`, `${lcov.join("\n")}\n`);

// Per top-level package, so a merge that helps one module and hurts another is
// visible in the log rather than hidden in the total.
const perPackage = new Map();
for (const [file, entry] of merged) {
  const name = file.split("/")[0];
  const bucket = perPackage.get(name) ?? [0, 0];
  for (const hits of entry.lines.values()) {
    bucket[1] += 1;
    if (hits > 0) bucket[0] += 1;
  }
  perPackage.set(name, bucket);
}
for (const [name, [covered, total]] of [...perPackage].sort()) {
  console.log(`coverage-merge: ${name.padEnd(12)} ${covered}/${total} ${pct(covered, total).toFixed(1)}%`);
}

const reported = {
  lines: summary.total.lines.pct,
  branches: summary.total.branches.pct,
  functions: summary.total.functions.pct,
};
console.log(
  `coverage-merge: total lines ${reported.lines.toFixed(1)}% ` +
    `branches ${reported.branches.toFixed(1)}% functions ${reported.functions.toFixed(1)}%`,
);

let failed = false;
for (const [metric, floor] of Object.entries(floors)) {
  if (reported[metric] < floor) {
    console.error(`coverage-merge: ${metric} ${reported[metric].toFixed(1)}% is under the floor of ${floor}%`);
    failed = true;
  }
}
if (failed) process.exit(1);
