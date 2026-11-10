/**
 * The three create-path effects, executed against a real store.
 *
 * These are the tests the effect interpreter cannot write for itself: what
 * `register_relay`, `ensure_workspace_pvc` and `start_pod` actually do. They run
 * the real transition table, the real guarded writes and the real warm pool,
 * with Kubernetes, the relay and the capacity service stubbed, so the
 * assertions are about state and about calls that really happened.
 *
 * Four behaviours are pinned:
 *
 *  - `PAID -> PROVISIONING` cold: volume, then credential, then pod, then the
 *    guarded write that names it;
 *  - the same transition warm: a pooled pod is claimed, relabelled and rewritten
 *    to this session, and no pod is created;
 *  - a prerequisite that is not ready leaves the row in PAID and creates
 *    nothing;
 *  - a guarded write that loses the race stops the tail instead of leaving a pod
 *    that no session owns.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionLimits, WarmClaim } from "../../shared/src/index.js";
import { sha256Hex } from "../../shared/src/index.js";
import { loadControllerConfig, type ControllerConfig } from "../../controller/src/config.js";
import type { Provisioner } from "../../controller/src/k8s.js";
import type { RelayClient } from "../../controller/src/relay-client.js";
import { Lifecycle } from "../../controller/src/lifecycle.js";
import { Provisioning } from "../../controller/src/provisioning.js";
import { WarmPool } from "../../controller/src/warm-pool.js";
import { warmPoolIdentity } from "../../controller/src/warm-pool-identity.js";
import type { ReconcilerContext } from "../../controller/src/reconciler-context.js";
import type { Snapshotter } from "../../controller/src/snapshotter.js";
import {
  Store,
  type PaymentRecord,
  type SessionRecord,
} from "../../controller/src/store.js";

const NOW = Date.now();

const LIMITS: SessionLimits = {
  cpuMillis: 500,
  memoryMiB: 512,
  diskMiB: 256,
  maxOutputBytes: 262_144,
  maxFileBytes: 8 * 1024 * 1024,
  maxCommandSeconds: 300,
  maxProcesses: 64,
};

const TOKENS = {
  ADMIN_TOKEN: "a".repeat(24),
  RELAY_ADMIN_TOKEN: "r".repeat(24),
  WAKE_TOKEN: "w".repeat(24),
  PROXY_TOKEN_SECRET: "p".repeat(24),
};

function config(env: Record<string, string> = {}): ControllerConfig {
  return loadControllerConfig({
    ...TOKENS,
    ROLE: "all",
    EXECUTION_MODE: "dev",
    ALLOW_INSECURE_DEV: "true",
    KUBERNETES_ENABLED: "false",
    DB_PATH: ":memory:",
    ...env,
  });
}

function payment(key: string): PaymentRecord {
  return {
    paymentKey: key,
    network: "mock:local",
    scheme: "exact",
    asset: "mock:usdc",
    amount: "50000",
    payTo: "0x0000000000000000000000000000000000000402",
    payer: "0x0000000000000000000000000000000000000001",
    transaction: "mock:tx",
    mode: "mock",
  };
}

function sessionRecord(id: string, key: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    capabilityHash: "a".repeat(64),
    capabilityExpiresAt: NOW + 3_600_000,
    clientPublicKey: "client-public-key",
    clientNonce: "client-nonce",
    clientSigner: null,
    tier: "short",
    durationSeconds: 60,
    limits: LIMITS,
    state: "PAID",
    createdAt: NOW,
    paidAt: NOW,
    readyAt: null,
    leaseExpiresAt: null,
    terminatingAt: null,
    destroyedAt: null,
    terminationReason: null,
    failureCode: null,
    failureMessage: null,
    attestationJson: null,
    guestPublicKey: null,
    paymentKey: key,
    podName: null,
    runtimeClass: "x402-sandbox",
    executionMode: "dev",
    relayTokenHash: null,
    activeRequestId: null,
    execEpoch: 1,
    relayPurgedAt: null,
    destroyRequested: 0,
    timingsJson: null,
    idlePolicyJson: null,
    maxLifetimeSeconds: 3_600,
    suspendedAt: null,
    resumeCount: 0,
    lastActivityAt: NOW,
    workspacePvc: null,
    baselineCpuMillis: null,
    baselineMemoryMib: null,
    nodeName: null,
    updatedAt: NOW,
    ...overrides,
  } as unknown as SessionRecord;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "x402-create-path-"));
  dirs.push(dir);
  return new Store(join(dir, "controller.db"));
}

/** Claim then complete, as the API does: a real PAID row through the real guards. */
function seedPaid(store: Store, id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  const key = `${id}-key`;
  const record = sessionRecord(id, key, overrides);
  const claim = store.claimPaymentIntent(key, "a".repeat(64), 30_000);
  if (claim.status !== "claimed") throw new Error("expected claim");
  store.completeEntitlement(key, claim.token, payment(key), record);
  const row = store.getSession(id);
  if (!row) throw new Error("session was not created");
  return row;
}

