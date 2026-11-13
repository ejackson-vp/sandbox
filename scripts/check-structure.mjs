/**
 * Structural guardrail: keep modules reviewable.
 *
 * This is intentionally a blunt line-count check, not a style linter. It is a
 * backstop against the god files this refactor removed; the real rules live in
 * docs/architecture-principles.md.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, posix, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
// Ratchet: 550 is the target. Temporarily 650 because two controller modules
// (provisioning.ts, reconciler.ts) are above the 550 target. Lower this as they
// are split; never raise it again.
const MAX_LINES = 650;

/**
 * The size scan walks the repo from the root, because an include list is an
 * invitation to move a file just outside it: `verification/`, `site/`,
 * `examples/` and the repo root were all uncounted while ROOTS was an
 * allowlist. Only generated directories are skipped; nothing tracked lives in
 * them, and walking node_modules would take a minute.
 */
const EXCLUDED_DIRS = new Set([
  ".git",
  ".tmp-sandbox",
  "__pycache__",
  "artifacts",
  "bin",
  "coverage",
  "dist",
  "node_modules",
]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".go"]);

/**
 * The over-budget files, and the exact line count each one is at today.
 *
 * This is a ratchet that only shrinks. A file in here may not grow: the guard
 * fails and the pinned number may only go down. It fails on a shrink too, so
 * the number is lowered in the same change rather than drifting. An entry is
 * deleted only once the file fits, which the guard also enforces.
 *
 * What the script cannot see is the previous value of the map: growing a file
 * and raising its number in the same commit reads as a clean baseline. That one
 * is caught by reviewing this diff, not by the check, so keep the diff empty
 * unless a file got smaller.
 *
 * No issue tracks the remaining splits yet, so there is nothing to cite here.
 * When one is filed, add its number.
 */
const BASELINE = new Map([
  ["tests/integration/api-flow.test.ts", 1228],
  ["tests/unit/cli-commands.test.ts", 1001],
]);

function countLines(path) {
  // Count real lines: a file ending in "\n" must not gain a phantom line.
  return readFileSync(path, "utf8").replace(/\n$/, "").split("\n").length;
}

function printBaseline() {
  console.error(`baseline (over ${MAX_LINES} lines, pinned to the exact count):`);
  for (const [path, lines] of [...BASELINE].sort((a, b) => b[1] - a[1])) {
    console.error(`  ${lines}\t${path}`);
  }
}

/** Every counted source file under `dir`. */
function* sources(dir) {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      yield* sources(path);
    } else if (SOURCE_EXTENSIONS.has(extname(entry).toLowerCase())) {
      yield path;
    }
  }
}

function* files(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "bin") continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      yield* files(path);
    } else if (path.endsWith(".ts") || path.endsWith(".go")) {
      yield path;
    }
  }
}

const offenders = [];
const unused = [];
const grew = [];
const shrank = [];
const seen = new Set();

for (const path of sources(ROOT)) {
  const rel = relative(ROOT, path);
  const lines = countLines(path);
  const baseline = BASELINE.get(rel);
  seen.add(rel);
  if (baseline === undefined) {
    if (lines > MAX_LINES) offenders.push({ path: rel, lines });
  } else if (lines <= MAX_LINES) {
    // Fixed: the entry has to go in the same change.
    unused.push({ path: rel, lines, baseline });
  } else if (lines > baseline) {
    grew.push({ path: rel, lines, baseline });
  } else if (lines < baseline) {
    shrank.push({ path: rel, lines, baseline });
  }
}
for (const [rel, baseline] of BASELINE) {
  if (!seen.has(rel)) unused.push({ path: rel, lines: 0, baseline });
}

if (offenders.length + unused.length + grew.length + shrank.length > 0) {
  if (offenders.length > 0) {
    console.error(`files over ${MAX_LINES} lines that are not in BASELINE (split them):`);
    for (const { path, lines } of offenders.sort((a, b) => b.lines - a.lines)) {
      console.error(`  ${lines}\t${path}`);
    }
  }
  if (grew.length > 0) {
    console.error(
      "BASELINE files that grew (the pinned count may only go down; split the file):",
    );
    for (const { path, lines, baseline } of grew.sort((a, b) => b.lines - a.lines)) {
      console.error(`  ${path}: ${lines} lines now, baselined at ${baseline}`);
    }
  }
  if (shrank.length > 0) {
    console.error(
      "BASELINE files that shrank (lower the pinned count; delete the entry once it fits):",
    );
    for (const { path, lines, baseline } of shrank.sort((a, b) => b.lines - a.lines)) {
      console.error(`  ${path}: ${lines} lines now, baselined at ${baseline}`);
    }
  }
  if (unused.length > 0) {
    console.error(
      "BASELINE entries at or under budget (delete them, the ratchet only shrinks):",
    );
    for (const { path, lines, baseline } of unused.sort((a, b) => b.baseline - a.baseline)) {
      const now = lines === 0 ? "gone or no longer counted" : `${lines} lines now`;
      console.error(`  ${path}: ${now}, baselined at ${baseline}`);
    }
  }
  printBaseline();
  process.exit(1);
}

