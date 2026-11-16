/**
 * Every overlay in this repository has to render a configuration the code that
 * starts from it accepts.
 *
 * The regression it exists for is real: the Talos overlay added
 * `WARM_POOL_BASE_MIN: "16"` and inherited `WARM_POOL_SIZE: "0"` from
 * `deploy/kubernetes/03-config.yaml`, so `parseWarmPoolAllocation` threw
 * `WARM_POOL_BASE_MIN (16) must not exceed WARM_POOL_SIZE (0)` and every path
 * in `docs/launch.md` produced a controller in CrashLoopBackOff. It survived
 * review because the hosted deployment reconciles a private Flux overlay that
 * sets `WARM_POOL_SIZE` itself, so the committed pair was never the pair that
 * ran.
 *
 * So this renders each overlay with `kubectl kustomize`, reads the
 * `control-config` ConfigMap and the pod env that consumes it, supplies what a
 * cluster supplies out of band (Secret values, a pod name), and runs
 * `loadControllerConfig`. A pair of values that only works because something
 * outside the tree patches one of them fails here.
 *
 * `kubectl kustomize` renders locally: no cluster, no credentials. The suite is
 * skipped only when `kubectl` is not on PATH, and the suite name says so; it
 * runs on a laptop and in CI wherever the client is installed.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPlatformLimits, loadTiers } from "@x402s/shared/payment";
import { loadControllerConfig } from "../../controller/src/config.js";
import { parseDataPlanePlacement } from "../../controller/src/config/relay.js";
import { parseWarmPoolAllocation } from "../../controller/src/config/warm-pool.js";
import { assertDigestAllowed } from "../../controller/src/runtime-profiles.js";

const DEPLOY = fileURLToPath(new URL("../../deploy", import.meta.url));

/**
 * Rendered overlays that carry no `control-config`: they are fragments applied
 * beside a deployment, not deployments. Listed rather than skipped silently so
 * a new fragment has to be justified here and a new overlay cannot hide.
 */
const FRAGMENTS = [
  "kubernetes/cilium",
  "kubernetes/cloudflared",
  "kubernetes/pitr",
  "monitoring/contract",
];

/**
 * The roles that read `control-config` through `loadControllerConfig`. The API
 * and facilitator mount the same ConfigMap but load it with their own parsers,
 * so they are out of scope here.
 */
const CONTROL_ROLES = ["controller", "relay", "proxy"];

/**
 * Every Secret value the controller, relay and proxy pods read, keyed by
 * `<secret>/<key>`. These are fixtures, not credentials: the loader is run, not
 * the process. The values differ per key because it refuses a service token
 * that equals `ADMIN_TOKEN` (key separation), and they clear the >=16 character
 * floor. A Secret that is not listed here and not marked `optional` fails the
 * test by name: this file should not guess.
 */
const SECRETS: Record<string, string> = {
  // The store is only checked for presence, never dialled.
  "postgres-credentials/database-url": "postgres://postgres:pg@127.0.0.1:55432/sbx_deploy",
  "x402-secrets/admin-token": "fixture-admin-token",
  "x402-secrets/relay-admin-token": "fixture-relay-admin-token",
  "x402-secrets/wake-token": "fixture-wake-token",
  "x402-secrets/proxy-token-secret": "fixture-proxy-token-secret",
  "x402-secrets/dev-attestation-key": "fixture-dev-attestation-key",
  "x402-secrets/dev-attestation-key-id": "fixture-dev-attestation-key-id",
};

/**
 * `deploy/kubernetes` and `deploy/kata` ship the dev placeholder digest because
 * `deploy/kind/apply.sh` rewrites it to the digest of the image it just loaded
 * (03-config.yaml says so above the placeholder). Emulate that rewrite here so
 * the rest of those two configs is still checked. The cluster overlays must pin
 * a real digest and are asserted to.
 */
const KIND_GUEST_DIGEST = "sha256:" + "0".repeat(64);

