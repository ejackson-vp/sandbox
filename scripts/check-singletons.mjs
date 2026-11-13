#!/usr/bin/env node
/**
 * Singleton manifest guard.
 *
 * The control plane has two pieces of state that are per-process:
 *
 *   controller  one writer, so a second replica cannot diverge on state.
 *   relay       The guest registry in memory; a session is pinned to the pod
 *               that holds its socket.
 *
 * ADR 0009 makes a second controller *safe* (a Lease decides which replica
 * reconciles and the standby's connection is `query_only`), but it does not make
 * a second writer *useful*, and ADR 0010 is the record that the deployment is
 * still one writer on one node. A `kubectl scale` or an edit to the rollout
 * strategy is otherwise a silent way to run two reconcilers over the same rows.
 *
 * The relay is different: more than one replica is correct, because placement is
 * a pure function of the session id (`controller/src/data-plane-shard.ts`), so
 * every replica and the controller agree on which shard owns a session without
 * shared state. What still has to hold is that the committed manifests agree
 * with each other and cannot roll two registries onto one shard:
 *
 *   - StatefulSet replicas equal RELAY_REPLICAS in the control ConfigMap;
 *   - `podManagementPolicy: OrderedReady`, so a parallel start cannot bring a
 *     replacement up beside the pod it replaces;
 *   - no rollout surge (`maxSurge: 0`), for the same reason;
 *   - a `relay-<n>` Service for every shard, because a guest has no DNS and
 *     dials that ClusterIP. A missing one does not corrupt a registry, it makes
 *     every create for that shard defer until someone notices.
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

/** Every document in the directory, keyed by `kind/name`. */
function entities(dir) {
  const found = new Map();
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    for (const lines of documents(readFileSync(join(dir, file), "utf8"))) {
      const kind = readPath(lines, ["kind"]);
      const name = readPath(lines, ["metadata", "name"]);
      if (!kind || !name) continue;
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
 * from the database at once. `Recreate` gives that directly; a
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
          "must be 0 or strategy Recreate; a second replica must not become a second writer",
      );
    }
    return;
  }
  problems.push(`${file}: controller strategy type is ${strategy}, expected Recreate`);
}

/**
 * The relay: N shards, but never two registries for one shard.
 *
 * A StatefulSet already gives one pod per ordinal, so the remaining ways to get
 * two registries for one shard are a parallel pod management policy or a
 * rolling-update surge. The count itself is fine as long as the manifests agree:
 * the StatefulSet, RELAY_REPLICAS and one `relay-<n>` Service per shard.
 */
function checkRelay(entity, config, services, problems) {
  if (!entity) {
    problems.push("relay: no StatefulSet named relay in deploy/kubernetes");
    return;
  }
  const { file, lines } = entity;
  const declared = config ? unquote(readPath(config.lines, ["data", "RELAY_REPLICAS"])) : undefined;
  if (config && declared === undefined) {
    problems.push(`${config.file}: no RELAY_REPLICAS in ConfigMap control-config`);
  }
  const replicas = unquote(readPath(lines, ["spec", "replicas"]));
  if (declared !== undefined && replicas !== declared) {
    problems.push(
      `${file}: relay replicas is ${replicas ?? "unset"} but ${config.file} has ` +
        `RELAY_REPLICAS ${declared}; a shard outside the range refuses to start`,
    );
  }
  const management = unquote(readPath(lines, ["spec", "podManagementPolicy"])) ?? "OrderedReady";
  if (management !== "OrderedReady") {
    problems.push(`${file}: relay podManagementPolicy is ${management}, expected OrderedReady`);
  }
  // A StatefulSet rolling update never surges: it terminates an ordinal before
  // recreating it. `maxSurge` exists to *allow* a surge, it arrived in
  // Kubernetes 1.34, and setting it to 0 on an older API server is rejected as
  // an unknown field with strict decoding. So absence and "0" mean the same
  // thing here, and requiring the explicit form only raised the cluster floor.
  const maxSurge = unquote(readPath(lines, ["spec", "updateStrategy", "rollingUpdate", "maxSurge"]));
  if (maxSurge !== undefined && maxSurge !== "0") {
    problems.push(
      `${file}: relay updateStrategy maxSurge is ${maxSurge}, must be 0 or unset; ` +
        "a surge runs two registries for one ordinal",
    );
  }
  if (declared === undefined) return;
  const count = Number(declared);
  if (!Number.isInteger(count) || count < 1) {
    problems.push(`${config.file}: RELAY_REPLICAS is ${declared}, expected a positive integer`);
    return;
  }
  // A guest has no DNS and cannot dial a Pod IP that outlives a replacement, so
  // each shard needs its own ClusterIP Service selecting that pod name.
  for (let shard = 0; shard < count; shard += 1) {
    const name = `relay-${shard}`;
    const service = services.get(`Service/${name}`);
    if (!service) {
      problems.push(`relay: no Service named ${name} for RELAY_REPLICAS ${count} (a guest dials it)`);
      continue;
    }
    const selector = unquote(
      readPath(service.lines, ["spec", "selector", "statefulset.kubernetes.io/pod-name"]),
    );
    if (selector !== name) {
      problems.push(
        `${service.file}: Service ${name} selects pod-name ${selector ?? "unset"}, expected ${name}`,
      );
    }
  }
}

/** Check a deploy directory. Returns the problems found; empty means ok. */
export function checkSingletons(dir = DEFAULT_DIR) {
  const found = entities(dir);
  const problems = [];
  checkController(found.get("Deployment/controller"), problems);
  checkRelay(
    found.get("StatefulSet/relay"),
    found.get("ConfigMap/control-config"),
    found,
    problems,
  );
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
    "singletons ok: controller replicas 1 with a non-overlapping rollout; " +
      "relay shards match RELAY_REPLICAS with OrderedReady, no surge and a Service per shard",
  );
}