/**
 * Shared layering guard.
 *
 * `@x402s/shared` used to be a single barrel, so importing a wire type also
 * evaluated `crypto.ts` (node:crypto + libsodium-wrappers) and the metrics
 * listeners (node:http, node:perf_hooks). The subpath entry points in
 * `shared/src/entries/` fix that only as long as the graph stays layered:
 * anything a pure module imports is what a pure consumer pays for.
 *
 * Order matters. A module may import the layers below it and no further:
 *
 *   0 pure     types, decisions, env parsing. No I/O, no node builtins.
 *   1 crypto   node:crypto, libsodium-wrappers.
 *   2 payment  x402 schemes and the tier table on top of crypto.
 *   3 runtime  listeners, metrics, logs, rate limits, settlement lookup.
 *
 * Two edges are forbidden even though the order would allow them: runtime must
 * not reach crypto or payment. A process that only serves metrics or writes
 * logs should not load libsodium, which is the same reason the subpaths exist.
 *
 * `index.ts` and `entries/*` are aggregators and may import any layer.
 */
const SHARED = "shared/src";
const SHARED_LAYERS = [
  {
    name: "pure",
    pure: true,
    match: (rel) =>
      [
        "fp.ts",
        "protocol.ts",
        "env.ts",
        "ip.ts",
        "dev-attestation.ts",
        "runtimes.ts",
        "money.ts",
      ].includes(rel) ||
      rel.startsWith("protocol/") ||
      rel.startsWith("domain/") ||
      // The durable-call protocol (ADR 0011): pure predicates and value
      // objects shared by the API and the controller. No SQL, no I/O.
      rel.startsWith("durable/"),
  },
  {
    name: "crypto",
    match: (rel) =>
      ["crypto.ts", "commitment.ts", "attestation.ts", "capability.ts"].includes(rel),
  },
  {
    name: "payment",
    match: (rel) => ["payment.ts", "tiers.ts"].includes(rel),
  },
  {
    name: "runtime",
    match: (rel) =>
      [
        "log.ts",
        "metrics.ts",
        "metrics-http.ts",
        "http-metrics.ts",
        "runtime-metrics.ts",
        "request-metrics.ts",
        "rate-limit.ts",
        "readiness.ts",
        "settlement.ts",
      ].includes(rel),
  },
];

const isAggregator = (rel) => rel === "index.ts" || rel.startsWith("entries/");

/** Layer edges that the linear order allows but that must not exist. */
const FORBIDDEN_EDGES = new Set(["runtime->crypto", "runtime->payment"]);

function sharedModules() {
  return [...files(join(ROOT, SHARED))]
    .filter((path) => path.endsWith(".ts"))
    .map((path) => relative(join(ROOT, SHARED), path).replaceAll("\\", "/"))
    .sort();
}

function layerOf(rel) {
  const index = SHARED_LAYERS.findIndex((layer) => layer.match(rel));
  return index === -1 ? null : index;
}

/** Every module specifier in the file: static imports, re-exports, dynamic. */
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

/** Resolve a relative specifier to a module path relative to `shared/src`. */
function resolveSpecifier(fromRel, specifier) {
  const target = posix.normalize(posix.join(posix.dirname(fromRel), specifier));
  return target.replace(/\.js$/, ".ts");
}

const modules = sharedModules();
const unclassified = modules.filter((rel) => !isAggregator(rel) && layerOf(rel) === null);
const layeringOffenders = [];

for (const rel of modules) {
  if (isAggregator(rel)) continue;
  const index = layerOf(rel);
  if (index === null) continue; // reported as unclassified below
  const layer = SHARED_LAYERS[index];
  const pure = layer.pure === true;
  for (const specifier of importsOf(join(ROOT, SHARED, rel))) {
    if (!specifier.startsWith(".")) {
      // A pure module must not reach node builtins or a package: that is the
      // whole point of the pure layer, and it is what keeps ./protocol free.
      if (pure) layeringOffenders.push(`${rel} imports "${specifier}"`);
      continue;
    }
    const target = resolveSpecifier(rel, specifier);
    const targetIndex = layerOf(target);
    if (targetIndex === null) continue;
    const targetLayer = SHARED_LAYERS[targetIndex];
    if (targetIndex > index || FORBIDDEN_EDGES.has(`${layer.name}->${targetLayer.name}`)) {
      layeringOffenders.push(
        `${rel} (${layer.name}) imports ${target} (${targetLayer.name})`,
      );
    }
  }
}

