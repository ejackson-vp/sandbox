#!/usr/bin/env node
/**
 * Coupling report for the internal module graph.
 *
 * The refactor this reports on was steered by Ca, instability and distance from
 * the main sequence, measured with throwaway scripts. That makes every claim in
 * the notes unverifiable by anyone else, so this file is the measurement.
 *
 * Definitions (Martin, "Clean Architecture", ch. 14), applied to TypeScript
 * modules rather than packages:
 *
 *   Ca  afferent coupling: how many internal modules import this one.
 *   Ce  efferent coupling: how many internal modules it imports.
 *   I   instability: Ce / (Ca + Ce). 0 is a stable base, 1 is a leaf.
 *   A   abstractness: exported interfaces and types over all exported
 *       declarations. Approximate by design: it counts `interface` and `type`
 *       plus `abstract class` as abstract, and `class`, `function`, `const`
 *       and `enum` as concrete.
 *   D   distance from the main sequence: |A + I - 1|. Zone of pain is low A
 *       with low I (stable and concrete); zone of uselessness is high A with
 *       high I (abstract and unstable, nothing depends on it).
 *
 * External packages, node builtins and `@x402s/*` subpath entries resolve to
 * the entry module, so a consumer of `@x402s/shared/protocol` is coupled to the
 * protocol entry and, transitively, to the modules it re-exports. A bare
 * `@x402s/shared` import is reported as an error: the package has no root
 * entry, and a file that uses one is reintroducing the barrel.
 *
 * Usage: node scripts/coupling.mjs [repoRoot] [--json] [--top N]
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const topIndex = args.indexOf("--top");
const TOP = topIndex === -1 ? 12 : Number(args[topIndex + 1]);
const rootArg = args.find((arg) => !arg.startsWith("--") && arg !== String(TOP));
const ROOT = resolve(rootArg ?? join(dirname(fileURLToPath(import.meta.url)), ".."));

const PACKAGES = ["shared", "sdk", "api", "controller", "cli"];
const SKIP = new Set(["node_modules", "dist", "bin", "coverage", ".git", "guest"]);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) yield path;
  }
}

/** Static imports, re-exports and dynamic imports in one pass. */
function importsOf(path) {
  const text = readFileSync(path, "utf8");
  const found = new Set();
  for (const re of [
    /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^;]*?from\s*["']([^"']+)["']/gs,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of text.matchAll(re)) found.add(match[1]);
  }
  return [...found];
}

const nodes = [];
for (const pkg of PACKAGES) {
  for (const file of walk(join(ROOT, pkg, "src"))) {
    nodes.push(relative(ROOT, file).split(sep).join("/"));
  }
}
const known = new Set(nodes);
const barrelImports = [];

function resolveSpecifier(from, specifier) {
  if (specifier.startsWith(".")) {
    const base = posix.normalize(posix.join(posix.dirname(from), specifier.replace(/\.js$/, "")));
    for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
      if (known.has(candidate)) return candidate;
    }
    return null;
  }
  const match = /^@x402s\/([a-z]+)(?:\/(.+))?$/.exec(specifier);
  if (!match) return null; // external package or builtin
  const [, pkg, sub] = match;
  if (!sub) {
    // A package entry is fine when the package has one; `shared` deliberately
    // has none, so a bare import there is the barrel coming back.
    const index = `${pkg}/src/index.ts`;
    if (known.has(index)) return index;
    barrelImports.push(`${from} imports "${specifier}"`);
    return null;
  }
  const entry = `${pkg}/src/entries/${sub}.ts`;
  return known.has(entry) ? entry : null;
}

const out = new Map(nodes.map((node) => [node, new Set()]));
for (const node of nodes) {
  for (const specifier of importsOf(join(ROOT, node))) {
    const target = resolveSpecifier(node, specifier);
    if (target !== null && target !== node) out.get(node).add(target);
  }
}

const inn = new Map(nodes.map((node) => [node, new Set()]));
for (const [node, targets] of out) {
  for (const target of targets) inn.get(target).add(node);
}

