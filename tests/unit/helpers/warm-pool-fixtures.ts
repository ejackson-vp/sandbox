/**
 * Shared fixtures for the profile-aware warm pool.
 *
 * The harness owns a fake clock, a fake namespace of warm pods and a fake
 * capacity service, so pool growth, hysteresis and draining can be driven one
 * pass at a time without sleeping or touching a cluster.
 */
import { loadControllerConfig, type ControllerConfig } from "../../../controller/src/config.js";
import type { CapacityService } from "../../../controller/src/capacity/service.js";
import type { Provisioner, WarmPodInfo, WarmPodSpec } from "../../../controller/src/k8s.js";
import type { RelayClient } from "../../../controller/src/relay-client.js";
import type { ReconcilerContext } from "../../../controller/src/reconciler-context.js";
import type { Snapshotter } from "../../../controller/src/snapshotter.js";
import type { SessionRecord } from "../../../controller/src/store/models.js";
import type { PostgresStore } from "../../../controller/src/store/postgres/store.js";
import type { WarmClaim } from "@x402s/shared/protocol";
import { WarmPoolManager } from "../../../controller/src/warm-pool-manager.js";

export const digestBase = `sha256:${"a".repeat(64)}`;
export const digestPython = `sha256:${"b".repeat(64)}`;
export const digestNode = `sha256:${"c".repeat(64)}`;

const PROFILE_CATALOG = {
  python: { image: "ghcr.io/example/guest:0.1.0-python", digest: digestPython },
  node: { image: "ghcr.io/example/guest:0.1.0-node", digest: digestNode },
};

export function config(extra: NodeJS.ProcessEnv = {}): ControllerConfig {
  return loadControllerConfig({
    ADMIN_TOKEN: "a".repeat(24),
    RELAY_ADMIN_TOKEN: "r".repeat(24),
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "p".repeat(24),
    EXECUTION_MODE: "dev",
    ALLOW_INSECURE_DEV: "true",
    KUBERNETES_ENABLED: "false",
    DATABASE_URL: "postgres://user:pw@db:5432/sandbox",
    GUEST_IMAGE: "ghcr.io/example/guest:0.1.0",
    GUEST_IMAGE_DIGEST: digestBase,
    RUNTIME_PROFILES: JSON.stringify(PROFILE_CATALOG),
    // Pool on by default; tests that care about sizing pass their own budget.
    WARM_POOL_SIZE: "4",
    ...extra,
  });
}

interface WarmHarness {
  cfg: ControllerConfig;
  manager: WarmPoolManager;
  /** Live warm pods, mutated by deletes and creates. */
  pods: WarmPodInfo[];
  deletes: string[];
  claims: Array<{ poolId: string; claim: WarmClaim }>;
  creates: WarmPodSpec[];
  clock: { now: number };
  advance(ms: number): void;
  claim(runtime?: string, overrides?: Partial<SessionRecord>): Promise<boolean>;
  session(runtime?: string, overrides?: Partial<SessionRecord>): SessionRecord;
  reconcile(): Promise<void>;
}

interface HarnessOptions {
  env?: NodeJS.ProcessEnv;
  /** Start the fake clock well past the idle grace so pools look idle. */
  startAt?: number;
  capacityAdmitted?: boolean;
}

export function harness(opts: HarnessOptions = {}): WarmHarness {
  const cfg = config(opts.env);
  const clock = { now: opts.startAt ?? 10_000_000 };
  const pods: WarmPodInfo[] = [];
  const deletes: string[] = [];
  const claims: Array<{ poolId: string; claim: WarmClaim }> = [];
  const creates: WarmPodSpec[] = [];

  const provisioner = {
    listWarmPods: async () => pods.map((pod) => ({ ...pod })),
    deletePod: async (name: string) => {
      deletes.push(name);
      const index = pods.findIndex((pod) => pod.name === name);
      if (index >= 0) pods.splice(index, 1);
    },
    patchPodLabels: async () => {},
    createWarmPod: async (spec: WarmPodSpec) => {
      creates.push(spec);
      pods.push({
        name: `warm-${spec.warmId}`,
        warmId: spec.warmId,
        poolId: spec.poolId,
        createdAt: clock.now,
        phase: "Running",
        runtime: spec.runtime,
        identity: spec.identity,
        imageDigest: spec.imageDigest,
      });
      return { podName: `warm-${spec.warmId}` };
    },
  } as unknown as Provisioner;

  const relay = {
    state: async () => ({
      registered: true,
      connected: true,
      attestation: { sessionId: "warm_pool" },
      pending: 0,
    }),
    registerCurrent: async () => ({ generation: "test", attempts: 1 }),
    claim: async (poolId: string, claim: WarmClaim) => {
      claims.push({ poolId, claim });
    },
    purge: async () => {},
  } as unknown as RelayClient;

  const capacity = {
    preflight: async () => ({ admitted: opts.capacityAdmitted ?? true, reason: "test" }),
    pinSessionNode: () => {},
  } as unknown as CapacityService;

  const store = {
    mergeTimings: () => {},
    setProvisioning: () => true,
    setRelayToken: () => {},
    requestTermination: () => true,
  } as unknown as PostgresStore;

  const ctx: ReconcilerContext = {
    cfg,
    store,
    provisioner,
    relay,
    capacity,
    snapshotter: {} as Snapshotter,
    now: () => clock.now,
    serviceAddress: async (name: string) =>
      name === cfg.proxyServiceName
        ? { host: "proxy", port: 3128 }
        : { host: "relay", port: 8443 },
  };

  const manager = new WarmPoolManager(ctx);

  const session = (runtime?: string, overrides: Partial<SessionRecord> = {}): SessionRecord =>
    ({
      id: "sbx_warm_test",
      limits: {
        cpuMillis: 500,
        memoryMiB: 512,
        diskMiB: 256,
        maxOutputBytes: 1_048_576,
        maxFileBytes: 1_048_576,
        maxCommandSeconds: 300,
        maxProcesses: 64,
      },
      durationSeconds: 60,
      clientPublicKey: "client-public-key",
      clientNonce: "client-nonce",
      baselineCpuMillis: 0,
      baselineMemoryMib: 0,
      ...(runtime === undefined ? {} : { runtime }),
      ...overrides,
    }) as unknown as SessionRecord;

  return {
    cfg,
    manager,
    pods,
    deletes,
    claims,
    creates,
    clock,
    advance: (ms: number) => {
      clock.now += ms;
    },
    session,
    claim: (runtime?: string, overrides?: Partial<SessionRecord>) =>
      manager.tryClaim(
        session(runtime, overrides),
        { host: "relay", port: 8443 },
        { host: "proxy", port: 3128 },
        clock.now,
      ),
    reconcile: () => manager.reconcile(),
  };
}

/** A warm pod that looks claimable for the given profile. */
export function warmPod(
  runtime: string,
  identity: string,
  imageDigest: string,
  overrides: Partial<WarmPodInfo> = {},
): WarmPodInfo {
  const warmId = overrides.warmId ?? "aaaaaaaaaaaa";
  return {
    name: `warm-${warmId}`,
    warmId,
    poolId: `warm_${warmId}`,
    createdAt: 0,
    phase: "Running",
    runtime,
    identity,
    imageDigest,
    ...overrides,
  };
}