function kubectlAvailable(): boolean {
  try {
    execFileSync("kubectl", ["version", "--client"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const KUBECTL = kubectlAvailable();

/** Every directory under `deploy/` that kustomize can be asked to render. */
function overlayDirectories(dir = DEPLOY, prefix = ""): string[] {
  const entries = readdirSync(dir).sort();
  const found = entries.some((file) => /^kustomization\.ya?ml$/.test(file)) ? [prefix] : [];
  for (const entry of entries) {
    if (!statSync(join(dir, entry)).isDirectory()) continue;
    const nested = prefix === "" ? entry : `${prefix}/${entry}`;
    found.push(...overlayDirectories(join(dir, entry), nested));
  }
  return found;
}

const cache = new Map<string, string>();

function render(overlay: string): string {
  const cached = cache.get(overlay);
  if (cached !== undefined) return cached;
  const output = execFileSync("kubectl", ["kustomize", join(DEPLOY, overlay)], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  cache.set(overlay, output);
  return output;
}

function documents(rendered: string): string[] {
  return rendered.split(/^---\s*$/m).filter((doc) => /^kind: /m.test(doc));
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * First capture group of `pattern` matched against `line`, or undefined.
 *
 * Every caller tests the result rather than indexing `match[1]`, so a line that
 * stops matching (a restructured manifest) is a miss, not a `TypeError` at
 * runtime or an unchecked index at compile time.
 */
function capture(pattern: RegExp, line: string): string | undefined {
  return pattern.exec(line)?.[1];
}

function scalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("|") || value.startsWith(">")) {
    throw new Error(`this reader only handles single-line values, got a block scalar: ${value}`);
  }
  if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value) as string;
  }
  if (value.length > 1 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

/**
 * The `data:` map of the `control-config` ConfigMap, or null when the document
 * is something else. Narrow on purpose: a rendered ConfigMap has a flat
 * single-line data block, and anything else is refused rather than guessed.
 */
function controlConfigData(doc: string): Record<string, string> | null {
  if (!/^kind: ConfigMap$/m.test(doc)) return null;
  if (!/^  name: control-config$/m.test(doc)) return null;
  const lines = doc.split("\n");
  const start = lines.indexOf("data:");
  if (start < 0) throw new Error("control-config has no data block");
  const data: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    const entry = /^  ([\w.\-/]+):(?: (.*))?$/.exec(line);
    if (!entry) break; // the next top-level key: the block has ended
    const key = entry[1];
    if (key === undefined) break;
    data[key] = scalar(entry[2] ?? "");
  }
  return data;
}

interface RawEnv {
  name: string;
  /** Literal `value:`. */
  value?: string;
  /** `valueFrom.secretKeyRef`. */
  secret?: string;
  key?: string;
  optional?: boolean;
  /** `valueFrom.fieldRef.fieldPath`. */
  field?: string;
}

/**
 * The lines of the block whose header is at `start`, up to the next peer key.
 *
 * kustomize writes a sequence at the same indentation as its parent key, so a
 * line at the header's indentation that starts with `- ` is still part of the
 * block; a line at that indentation that does not begin one is the next key.
 */
function block(lines: string[], start: number): { body: string[]; end: number } {
  const header = lines[start];
  if (header === undefined) return { body: [], end: start + 1 };
  const indent = indentOf(header);
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line === undefined) break;
    if (line.trim() === "") {
      end += 1;
      continue;
    }
    const lineIndent = indentOf(line);
    if (lineIndent < indent) break;
    if (lineIndent === indent && !/^\s*- /.test(line)) break;
    end += 1;
  }
  return { body: lines.slice(start + 1, end), end };
}

function envEntries(body: string[]): RawEnv[] {
  const entries: RawEnv[] = [];
  let current: RawEnv | null = null;
  for (const line of body) {
    const name = capture(/^\s*- name: (.+)$/, line);
    if (name !== undefined) {
      current = { name: name.trim() };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    const value = capture(/^\s+value:(.*)$/, line);
    if (value !== undefined) {
      current.value = scalar(value);
      continue;
    }
    const key = capture(/^\s+key: (.+)$/, line);
    if (key !== undefined) {
      current.key = key.trim();
      continue;
    }
    const field = capture(/^\s+fieldPath: (.+)$/, line);
    if (field !== undefined) {
      current.field = field.trim();
      continue;
    }
    if (/^\s+optional: true$/.test(line)) {
      current.optional = true;
      continue;
    }
    const secret = capture(/^\s+name: (.+)$/, line);
    if (secret !== undefined) current.secret = secret.trim();
  }
  return entries;
}

interface PodEnv {
  /** `Deployment/controller`, for the test name. */
  workload: string;
  container: string;
  /** Names of the ConfigMaps the container takes with `envFrom`. */
  configMaps: string[];
  env: Record<string, string>;
}

/**
 * The env of each container in a Deployment or StatefulSet, as the kubelet
 * would assemble it: literals inlined, `valueFrom` resolved to the fixture
 * above, and the fieldRef replaced by the pod name the workload produces.
 *
 * It reads the rendered output, where kustomize has expanded the inline
 * `- {name: X, value: Y}` maps the sources use and sorted each block, so every
 * entry is block form and `name:` is the last key of a container.
 */
function podEnvs(doc: string): PodEnv[] {
  const kind = /^kind: (Deployment|StatefulSet)$/m.exec(doc)?.[1];
  if (!kind) return [];
  const name = /^  name: (.+)$/m.exec(doc)?.[1];
  if (!name) return [];
  const podName = `${name}-0`;

  const lines = doc.split("\n");
  const containers = lines.findIndex((line) => /^      containers:$/.test(line));
  if (containers < 0) return [];

  const items: string[][] = [];
  for (const line of block(lines, containers).body) {
    if (/^      - /.test(line)) {
      items.push([line]);
      continue;
    }
    items.at(-1)?.push(line);
  }

  return items
    .map((item): PodEnv => {
      const container = /^        name: (.+)$/m.exec(item.join("\n"))?.[1]?.trim() ?? "";
      const env: Record<string, string> = {};
      const configMaps: string[] = [];
      let entries: RawEnv[] = [];
      for (let i = 0; i < item.length; i += 1) {
        const line = item[i];
        if (line === undefined) break;
        if (/^        env:$/.test(line)) {
          const parsed = block(item, i);
          entries = envEntries(parsed.body);
          i = parsed.end - 1;
          continue;
        }
        if (/^        envFrom:$/.test(line)) {
          const parsed = block(item, i);
          let fromConfigMap = false;
          for (const from of parsed.body) {
            if (/^\s*- configMapRef:/.test(from)) {
              fromConfigMap = true;
              continue;
            }
            if (/^\s*- /.test(from)) {
              fromConfigMap = false;
              continue;
            }
            const ref = fromConfigMap ? capture(/^\s*name: (.+)$/, from) : undefined;
            if (ref !== undefined) configMaps.push(ref.trim());
          }
          i = parsed.end - 1;
        }
      }
      // Only the control roles are assembled: this file loads their config, and
      // the API and facilitator read the same ConfigMap through loaders that
      // this one does not call, so their Secrets are not fixtures here.
      const role = entries.find((entry) => entry.name === "ROLE")?.value ?? "";
      const control = CONTROL_ROLES.includes(role);
      for (const entry of entries) {
        const resolved = control ? resolveEntry(entry, podName) : entry.value;
        if (resolved !== undefined) env[entry.name] = resolved;
      }
      return { workload: `${kind}/${name}`, container, configMaps, env };
    })
    .filter((pod) => pod.container !== "");
}

function resolveEntry(entry: RawEnv, podName: string): string | undefined {
  if (entry.value !== undefined) return entry.value;
  if (entry.field !== undefined) {
    if (entry.field !== "metadata.name") {
      throw new Error(`no fixture for fieldRef ${entry.field} (${entry.name})`);
    }
    return podName;
  }
  if (entry.secret === undefined) return undefined;
  // Absent from the cluster until an operator sets it, so it stays unset here.
  if (entry.optional) return undefined;
  const value = SECRETS[`${entry.secret}/${entry.key}`];
  if (value === undefined) {
    throw new Error(
      `no fixture for Secret ${entry.secret} key ${entry.key} (${entry.name}); add it to SECRETS`,
    );
  }
  return value;
}

/** The control-config data plus the pod env that reads it, as one env object. */
function configuration(overlay: string, pod: PodEnv): NodeJS.ProcessEnv {
  const data = controlConfigDataFor(overlay);
  const env: NodeJS.ProcessEnv = { ...data, ...pod.env };
  if (/^sha256:(dev-)?unpinned/.test(env.GUEST_IMAGE_DIGEST ?? "")) {
    env.GUEST_IMAGE_DIGEST = KIND_GUEST_DIGEST;
  }
  return env;
}

function findControlConfig(overlay: string): Record<string, string> | null {
  return documents(render(overlay))
    .map(controlConfigData)
    .find((data) => data !== null) ?? null;
}

function controlConfigDataFor(overlay: string): Record<string, string> {
  const found = findControlConfig(overlay);
  if (!found) throw new Error(`${overlay} renders no control-config ConfigMap`);
  return found;
}

/** Every pod in an overlay that loads this config as a control role. */
function controlPods(overlay: string): PodEnv[] {
  return documents(render(overlay))
    .flatMap(podEnvs)
    .filter((pod) => pod.configMaps.includes("control-config"))
    .filter((pod) => CONTROL_ROLES.includes(pod.env.ROLE ?? ""));
}

function controllerPod(overlay: string): PodEnv {
  const pod = controlPods(overlay).find((candidate) => candidate.env.ROLE === "controller");
  if (!pod) throw new Error(`${overlay} has no control-config pod with ROLE=controller`);
  return pod;
}

function configError(env: NodeJS.ProcessEnv): string | null {
  try {
    loadControllerConfig(env);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

const SUITE = KUBECTL
  ? "rendered deploy configs"
  : "rendered deploy configs (skipped: kubectl is not installed, so no overlay was rendered)";

const ALL_OVERLAYS = KUBECTL ? overlayDirectories() : [];
const OVERLAYS = ALL_OVERLAYS.filter((overlay) => findControlConfig(overlay) !== null);

describe.skipIf(!KUBECTL)(SUITE, () => {
  describe("coverage", () => {
    it("covers every overlay that carries a control-config ConfigMap", () => {
      // A reader that found nothing would make every case below vacuous.
      expect(OVERLAYS.length).toBeGreaterThanOrEqual(5);
      for (const overlay of ["kubernetes", "kata", "talos", "pitr", "overlays/throwbox"]) {
        expect(OVERLAYS).toContain(overlay);
      }
    });

    it("finds only known fragments among the overlays without one", () => {
      const fragments = ALL_OVERLAYS.filter((overlay) => !OVERLAYS.includes(overlay)).sort();
      expect(fragments).toEqual(FRAGMENTS);
    });

    it("pins the guest digest in every overlay applied without deploy/kind/apply.sh", () => {
      // The two local overlays are exempt because apply.sh rewrites the
      // placeholder to the digest it loaded; anything a cluster applies as-is
      // has to name a real digest already (controller/src/runtime-profiles.ts
      // refuses to start otherwise).
      for (const overlay of ["talos", "pitr", "overlays/throwbox"]) {
        expect(controlConfigDataFor(overlay).GUEST_IMAGE_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
      }
    });
  });

  describe.each(OVERLAYS)("%s", (overlay) => {
    it("loads the controller config for every control role", () => {
      const pods = controlPods(overlay);
      // controller, relay and proxy all start from this ConfigMap. The relay
      // and proxy add constraints the controller does not (mTLS files, shard
      // ordinals), so testing the controller alone would miss half of them.
      expect(pods.map((pod) => pod.env.ROLE).sort()).toEqual(["controller", "proxy", "relay"]);
      const failures = pods
        .map((pod) => ({ pod, error: configError(configuration(overlay, pod)) }))
        .filter((result) => result.error !== null)
        .map((result) => `${result.pod.workload} (ROLE=${result.pod.env.ROLE}): ${result.error}`);
      expect(failures).toEqual([]);
    });

    it("sizes the warm pool so its base minimum fits inside it", () => {
      // The overlay bug this file exists for. `parseWarmPoolAllocation` is the
      // guard; the overlay was the thing that was wrong.
      const env = configuration(overlay, controllerPod(overlay));
      expect(env.WARM_POOL_SIZE).toBeDefined();
      const tiers = loadTiers(env);
      const allocation = parseWarmPoolAllocation(env, tiers);
      expect(allocation.warmPoolBaseMin).toBeLessThanOrEqual(allocation.warmPoolSize);
      expect(Object.keys(tiers)).toContain(allocation.warmPoolTier);
    });

    it("keeps platform limits at or above every tier it publishes", () => {
      // Two keys that imply each other and are set in different places: a
      // limit below a tier does not fail at startup, it makes every create for
      // that tier fail at `resolveSessionSpec`, after payment.
      const env = configuration(overlay, controllerPod(overlay));
      const limits = loadPlatformLimits(env);
      const over: string[] = [];
      for (const [tier, definition] of Object.entries(loadTiers(env))) {
        if (definition.durationSeconds > limits.maxLeaseSeconds) {
          over.push(`${tier}.durationSeconds ${definition.durationSeconds} > MAX_LEASE_SECONDS ${limits.maxLeaseSeconds}`);
        }
        if (definition.cpuMillis > limits.maxCpuMillis) {
          over.push(`${tier}.cpuMillis ${definition.cpuMillis} > MAX_CPU_MILLIS ${limits.maxCpuMillis}`);
        }
        if (definition.memoryMiB > limits.maxMemoryMiB) {
          over.push(`${tier}.memoryMiB ${definition.memoryMiB} > MAX_MEMORY_MIB ${limits.maxMemoryMiB}`);
        }
        if (definition.diskMiB > limits.maxDiskMiB) {
          over.push(`${tier}.diskMiB ${definition.diskMiB} > MAX_DISK_MIB ${limits.maxDiskMiB}`);
        }
      }
      expect(over).toEqual([]);
    });

    it("places every relay and proxy shard inside its replica count", () => {
      // RELAY_REPLICAS and the StatefulSet replicas are checked together by
      // scripts/check-singletons.mjs; the ordinal each pod reads is not, and a
      // pod whose ordinal is outside the range refuses to start.
      const env = configuration(overlay, controllerPod(overlay));
      const failures: string[] = [];
      for (const role of ["relay", "proxy"] as const) {
        const replicas = Number((role === "relay" ? env.RELAY_REPLICAS : env.PROXY_REPLICAS) ?? "1");
        for (let shard = 0; shard < replicas; shard += 1) {
          try {
            parseDataPlanePlacement({ ...env, ROLE: role, SHARD_INDEX: `${role}-${shard}` }, role);
          } catch (error) {
            failures.push(`${role}-${shard}: ${(error as Error).message}`);
          }
        }
        // One past the end has to be refused, or the range is not enforced.
        expect(() =>
          parseDataPlanePlacement({ ...env, ROLE: role, SHARD_INDEX: `${role}-${replicas}` }, role),
        ).toThrow(/outside the \d+-replica range/);
      }
      expect(failures).toEqual([]);
    });

    it("pins every guest image digest the config names", () => {
      const env = configuration(overlay, controllerPod(overlay));
      const config = loadControllerConfig(env);
      const failures: string[] = [];
      for (const [profile, entry] of Object.entries(config.runtimeProfiles)) {
        const label = profile === "base" ? "GUEST_IMAGE_DIGEST" : `RUNTIME_PROFILES.${profile}.digest`;
        try {
          assertDigestAllowed(label, entry.digest, {
            kubeEnabled: config.kubeEnabled,
            role: "controller",
            allowInsecureDev: config.allowInsecureDev,
          });
        } catch (error) {
          failures.push((error as Error).message);
        }
      }
      expect(failures).toEqual([]);
    });
  });
});
