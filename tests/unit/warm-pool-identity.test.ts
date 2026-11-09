import { describe, expect, it } from "vitest";
import type { WarmClaim } from "@x402s/shared";
import { loadControllerConfig } from "../../controller/src/config.js";
import type { CapacityService } from "../../controller/src/capacity/service.js";
import type { Provisioner, WarmPodInfo } from "../../controller/src/k8s.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import type { Snapshotter } from "../../controller/src/snapshotter.js";
import type { SessionRecord } from "../../controller/src/store.js";
import type { WarmPoolStore } from "../../controller/src/store/ports.js";
import { WarmPool } from "../../controller/src/warm-pool.js";
import { warmPoolIdentity } from "../../controller/src/warm-pool-identity.js";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;

function config(digest: string) {
  return loadControllerConfig({
    ADMIN_TOKEN: "a".repeat(24),
    RELAY_ADMIN_TOKEN: "r".repeat(24),
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "p".repeat(24),
    EXECUTION_MODE: "dev",
    ALLOW_INSECURE_DEV: "true",
    GUEST_IMAGE_DIGEST: digest,
    WARM_POOL_SIZE: "1",
  });
}

type Config = ReturnType<typeof config>;

function identityFor(cfg: Config, pool: WarmPool): string {
  return warmPoolIdentity({
    imageDigest: cfg.guestImageDigest,
    runtimeClass: cfg.runtimeClass,
    executionMode: cfg.executionMode,
    workspaceDir: cfg.workspaceDir,
    limits: pool.limits(),
  });
}

function warmPod(identity: string, imageDigest: string): WarmPodInfo {
  return {
    name: "warm-aaaaaaaaaaaa",
    warmId: "aaaaaaaaaaaa",
    poolId: "warm_aaaaaaaaaaaa",
    createdAt: Date.now(),
    phase: "Running",
    identity,
    imageDigest,
  };
}

interface Harness {
  pool: WarmPool;
  cfg: Config;
  pods: WarmPodInfo[];
  deletes: string[];
  claims: Array<{ poolId: string; claim: WarmClaim }>;
}

function harness(initialPods: WarmPodInfo[], digest = digestA): Harness {
  const cfg = config(digest);
  const pods = [...initialPods];
  const deletes: string[] = [];
  const claims: Array<{ poolId: string; claim: WarmClaim }> = [];
  const store = {
    mergeTimings: () => {},
    setProvisioning: () => true,
    setRelayToken: () => {},
  } as unknown as WarmPoolStore;
  const provisioner = {
    listWarmPods: async () => pods,
    deletePod: async (name: string) => {
      deletes.push(name);
    },
    patchPodLabels: async () => {},
    createWarmPod: async () => ({ podName: "created" }),
  } as unknown as Provisioner;
  const relay = {
    state: async () => ({
      registered: true,
      connected: true,
      attestation: { sessionId: "warm_aaaaaaaaaaaa" },
      pending: 0,
    }),
    register: async () => {},
    claim: async (poolId: string, claim: WarmClaim) => {
      claims.push({ poolId, claim });
    },
    purge: async () => {},
  } as unknown as RelayClient;
  const capacity = {
    preflight: async () => ({ admitted: false, reason: "test" }),
    pinSessionNode: () => {},
  } as unknown as CapacityService;
  const pool = new WarmPool({
    cfg,
    store,
    provisioner,
    relay,
    capacity,
    snapshotter: {} as Snapshotter,
    now: () => Date.now(),
    serviceAddress: async () => null,
  });
  return { pool, cfg, pods, deletes, claims };
}

function session(pool: WarmPool): SessionRecord {
  return {
    id: "sbx_warm_identity",
    limits: pool.limits(),
    durationSeconds: 60,
    clientPublicKey: "client-public-key",
    clientNonce: "client-nonce",
    baselineCpuMillis: 0,
    baselineMemoryMib: 0,
  } as unknown as SessionRecord;
}

async function tryClaim(h: Harness): Promise<boolean> {
  return h.pool.tryClaim(
    session(h.pool),
    { host: "relay", port: 8443 },
    { host: "proxy", port: 3128 },
    Date.now(),
  );
}

describe("warm pool identity", () => {
  it("does not claim a pod from an older image/config", async () => {
    const h = harness([warmPod("stale-identity", digestA)], digestB);
    expect(await tryClaim(h)).toBe(false);
    expect(h.claims).toHaveLength(0);
  });

  it("drains a pod whose identity differs from the current config", async () => {
    const h = harness([warmPod("stale-identity", digestA)], digestB);
    await h.pool.reconcile();
    expect(h.deletes).toEqual(["warm-aaaaaaaaaaaa"]);
  });

  it("claims a pod carrying the current identity", async () => {
    const h = harness([], digestB);
    h.pods.push(warmPod(identityFor(h.cfg, h.pool), digestB));
    expect(await tryClaim(h)).toBe(true);
    expect(h.claims).toHaveLength(1);
    expect(h.claims[0]?.claim.imageDigest).toBe(digestB);
  });

  it("keeps a matching pod during reconcile", async () => {
    const h = harness([], digestB);
    h.pods.push(warmPod(identityFor(h.cfg, h.pool), digestB));
    await h.pool.reconcile();
    expect(h.deletes).toEqual([]);
  });
});

describe("warmPoolIdentity", () => {
  const base = {
    imageDigest: digestA,
    runtimeClass: "x402-sandbox",
    executionMode: "dev",
    workspaceDir: "/workspace",
    limits: { cpuMillis: 500, memoryMiB: 512, diskMiB: 256 },
  };

  it("changes when the image digest changes", () => {
    expect(warmPoolIdentity({ ...base, imageDigest: digestB })).not.toBe(warmPoolIdentity(base));
  });

  it("changes when the runtime class changes", () => {
    expect(warmPoolIdentity({ ...base, runtimeClass: "other" })).not.toBe(warmPoolIdentity(base));
  });

  it("changes when the pod-shaped limits change", () => {
    expect(
      warmPoolIdentity({ ...base, limits: { ...base.limits, memoryMiB: base.limits.memoryMiB + 1 } }),
    ).not.toBe(warmPoolIdentity(base));
  });
});
