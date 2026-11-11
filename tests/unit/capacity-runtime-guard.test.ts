/**
 * Capacity admission and runtime profiles.
 *
 * A profile the product knows but this controller has no image for must be
 * rejected before a settlement hold exists, so a payer is never charged for a
 * session that could only fail after READY. The guard is first in `hold`, so it
 * must not touch Kubernetes at all.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapacityService } from "../../controller/src/capacity/service.js";
import { loadControllerConfig } from "../../controller/src/config.js";
import type { Provisioner } from "../../controller/src/k8s.js";
import { Store } from "../../controller/src/store.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "x402-runtime-capacity-"));
  dirs.push(dir);
  return new Store(join(dir, "controller.db"));
}

function config(extra: NodeJS.ProcessEnv = {}) {
  return loadControllerConfig({
    ADMIN_TOKEN: "a".repeat(24),
    RELAY_ADMIN_TOKEN: "r".repeat(24),
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "p".repeat(24),
    EXECUTION_MODE: "dev",
    ALLOW_INSECURE_DEV: "true",
    KUBERNETES_ENABLED: "false",
    ...extra,
  });
}

function harness(env: NodeJS.ProcessEnv = {}) {
  const cfg = config(env);
  const store = freshStore();
  let kubernetesCalls = 0;
  const provisioner = {
    async listNodes() {
      kubernetesCalls += 1;
      return [];
    },
    async listWarmPods() {
      kubernetesCalls += 1;
      return [];
    },
  } as unknown as Provisioner;
  return {
    capacity: new CapacityService({ cfg, store, provisioner }),
    kubernetesCalls: () => kubernetesCalls,
  };
}

const limits = { cpuMillis: 500, memoryMiB: 512, diskMiB: 256 };

describe("capacity admission rejects an unconfigured runtime profile", () => {
  it("refuses a known profile the controller has no image for, before any cluster read", async () => {
    const h = harness();
    const decision = await h.capacity.hold("a".repeat(64), "b".repeat(64), {
      runtime: "python",
      limits,
    });
    expect(decision).toMatchObject({
      admitted: false,
      reason: "runtime_profile_unavailable",
      retryable: false,
    });
    // Not a capacity problem, and not this cluster's business: no snapshot.
    expect(h.kubernetesCalls()).toBe(0);
  });

  it("refuses the same profile at preflight, the advisory 402 path", async () => {
    const h = harness();
    expect(await h.capacity.preflight({ runtime: "node", limits })).toMatchObject({
      admitted: false,
      reason: "runtime_profile_unavailable",
    });
  });

  it("admits a configured profile and the default", async () => {
    const digest = `sha256:${"c".repeat(64)}`;
    const h = harness({
      RUNTIME_PROFILES: JSON.stringify({
        python: { image: "ghcr.io/example/guest:1-python", digest },
      }),
    });
    // Configuring the profile gets past the guard and into the real decision,
    // which this harness rejects only because it reports no nodes.
    const python = await h.capacity.hold("a".repeat(64), "b".repeat(64), {
      runtime: "python",
      limits,
    });
    const base = await h.capacity.hold("c".repeat(64), "d".repeat(64), { runtime: "base", limits });
    expect(python).not.toMatchObject({ reason: "runtime_profile_unavailable" });
    expect(base).not.toMatchObject({ reason: "runtime_profile_unavailable" });
    expect(h.kubernetesCalls()).toBeGreaterThan(0);
  });
});