/** Walk a paid row to SUSPENDED through the store, so the guards are real. */
function seedSuspended(store: Store, id: string): SessionRecord {
  seedPaid(store, id, { idlePolicyJson: "{}", workspacePvc: `x402-ws-${id}` });
  store.setProvisioning(id, `pod-${id}`);
  store.setRelayToken(id, "relay-hash");
  store.setReady(id, NOW, NOW + 60_000, "{}", "guest-pk");
  store.markSuspending(id);
  store.markSuspended(id, NOW + 1000);
  const row = store.getSession(id);
  if (row?.state !== "SUSPENDED") throw new Error(`expected SUSPENDED, got ${row?.state}`);
  return row;
}

/** Everything the provisioning and lifecycle use cases touch, minus the world. */
interface Harness {
  store: Store;
  provisioning: Provisioning;
  lifecycle: Lifecycle;
  calls: string[];
  provisioner: Provisioner;
  relay: RelayClient;
}

function harness(
  opts: {
    cfg?: ControllerConfig;
    serviceAddress?: (name: string, shard?: number) => Promise<{ host: string; port: number } | null>;
    warmPod?: boolean;
    beforePodWrite?: (id: string) => void;
  } = {},
): Harness {
  const cfg = opts.cfg ?? config();
  const store = freshStore();
  const calls: string[] = [];

  const createPod = vi.fn(async (spec: { sessionId: string; guestToken: string; workspacePvc?: string; resume?: boolean }) => {
    calls.push(`createPod:${spec.sessionId}`);
    opts.beforePodWrite?.(spec.sessionId);
    return { podName: `pod-${spec.sessionId}` };
  });
  const createWorkspacePvc = vi.fn(async (sessionId: string) => {
    calls.push(`createWorkspacePvc:${sessionId}`);
    return `x402-ws-${sessionId}`;
  });
  const provisioner = {
    createPod,
    createWorkspacePvc,
    workspacePvcExists: async (pvc: string) => {
      calls.push(`workspacePvcExists:${pvc}`);
      return true;
    },
    deleteWorkspacePvc: async () => undefined,
    suspendPod: async () => undefined,
    deletePod: async (podName: string) => {
      calls.push(`deletePod:${podName}`);
    },
    getPod: async () => null,
    nodeAvailable: async () => true,
    listWorkspacePvcs: async () => [],
    listSandboxPods: async () => [],
    listWarmPods: async () =>
      opts.warmPod
        ? [
            {
              name: "warm-pod-1",
              warmId: "warm1",
              poolId: "warm_warm1",
              createdAt: NOW,
              phase: "Running",
              identity: warmPoolIdentity({
                imageDigest: cfg.guestImageDigest,
                runtimeClass: cfg.runtimeClass,
                executionMode: cfg.executionMode,
                workspaceDir: cfg.workspaceDir,
                limits: { cpuMillis: 500, memoryMiB: 512, diskMiB: 256 },
              }),
              imageDigest: cfg.guestImageDigest,
            },
          ]
        : [],
    patchPodLabels: async (podName: string, labels: Record<string, string | null>) => {
      calls.push(`patchPodLabels:${podName}:${labels["x402.io/session"] ?? ""}`);
    },
    createWarmPod: async () => ({ podName: "unused" }),
    getServiceAddress: async () => null,
    listNodes: async () => [],
  } as unknown as Provisioner;

  const registerCurrent = vi.fn(async (sessionId: string) => {
    calls.push(`registerCurrent:${sessionId}`);
    return { generation: "gen-1", attempts: 1 };
  });
  const claim = vi.fn(async (poolId: string, message: WarmClaim) => {
    calls.push(`claim:${poolId}:${message.sessionId}`);
  });
  const relay = {
    isReady: async () => true,
    registerCurrent,
    claim,
    purge: async (sessionId: string) => {
      calls.push(`purge:${sessionId}`);
    },
    shutdown: async () => undefined,
    state: async () => ({ registered: true, connected: true, attestation: { guestPublicKey: "pk" } }),
    health: async () => ({ ok: true, generation: "gen-1" }),
    healthFor: async () => ({ ok: true, generation: "gen-1" }),
  } as unknown as RelayClient;

  const capacity = {
    // A reservation already exists, so admission is one read and the scheduler
    // is not part of this test.
    getReservation: () => ({ nodeId: "disabled" }),
    attach: async () => ({ admitted: false, reason: "not_used", retryable: false, requested: {} }),
    updatePod: (id: string, podName: string) => calls.push(`updatePod:${id}:${podName}`),
    pinSessionNode: () => true,
    suspend: (id: string) => calls.push(`capacity.suspend:${id}`) || true,
    reassertAllocated: (id: string) => calls.push(`reassertAllocated:${id}`) || true,
    resume: async () => ({
      admitted: true,
      reused: false,
      reservation: { nodeId: "disabled" },
    }),
    beginRelease: () => true,
    preflight: async () => ({ admitted: true }),
  };

  const snapshotter: Snapshotter = {
    capture: async () => {
      calls.push("snapshot.capture");
    },
    restore: async (row) => {
      calls.push(`snapshot.restore:${row.id}`);
    },
    discard: async () => undefined,
  };

  let time = NOW;
  const ctx = {
    cfg,
    store,
    provisioner,
    relay,
    capacity,
    snapshotter,
    now: () => (time += 1),
    serviceAddress:
      opts.serviceAddress ??
      (async () => ({ host: "10.0.0.1", port: 8443 })),
  } as unknown as ReconcilerContext;

  const warm = new WarmPool(ctx);
  const provisioning = new Provisioning(ctx, warm);
  const lifecycle = new Lifecycle(ctx, provisioning);
  return { store, provisioning, lifecycle, calls, provisioner, relay };
}