/** Every module reachable by following re-exports from `rel`. */
function exportedClosure(rel, seen = new Set()) {
  if (seen.has(rel)) return seen;
  seen.add(rel);
  for (const specifier of importsOf(join(ROOT, SHARED, rel))) {
    if (!specifier.startsWith(".")) continue;
    const target = resolveSpecifier(rel, specifier);
    if (modules.includes(target)) exportedClosure(target, seen);
  }
  return seen;
}

// There is no root barrel. `@x402s/shared` resolves only through the subpaths
// under `entries/`, so every module has to be reachable from at least one of
// them: a module no entry re-exports is surface nobody can import, and one that
// grows back is the coupling the split removed.
const reachable = new Set();
for (const entry of modules.filter((rel) => rel.startsWith("entries/"))) {
  for (const rel of exportedClosure(entry)) reachable.add(rel);
}
const unexported = modules.filter((rel) => !isAggregator(rel) && !reachable.has(rel));
const barrelBack = existsSync(join(ROOT, SHARED, "index.ts"));

// Each subpath must be the single home of its symbols. Two entries exporting
// the same name means a consumer can import it from either, so the layering
// stops telling you where a symbol's dependencies come from.
function reexportsOf(path) {
  const text = readFileSync(path, "utf8");
  const wildcards = [];
  for (const match of text.matchAll(/(?:^|\n)\s*export\s+(?:type\s+)?\*\s+from\s*["']([^"']+)["']/g)) {
    wildcards.push(match[1]);
  }
  return wildcards;
}

/** Names a module contributes: its own declarations plus its re-exports. */
function exportedNames(rel, seen = new Set()) {
  if (seen.has(rel)) return new Set();
  seen.add(rel);
  const text = readFileSync(join(ROOT, SHARED, rel), "utf8");
  const names = new Set();
  for (const match of text.matchAll(
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/gm,
  )) {
    names.add(match[1]);
  }
  // `export { a, b as c }` and `export { a } from "./x.js"`: named, not wildcard.
  for (const match of text.matchAll(
    /(?:^|\n)\s*export\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s*["'][^"']+["'])?/g,
  )) {
    for (const part of match[1].split(",")) {
      const alias = part.split(/\s+as\s+/);
      const name = (alias[1] ?? alias[0]).trim();
      if (name) names.add(name);
    }
  }
  for (const specifier of reexportsOf(join(ROOT, SHARED, rel))) {
    const target = resolveSpecifier(rel, specifier);
    if (target === rel || !modules.includes(target)) continue;
    for (const name of exportedNames(target, seen)) names.add(name);
  }
  return names;
}

const sharedEntries = modules.filter((rel) => rel.startsWith("entries/"));
const entryOwners = new Map();
const duplicateExports = [];
for (const entry of sharedEntries) {
  for (const name of exportedNames(entry)) {
    const owner = entryOwners.get(name);
    if (owner !== undefined) duplicateExports.push(`${name}: ${owner} and ${entry}`);
    else entryOwners.set(name, entry);
  }
}

if (unclassified.length > 0) {
  console.error("shared/src modules with no layer (add them to SHARED_LAYERS):");
  for (const rel of unclassified) console.error(`  ${rel}`);
}
if (unexported.length > 0) {
  console.error("shared/src modules reachable from no entry:");
  for (const rel of unexported) console.error(`  ${rel}`);
}
if (barrelBack) {
  console.error(
    "shared/src/index.ts exists again: there is no root barrel, add the module to an entry instead",
  );
}
if (layeringOffenders.length > 0) {
  console.error("shared/src layering violations (see the guard above):");
  for (const line of layeringOffenders) console.error(`  ${line}`);
}
if (duplicateExports.length > 0) {
  console.error("shared/src symbols reachable from more than one subpath:");
  for (const line of duplicateExports) console.error(`  ${line}`);
}
if (
  unclassified.length +
    unexported.length +
    layeringOffenders.length +
    duplicateExports.length +
    (barrelBack ? 1 : 0) >
  0
) {
  process.exit(1);
}

console.log(
  `structure ok: every module is <= ${MAX_LINES} lines (${BASELINE.size} baselined); ` +
    `${modules.length} shared modules layered, ` +
    `${entryOwners.size} symbols over ${sharedEntries.length} entries, no root barrel`,
);
