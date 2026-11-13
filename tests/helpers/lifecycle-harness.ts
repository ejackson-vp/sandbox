/**
 * One fake durable store and one fake control plane for the lifecycle tests.
 *
 * The store reproduces the SQL compare-and-set guards: a write from the wrong
 * source state refuses and changes nothing. That is what makes a lost race
 * observable in a test without a database, and it is the same contract
 * `Lifecycle` documents for every guarded call.
 */
import fc from "fast-check";
import { expect } from "vitest";
import { isTerminal, type SessionState } from "@x402s/shared/protocol";
import { Lifecycle, LifecycleError } from "../../controller/src/lifecycle.js";
import type { EndpointPair } from "../../controller/src/provisioning/endpoints.js";
import type { Provisioner } from "../../controller/src/k8s.js";
import type { ReconcilerContext } from "../../controller/src/reconciler-context.js";
import type { SessionRecord } from "../../controller/src/store/models.js";
import type { EffectStore, LifecycleStore } from "../../controller/src/store/ports.js";
import { limitsFor, sessionFixture } from "./store-fixtures.js";
import { controllerConfig } from "./controller-config.js";

export const NOW = 1_000_000;
const STATES: SessionState[] = [
  "CREATED",
  "PAID",
  "PROVISIONING",
  "READY",
  "ACTIVE",
  "SUSPENDING",
  "SUSPENDED",
  "RESUMING",
  "TERMINATING",
  "EXPIRED",
  "FAILED",
  "DESTROYED",
];

export const stateArb = fc.constantFrom(...STATES);

export interface SessionShape {
  state: SessionState;
  suspendable: boolean;
  hasPvc: boolean;
  hasPod: boolean;
  hasRelay: boolean;
  nodeName: string | null;
  maxLifetimeSeconds: number | null;
  ageMs: number;
  suspendedForMs: number | null;
  maxIdleSeconds: number | null;
  lastActivityAgoMs: number | null;
  suspendedDurationSeconds: number | null;
}

export const shapeArb: fc.Arbitrary<SessionShape> = fc.record({
  state: stateArb,
  suspendable: fc.boolean(),
  hasPvc: fc.boolean(),
  hasPod: fc.boolean(),
  hasRelay: fc.boolean(),
  nodeName: fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: null }),
  maxLifetimeSeconds: fc.option(fc.integer({ min: 1, max: 28_800 }), { nil: null }),
  ageMs: fc.integer({ min: 0, max: 10 ** 9 }),
  suspendedForMs: fc.option(fc.integer({ min: 0, max: 10 ** 9 }), { nil: null }),
  maxIdleSeconds: fc.option(fc.integer({ min: 1, max: 28_800 }), { nil: null }),
  lastActivityAgoMs: fc.option(fc.integer({ min: 0, max: 10 ** 9 }), { nil: null }),
  suspendedDurationSeconds: fc.option(fc.integer({ min: 1, max: 28_800 }), { nil: null }),
});

export function record(shape: SessionShape): SessionRecord {
  const idle = shape.suspendable
    ? JSON.stringify({
          ...(shape.maxIdleSeconds !== null ? { maxIdleSeconds: shape.maxIdleSeconds } : {}),
          ...(shape.suspendedDurationSeconds !== null
            ? { suspendedDurationSeconds: shape.suspendedDurationSeconds }
            : {}),
      })
    : null;
  return sessionFixture({
    id: "sbx_lifecycle",
    paymentKey: "payment-lifecycle",
    tier: "standard",
    durationSeconds: 300,
    limits: limitsFor("unit"),
    clientPublicKey: "pk".repeat(22),
    clientNonce: "nn".repeat(22),
    now: NOW - shape.ageMs,
    overrides: {
      state: shape.state,
      createdAt: NOW - shape.ageMs,
      idlePolicyJson: idle,
      workspacePvc: shape.hasPvc ? "x402-ws-sbx_lifecycle" : null,
      podName: shape.hasPod ? "sbx-lifecycle" : null,
      relayTokenHash: shape.hasRelay ? "hash" : null,
      nodeName: shape.nodeName,
      maxLifetimeSeconds: shape.maxLifetimeSeconds,
      suspendedAt: shape.suspendedForMs === null ? null : NOW - shape.suspendedForMs,
      lastActivityAt:
        shape.lastActivityAgoMs === null ? null : NOW - shape.lastActivityAgoMs,
      leaseExpiresAt: shape.state === "READY" ? NOW + 60_000 : null,
    },
  });
}

