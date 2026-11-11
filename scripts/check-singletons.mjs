#!/usr/bin/env node
/**
 * Singleton manifest guard.
 *
 * The control plane has three pieces of state that are per-process:
 *
 *   controller  SQLite, on a ReadWriteOnce volume, written by one reconciler.
 *   relay       The guest registry in memory; a session is pinned to the pod
 *               that holds its socket.
 *
 * ADR 0009 makes a second controller *safe* (a Lease decides which replica
 * reconciles and the standby's connection is `query_only`), but it does not make
 * a second writer *useful*, and ADR 0010 is the record that the deployment is
 * still one writer on one node. A `kubectl scale` or an edit to the rollout
 * strategy is otherwise a silent way to run two reconcilers over the same rows
 * or two relays with independent registries. Those are the failures that only
 * show up as duplicated effects, or as a guest registered on a pod the
 * controller is not talking to.
 *
 * This asserts the properties in the committed manifests, not the running
 * cluster: the point is that a pull request cannot quietly change them. A
 * running-cluster check would need a live cluster in PR CI, and would miss the
 * manifest edit until it was applied.
 *
 * Usage: node scripts/check-singletons.mjs [deployDir]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)), "deploy/kubernetes");

/** Split a multi-document YAML file. Comments and blank documents are dropped. */
function documents(text) {
  return text
    .split(/^---\s*$/m)
    .map((doc) => doc.split("\n"))
    .filter((lines) => lines.some((line) => /^\s*(kind|apiVersion):/.test(line)));
}

/** `key:` lines, their indentation, and the inline value if any. */
function entry(line) {
  const match = /^(\s*)([A-Za-z0-9_.\-/]+):(\s*(.*))?$/.exec(line);
  if (!match) return null;
  const value = (match[4] ?? "").replace(/\s+#.*$/, "").trim();
  return { indent: match[1].length, key: match[2], value };
}

function significant(line) {
  const trimmed = line.trim();
  return trimmed !== "" && !trimmed.startsWith("#") && !trimmed.startsWith("- ");
}

/**
 * Read a scalar at an indentation path, e.g. ["spec", "strategy", "type"].
 * Block values (a key with nothing after the colon) are descended into; the
 * block ends at the next line at the same or lower indentation.
 *
 * Deliberately narrow: this reads the handful of fields the guard needs and
 * returns undefined for anything it does not understand, so a restructured
 * manifest fails the check instead of passing vacuously.
 */
function readPath(lines, path) {
  let from = 0;
  let to = lines.length;
  let expected = 0;
  for (const [index, key] of path.entries()) {
    let found;
    for (let i = from; i < to; i += 1) {
      if (!significant(lines[i])) continue;
      const parsed = entry(lines[i]);
      if (!parsed || parsed.indent < expected) break;
      if (parsed.indent !== expected || parsed.key !== key) continue;
      if (parsed.value !== "") {
        found = { value: parsed.value };
      } else {
        let end = i + 1;
        while (end < to) {
          if (significant(lines[end])) {
            const nested = entry(lines[end]);
            if (nested && nested.indent <= expected) break;
          }
          end += 1;
        }
        found = { value: undefined, block: { from: i + 1, to: end, indent: expected } };
      }
      break;
    }
    if (!found) return undefined;
    if (index === path.length - 1) return found.value;
    if (!found.block) return undefined; // a scalar where a block was expected
    from = found.block.from;
    to = found.block.to;
    expected = found.block.indent + 2;
  }
  return undefined;
}

/** Every workload document in the directory, keyed by `kind/name`. */
function workloads(dir) {
  const found = new Map();
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    for (const lines of documents(readFileSync(join(dir, file), "utf8"))) {
      const kind = readPath(lines, ["kind"]);
      if (kind !== "Deployment" && kind !== "StatefulSet") continue;
      const name = readPath(lines, ["metadata", "name"]);
      found.set(`${kind}/${name}`, { file, kind, name, lines });
    }
  }
  return found;
}

function unquote(value) {
  return value === undefined ? undefined : value.replace(/^["']|["']$/g, "");
}

/**
 * The controller: one replica, and a rollout that cannot have two pods serving
 * from the SQLite volume at once. `Recreate` gives that directly; a
 * `RollingUpdate` is only accepted with `maxSurge: 0`.
 */
function checkController(entity, problems) {
  if (!entity) {
    problems.push("controller: no Deployment named controller in deploy/kubernetes");
    return;
  }
  const { file, lines } = entity;
  const replicas = unquote(readPath(lines, ["spec", "replicas"]));
  if (replicas !== "1") {
    problems.push(`${file}: controller replicas is ${replicas ?? "unset"}, must be 1 (ADR 0009, ADR 0010)`);
  }
  const strategy = unquote(readPath(lines, ["spec", "strategy", "type"])) ?? "RollingUpdate";
  if (strategy === "Recreate") return;
  if (strategy === "RollingUpdate") {
    const maxSurge = unquote(readPath(lines, ["spec", "strategy", "rollingUpdate", "maxSurge"]));
    if (maxSurge !== "0") {
      problems.push(
        `${file}: controller strategy is RollingUpdate with maxSurge ${maxSurge ?? "unset"}, ` +
          "must be 0 or strategy Recreate; two pods must not hold the SQLite volume",
      );
    }
    return;
  }
  problems.push(`${file}: controller strategy type is ${strategy}, expected Recreate`);
}

/**
 * The relay: one replica. A StatefulSet already gives one pod per ordinal, so
 * the remaining ways to get two registries for one shard are a replica count
 * above 1 in the committed manifest, a parallel pod management policy, or a
 * rolling-update surge.
 */
function checkRelay(entity, problems) {
  if (!entity) {
    problems.push("relay: no StatefulSet named relay in deploy/kubernetes");
    return;
  }
  const { file, lines } = entity;
  const replicas = unquote(readPath(lines, ["spec", "replicas"]));
  if (replicas !== "1") {
    problems.push(`${file}: relay replicas is ${replicas ?? "unset"}, must be 1 (the registry is in memory)`);
  }
  const management = unquote(readPath(lines, ["spec", "podManagementPolicy"])) ?? "OrderedReady";
  if (management !== "OrderedReady") {
    problems.push(`${file}: relay podManagementPolicy is ${management}, expected OrderedReady`);
  }
  const maxSurge = unquote(readPath(lines, ["spec", "updateStrategy", "rollingUpdate", "maxSurge"]));
  if (maxSurge !== undefined && maxSurge !== "0") {
    problems.push(`${file}: relay updateStrategy maxSurge is ${maxSurge}, must be 0`);
  }
}

/** Check a deploy directory. Returns the problems found; empty means ok. */
export function checkSingletons(dir = DEFAULT_DIR) {
  const entities = workloads(dir);
  const problems = [];
  checkController(entities.get("Deployment/controller"), problems);
  checkRelay(entities.get("StatefulSet/relay"), problems);
  return problems;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const dir = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_DIR;
  const problems = checkSingletons(dir);
  if (problems.length > 0) {
    console.error("singleton invariants broken (see docs/architecture-principles.md):");
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(
    "singletons ok: controller replicas 1 with a non-overlapping rollout, relay replicas 1",
  );
}