describe("PAID -> PROVISIONING through the effect interpreter", () => {
  it("creates the workspace, registers the credential and then the pod", async () => {
    const h = harness();
    const row = seedPaid(h.store, "sbx_cold_path_01", { idlePolicyJson: "{}" });

    await h.provisioning.provision(row);

    const after = h.store.getSession("sbx_cold_path_01");
    expect(after?.state).toBe("PROVISIONING");
    expect(after?.podName).toBe("pod-sbx_cold_path_01");
    expect(after?.workspacePvc).toBe("x402-ws-sbx_cold_path_01");
    expect(after?.relayTokenHash).toBeTruthy();

    // The table's order: register the credential, then the volume it will
    // mount, then the pod. Registration used to follow the volume; the table
    // puts it first, and the pod still comes last.
    expect(h.calls).toEqual([
      "registerCurrent:sbx_cold_path_01",
      "createWorkspacePvc:sbx_cold_path_01",
      "createPod:sbx_cold_path_01",
      "updatePod:sbx_cold_path_01:pod-sbx_cold_path_01",
    ]);

    const spec = (h.provisioner.createPod as unknown as { mock: { calls: Array<[Record<string, unknown>]> } })
      .mock.calls[0]![0] as { workspacePvc?: string; guestToken: string };
    expect(spec.workspacePvc).toBe("x402-ws-sbx_cold_path_01");
    // The token the relay was given is the token the pod boots with.
    expect(sha256Hex(spec.guestToken)).toBe(after?.relayTokenHash);
  });

  it("claims a warm pod instead of creating one when the session is not suspendable", async () => {
    const h = harness({ cfg: config({ WARM_POOL_SIZE: "1" }), warmPod: true });
    const row = seedPaid(h.store, "sbx_warm_path_01");

    await h.provisioning.provision(row);

    const after = h.store.getSession("sbx_warm_path_01");
    expect(after?.state).toBe("PROVISIONING");
    expect(after?.podName).toBe("warm-pod-1");
    expect(after?.workspacePvc).toBeNull();
    expect(after?.relayTokenHash).toBeTruthy();

    // No cold create and no workspace: the claim is the whole start.
    expect(h.provisioner.createPod).not.toHaveBeenCalled();
    expect(h.provisioner.createWorkspacePvc).not.toHaveBeenCalled();
    expect(h.calls).toContain("patchPodLabels:warm-pod-1:sbx_warm_path_01");
    expect(h.calls).toContain("claim:warm_warm1:sbx_warm_path_01");

    const claim = (h.relay.claim as unknown as { mock: { calls: Array<[string, WarmClaim]> } })
      .mock.calls[0]![1];
    expect(claim.sessionId).toBe("sbx_warm_path_01");
    expect(sha256Hex(claim.guestToken)).toBe(after?.relayTokenHash);
  });

  it("defers without a pod when the shard has no endpoint", async () => {
    const h = harness({ serviceAddress: async () => null });
    const row = seedPaid(h.store, "sbx_no_endpoint_01");

    await h.provisioning.provision(row);

    const after = h.store.getSession("sbx_no_endpoint_01");
    expect(after?.state).toBe("PAID");
    expect(after?.podName).toBeNull();
    expect(after?.workspacePvc).toBeNull();
    expect(h.provisioner.createPod).not.toHaveBeenCalled();
    expect(h.provisioner.createWorkspacePvc).not.toHaveBeenCalled();
    // A missing endpoint is a retry, not a failed session.
    expect(after?.terminationReason).toBeNull();
  });

  it("stops the tail when the PROVISIONING write loses the race", async () => {
    // A destroy lands between the pod create and the guarded write. The row is
    // no longer PAID, so `setProvisioning` refuses and nothing after it runs.
    const h = harness({
      beforePodWrite: (id) => {
        h.store.requestTermination(id, "client_destroy");
      },
    });
    const row = seedPaid(h.store, "sbx_lost_guard_01");

    await h.provisioning.provision(row);

    const after = h.store.getSession("sbx_lost_guard_01");
    expect(after?.state).toBe("TERMINATING");
    expect(after?.podName).toBeNull();
    // The bookkeeping after the guarded write did not run.
    expect(h.calls).not.toContain("updatePod:sbx_lost_guard_01:pod-sbx_lost_guard_01");
  });
});