/** Exported-declaration counts, used for the abstractness approximation. */
function abstractness(node) {
  const text = readFileSync(join(ROOT, node), "utf8");
  const count = (re) => [...text.matchAll(re)].length;
  const abstract =
    count(/^export\s+(?:declare\s+)?(?:interface|type)\s+[A-Za-z0-9_$]+/gm) +
    count(/^export\s+(?:declare\s+)?abstract\s+class\s+[A-Za-z0-9_$]+/gm);
  const concrete =
    count(/^export\s+(?:declare\s+)?(?:async\s+)?class\s+[A-Za-z0-9_$]+/gm) +
    count(/^export\s+(?:declare\s+)?(?:async\s+)?function\s+[A-Za-z0-9_$]+/gm) +
    count(/^export\s+(?:declare\s+)?(?:const|let|var|enum)\s+[A-Za-z0-9_$]+/gm);
  const total = abstract + concrete;
  // A module that only re-exports has no abstractness to speak of. Reporting 1
  // or 0 would invent a position on the main sequence, so it is undefined here
  // and excluded from the mean.
  return { a: total === 0 ? null : abstract / total, declarations: total };
}

const metrics = nodes.map((node) => {
  const ca = inn.get(node).size;
  const ce = out.get(node).size;
  const i = ca + ce === 0 ? 0 : ce / (ca + ce);
  const { a, declarations } = abstractness(node);
  return {
    module: node,
    ca,
    ce,
    i,
    a,
    declarations,
    d: a === null ? null : Math.abs(a + i - 1),
  };
});

/** Tarjan, iterative enough for a graph this size. */
function cycles() {
  let index = 0;
  const indices = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const found = [];
  const visit = (node) => {
    indices.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of out.get(node)) {
      if (!indices.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), indices.get(next)));
      }
    }
    if (low.get(node) === indices.get(node)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1) found.push(component.sort());
    }
  };
  for (const node of nodes) if (!indices.has(node)) visit(node);
  return found.sort((a, b) => b.length - a.length);
}

const cycleList = cycles();
// Modules with no declarations (pure re-export entries such as sdk/src/index.ts)
// have no abstractness, so they have no distance either.
const measured = metrics.filter((m) => m.d !== null);
const meanD = measured.reduce((sum, m) => sum + m.d, 0) / measured.length;
const sorted = [...measured].sort((a, b) => b.d - a.d || b.ca - a.ca);
const edgeCount = [...out.values()].reduce((sum, set) => sum + set.size, 0);
const byPackage = {};
for (const pkg of PACKAGES) {
  const own = measured.filter((m) => m.module.startsWith(`${pkg}/`));
  byPackage[pkg] = {
    modules: own.length,
    meanD: own.length === 0 ? 0 : own.reduce((sum, m) => sum + m.d, 0) / own.length,
  };
}

if (asJson) {
  console.log(JSON.stringify({ modules: metrics.length, measured: measured.length, edges: edgeCount, meanD, byPackage, cycles: cycleList, modulesDetail: metrics, barrelImports }, null, 2));
  process.exit(barrelImports.length > 0 ? 1 : 0);
}

const pad = (value, width) => String(value).padStart(width);
console.log(`coupling: ${metrics.length} modules (${measured.length} measured, ${metrics.length - measured.length} pure re-export), ${edgeCount} internal edges, root ${ROOT}`);
console.log(
  `mean D ${meanD.toFixed(3)}; ` +
    Object.entries(byPackage)
      .map(([pkg, stat]) => `${pkg} ${stat.meanD.toFixed(3)} (${stat.modules})`)
      .join(", "),
);
console.log(`${cycleList.length} cycles`);
for (const component of cycleList.slice(0, 5)) {
  console.log(`  ${component.length} modules: ${component.slice(0, 4).join(", ")}${component.length > 4 ? ", ..." : ""}`);
}

console.log("\n  Ca   Ce     I     A     D  module");
for (const m of sorted.slice(0, TOP)) {
  console.log(
    `${pad(m.ca, 3)}  ${pad(m.ce, 3)}  ${m.i.toFixed(2)}  ${m.a.toFixed(2)}  ${m.d.toFixed(2)}  ${m.module}`,
  );
}

// A stable, concrete module with many dependents is the one that hurts: changes
// there ripple, and it carries no abstraction to absorb them. Small helpers are
// excluded: D punishes them by construction (I=0, A=0) and that is not the
// problem this metric is for.
const pain = sorted.filter((m) => m.ca >= 3 && m.i < 0.5 && m.a < 0.3 && m.declarations >= 4);
if (pain.length > 0) {
  console.log(`\nzone of pain (Ca >= 3, I < 0.5, A < 0.3, >= 4 declarations): ${pain.length}`);
  for (const m of pain.slice(0, 5)) console.log(`  ${m.module} Ca=${m.ca} D=${m.d.toFixed(2)}`);
}

if (barrelImports.length > 0) {
  console.error("\nroot barrel imports (the package has no root entry):");
  for (const line of barrelImports) console.error(`  ${line}`);
  process.exit(1);
}
