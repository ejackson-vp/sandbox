/**
 * No effect list is written by hand outside the table.
 *
 * The refactor this pins replaced the last hand-built `SessionEffect` literal
 * (the SUSPENDING retry in `lifecycle.ts`) with a transition, so every effect
 * list in the product now comes from `transition()`. The interpreter's
 * `EFFECT_VARIANTS` is the remaining set of literals, and it exists to prove
 * the switch is exhaustive, not to run anything.
 *
 * A grep is the honest test here: a type-level rule cannot see a literal that
 * is constructed to look like a decision, and the failure is silent (a replay
 * list that drifts from the table). The scan is over source, not build output,
 * and the variant names come from the union itself, so a new effect is covered
 * without editing this file.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EFFECT_VARIANTS } from "../../controller/src/effects.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The table, and the interpreter's inventory of one exemplar per variant. */
const ALLOWED = new Set(["shared/src/domain/session.ts", "controller/src/effects.ts"]);

const SCANNED = ["shared/src", "controller/src"];

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      yield* sources(path);
    } else if (path.endsWith(".ts")) {
      yield path;
    }
  }
}

describe("effect literals", () => {
  it("exist only in the transition table and the interpreter's inventory", () => {
    const names = Object.keys(EFFECT_VARIANTS).join("|");
    const literal = new RegExp(`type:\\s*["'](?:${names})["']`);
    const offenders: string[] = [];
    for (const root of SCANNED) {
      for (const path of sources(join(ROOT, root))) {
        const file = relative(ROOT, path);
        if (ALLOWED.has(file)) continue;
        readFileSync(path, "utf8")
          .split("\n")
          .forEach((line, index) => {
            if (literal.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });
});
