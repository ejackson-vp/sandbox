/**
 * Structural guardrail: keep modules reviewable.
 *
 * This is intentionally a blunt line-count check, not a style linter. It is a
 * backstop against the god files this refactor removed; the real rules live in
 * docs/architecture-principles.md.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const MAX_LINES = 550;
const ROOTS = ["shared/src", "sdk/src", "api/src", "controller/src", "guest"];

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
for (const root of ROOTS) {
  for (const path of files(join(ROOT, root))) {
    const lines = readFileSync(path, "utf8").split("\n").length;
    if (lines > MAX_LINES) offenders.push({ path: relative(ROOT, path), lines });
  }
}

if (offenders.length > 0) {
  console.error(`files over ${MAX_LINES} lines:`);
  for (const { path, lines } of offenders.sort((a, b) => b.lines - a.lines)) {
    console.error(`  ${lines}\t${path}`);
  }
  process.exit(1);
}

console.log(`structure ok: every module is <= ${MAX_LINES} lines`);