describe("SUSPENDED -> RESUMING through the effect interpreter", () => {
  it("restores the workspace, registers the credential and boots a cold pod", async () => {
    const h = harness();
    const row = seedSuspended(h.store, "sbx_resume_path_01");

    await h.lifecycle.resume("sbx_resume_path_01");

    const after = h.store.getSession("sbx_resume_path_01");
    expect(after?.state).toBe("RESUMING");
    expect(after?.podName).toBe("pod-sbx_resume_path_01");
    expect(after?.resumeCount).toBe(1);
    expect(after?.relayTokenHash).toBeTruthy();

    // The checkpoint comes back before the pod that mounts it.
    expect(h.calls.indexOf("snapshot.restore:sbx_resume_path_01")).toBeLessThan(
      h.calls.indexOf("createPod:sbx_resume_path_01"),
    );
    const spec = (h.provisioner.createPod as unknown as { mock: { calls: Array<[Record<string, unknown>]> } })
      .mock.calls[0]![0] as { workspacePvc?: string; resume?: boolean; guestToken: string };
    expect(spec.resume).toBe(true);
    expect(spec.workspacePvc).toBe("x402-ws-sbx_resume_path_01");
    expect(sha256Hex(spec.guestToken)).toBe(after?.relayTokenHash);
    expect(h.calls).toContain("reassertAllocated:sbx_resume_path_01");
  });
});