export interface HarnessOptions {
  sessions?: SessionRecord[];
  pvcExists?: boolean;
  nodeAvailable?: boolean;
  endpoints?: EndpointPair;
  admission?: { admitted: boolean; reason?: string; retryable?: boolean };
  refuseSuspending?: boolean;
  /** Node a Running Pod reports, for the checkpoint-node adoption path. */
  podNode?: string;
  /** Make the checkpoint restore throw after admission. */
  restoreThrows?: boolean;
}

export function harness(options: HarnessOptions = {}) {
  const cfg = controllerConfig({ PIN_CHECKPOINT_NODE: "true" });
  const store = new FakeStore(options.sessions ?? []);
  const podDeletes: string[] = [];
  const podSuspends: string[] = [];
  const pvcDeletes: string[] = [];
  const captures: string[] = [];
  const restores: string[] = [];
  const shutdowns: Array<{ id: string; reason: string }> = [];
  const purges: string[] = [];
  const capacityCalls = { suspend: [] as string[], resume: [] as string[] };
  const starts: Array<{ sessionId: string; resume: boolean; nodeName?: string }> = [];

  const provisioner = {
    suspendPod: async (name: string) => {
      podSuspends.push(name);
      store.clearPod("sbx_lifecycle");
    },
    deletePod: async (name: string) => {
      podDeletes.push(name);
      store.clearPod("sbx_lifecycle");
    },
    deleteWorkspacePvc: async (name: string) => {
      pvcDeletes.push(name);
    },
    getPod: async () =>
      options.podNode ? { phase: "Running", deleted: false, nodeName: options.podNode } : null,
    workspacePvcExists: async () => options.pvcExists ?? true,
    nodeAvailable: async () => options.nodeAvailable ?? true,
  } as unknown as Provisioner;

  const relay = {
    shutdown: async (id: string, reason: string) => {
      shutdowns.push({ id, reason });
    },
    purge: async (id: string) => {
      purges.push(id);
    },
  } as unknown as ReconcilerContext["relay"];

  const snapshotter = {
    capture: async (session: SessionRecord) => {
      captures.push(session.id);
    },
    restore: async (session: SessionRecord) => {
      if (options.restoreThrows) throw new Error("checkpoint restore failed");
      restores.push(session.id);
    },
    discard: async () => {},
  } as unknown as ReconcilerContext["snapshotter"];

  const capacity = {
    suspend: async (id: string) => {
      capacityCalls.suspend.push(id);
      return true;
    },
    resume: async (session: SessionRecord) => {
      capacityCalls.resume.push(session.id);
      return options.admission ?? { admitted: true, nodeId: "node-a", reason: undefined };
    },
  } as unknown as ReconcilerContext["capacity"];

  const provisioning = {
    endpointsFor: async (): Promise<EndpointPair> =>
      options.endpoints ?? {
        relay: { host: "relay", port: 8443 },
        proxy: { host: "proxy", port: 3128 },
      },
    registerRelay: async () => ({ guestToken: "guest", tokenHash: "hash", generation: "g" }),
    ensureWorkspace: async (session: SessionRecord) => session.workspacePvc ?? undefined,
    startPod: async (session: SessionRecord, _registration: unknown, request: { resume?: boolean; nodeName?: string }) => {
      starts.push({ sessionId: session.id, resume: request.resume === true, nodeName: request.nodeName });
      return store.markResuming(session.id, "pod-resumed");
    },
  } as unknown as ConstructorParameters<typeof Lifecycle>[1];

  const ctx = {
    cfg,
    store,
    provisioner,
    relay,
    capacity,
    snapshotter,
    now: () => NOW,
    serviceAddress: async () => null,
    stableServiceAddress: async () => null,
  } as unknown as ConstructorParameters<typeof Lifecycle>[0];

  return {
    cfg,
    store,
    lifecycle: new Lifecycle(ctx, provisioning),
    podDeletes,
    podSuspends,
    pvcDeletes,
    captures,
    restores,
    shutdowns,
    purges,
    capacityCalls,
    starts,
  };
}

/**
 * The durable store, with the same guards as the SQL. Every write is a
 * compare-and-set on the source state; a refusal is answered, never thrown.
 */
class FakeStore implements LifecycleStore, EffectStore {
  private readonly sessions: Map<string, SessionRecord>;
  public refuseSuspending = false;
  public readonly terminations: Array<{ id: string; reason: string; code?: string }> = [];

  constructor(sessions: SessionRecord[]) {
    this.sessions = new Map(sessions.map((session) => [session.id, { ...session }]));
  }

  private row(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  /** Move a row behind the store's back, to model a concurrent writer. */
  forceState(id: string, state: SessionState): void {
    const row = this.row(id);
    if (row) row.state = state;
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const row = this.row(id);
    return row ? { ...row } : null;
  }

  async listNonTerminal(): Promise<SessionRecord[]> {
    return [...this.sessions.values()].filter((row) => !isTerminal(row.state)).map((row) => ({ ...row }));
  }

  async listTerminalWithPvc(): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .filter((row) => isTerminal(row.state) && row.workspacePvc !== null)
      .map((row) => ({ ...row }));
  }

  async markSuspending(id: string): Promise<boolean> {
    if (this.refuseSuspending) return false;
    const row = this.row(id);
    if (!row || (row.state !== "READY" && row.state !== "ACTIVE")) return false;
    row.state = "SUSPENDING";
    return true;
  }

  async markSuspended(id: string, suspendedAt: number): Promise<boolean> {
    const row = this.row(id);
    if (!row || row.state !== "SUSPENDING") return false;
    row.state = "SUSPENDED";
    row.suspendedAt = suspendedAt;
    row.podName = null;
    row.leaseExpiresAt = null;
    return true;
  }

  async markResuming(id: string, podName: string): Promise<boolean> {
    const row = this.row(id);
    if (!row || row.state !== "SUSPENDED") return false;
    row.state = "RESUMING";
    row.podName = podName;
    row.suspendedAt = null;
    row.resumeCount += 1;
    row.leaseExpiresAt = null;
    return true;
  }

  async setProvisioning(id: string, podName: string): Promise<boolean> {
    const row = this.row(id);
    if (!row || row.state !== "PAID") return false;
    row.state = "PROVISIONING";
    row.podName = podName;
    return true;
  }

  async requestTermination(
    id: string,
    reason: string,
    failure?: { code: string; message: string },
  ): Promise<boolean> {
    const row = this.row(id);
    const from = ["PAID", "PROVISIONING", "READY", "ACTIVE", "SUSPENDING", "SUSPENDED", "RESUMING"];
    if (!row || !from.includes(row.state)) return false;
    row.state = "TERMINATING";
    row.terminationReason = reason;
    this.terminations.push({ id, reason, ...(failure ? { code: failure.code } : {}) });
    return true;
  }

  async clearPod(id: string): Promise<void> {
    const row = this.row(id);
    if (row) row.podName = null;
  }

  async clearWorkspacePvc(id: string): Promise<void> {
    const row = this.row(id);
    if (row) row.workspacePvc = null;
  }

  async markRelayPurged(id: string): Promise<void> {
    const row = this.row(id);
    if (row) row.relayPurgedAt = NOW;
  }

  async setNodeName(id: string, nodeName: string): Promise<void> {
    const row = this.row(id);
    if (row) row.nodeName = nodeName;
  }

  async setReady(): Promise<boolean> {
    return false;
  }

  async finalizeTermination(): Promise<SessionState | null> {
    return null;
  }
}

export async function refusal(promise: Promise<unknown>): Promise<LifecycleError | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(LifecycleError);
    return err as LifecycleError;
  }
}

export function baseShape(): SessionShape {
  return {
    state: "READY",
    suspendable: true,
    hasPvc: true,
    hasPod: true,
    hasRelay: true,
    nodeName: "node-a",
    maxLifetimeSeconds: null,
    ageMs: 0,
    suspendedForMs: null,
    maxIdleSeconds: null,
    lastActivityAgoMs: 0,
    suspendedDurationSeconds: null,
  };
}

