/**
 * The effect interpreter.
 *
 * Three things are worth pinning here:
 *
 *  - every `SessionEffect` variant is executed, so a new variant cannot be
 *    silently ignored (the switch's `assertNever` is the compile-time half,
 *    this is the runtime half);
 *  - the transition table only emits variants the interpreter inventories, and
 *    `terminationEffects` is exactly what the table returns when it enters
 *    TERMINATING;
 *  - a guarded write that loses the race stops the sequence, so no external
 *    effect runs for a transition that did not happen, and a `deferred` outcome
 *    is a stop rather than a success.
 */
import { describe, expect, it, vi } from "vitest";
import {
  SOURCE_STATES,
  SESSION_STATES,
  terminationEffects,
  transition,
  type SessionEffect,
  type SessionEvent,
  type SessionSnapshot,
  type SessionState,
} from "../../shared/src/entries/protocol.js";
import {
  EFFECT_VARIANTS,
  EffectContextError,
  OK,
  createPath,
  deferred,
  effectContext,
  executeEffect,
  executeEffects,
  isOk,
  refused,
  type CreatePath,
  type EffectOutcome,
  type EffectRuntime,
} from "../../controller/src/effects.js";
import type { SessionRecord } from "../../controller/src/store/models.js";
import { Termination } from "../../controller/src/termination.js";
import { Lifecycle } from "../../controller/src/lifecycle.js";
import { loadControllerConfig } from "../../controller/src/config.js";
import type { ReconcilerContext } from "../../controller/src/reconciler-context.js";
import type { Provisioning } from "../../controller/src/provisioning.js";

const NOW = 1_700_000_000_000;

/**
 * The create-path machinery, recorded the same way. The interpreter delegates
 * all three provisioning effects to it, so their bodies are exactly "call the
 * use case once": registering the guest credential, making the workspace
 * volume, and starting the pod are not reimplemented in the switch.
 */
function recordingCreatePath(opts: { started?: boolean } = {}) {
  const calls: string[] = [];
  const path: CreatePath = {
    registerRelay: async (row) => {
      calls.push("registerRelay");
      return { guestToken: `guest-${row.id}`, tokenHash: "token-hash", generation: "gen-1" };
    },
    ensureWorkspace: async () => {
      calls.push("ensureWorkspace");
      return "x402-ws-effects-0001";
    },
    startPod: async (_row, _registration, request) => {
      calls.push(`startPod:${request.warm ? "warm" : "cold"}`);
      return opts.started ?? true;
    },
  };
  return { path, calls };
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "sbx_effects_0001",
    state: "READY",
    createdAt: NOW - 60_000,
    paidAt: NOW - 60_000,
    readyAt: NOW - 30_000,
    leaseExpiresAt: NOW + 60_000,
    terminatingAt: null,
    suspendedAt: null,
    terminationReason: null,
    idlePolicyJson: "{}",
    maxLifetimeSeconds: 3_600,
    lastActivityAt: NOW - 1_000,
    podName: "sbx-effects-0001",
    workspacePvc: "x402-ws-effects-0001",
    relayTokenHash: "relay-token-hash",
    relayPurgedAt: null,
    resumeCount: 0,
    nodeName: "node-1",
    timingsJson: null,
    ...overrides,
  } as unknown as SessionRecord;
}

/** Records every call an effect makes, in order. */
function recordingRuntime(opts: { guard?: boolean } = {}) {
  const calls: string[] = [];
  const guard = opts.guard ?? true;
  const runtime: EffectRuntime = {
    store: {
      clearPod: async () => {
        calls.push("clearPod");
      },
      clearWorkspacePvc: async () => {
        calls.push("clearWorkspacePvc");
      },
      finalizeTermination: async () => {
        calls.push("finalizeTermination");
        return guard ? "DESTROYED" : null;
      },
      markRelayPurged: async () => {
        calls.push("markRelayPurged");
      },
      markSuspended: async () => {
        calls.push("markSuspended");
        return guard;
      },
      markSuspending: async () => {
        calls.push("markSuspending");
        return guard;
      },
      setReady: async () => {
        calls.push("setReady");
        return guard;
      },
    },
    relay: {
      shutdown: async () => {
        calls.push("shutdown");
      },
      purge: async () => {
        calls.push("purge");
      },
    },
    provisioner: {
      deletePod: async () => {
        calls.push("deletePod");
      },
      suspendPod: async () => {
        calls.push("suspendPod");
      },
      deleteWorkspacePvc: async () => {
        calls.push("deleteWorkspacePvc");
      },
    },
    snapshotter: {
      discard: async () => {
        calls.push("discard");
      },
    },
    now: () => NOW,
  };
  return { runtime, calls };
}

const READY = {
  readyAt: NOW,
  leaseExpiresAt: NOW + 60_000,
  attestationJson: "{}",
  guestPublicKey: "guest-pk",
};

describe("effect interpreter", () => {
  it("executes every variant, reaching the create path for the three it owns", async () => {
    for (const effect of Object.values(EFFECT_VARIANTS)) {
      const { runtime, calls } = recordingRuntime();
      const create = recordingCreatePath();
      const ctx = effectContext(runtime, session(), {
        ready: READY,
        create: createPath(create.path, {
          relay: { host: "10.0.0.1", port: 8443 },
          proxy: { host: "10.0.0.9", port: 3128 },
        }),
      });
      // `start_pod` boots the credential `register_relay` staged, exactly as
      // the table orders them, so the pair runs in order.
      if (effect.type === "start_pod") await executeEffect(EFFECT_VARIANTS.register_relay, ctx);
      const outcome = await executeEffect(effect, ctx);
      expect(outcome, effect.type).toEqual(OK);
      expect(calls.length + create.calls.length, `${effect.type} reached the world`).toBeGreaterThan(0);
    }
  });

  it("throws when the context lacks what an effect acts on", async () => {
    const { runtime } = recordingRuntime();
    const noHandshake = effectContext(runtime, session());
    await expect(executeEffect(EFFECT_VARIANTS.persist_ready, noHandshake)).rejects.toMatchObject({
      name: "EffectContextError",
      effect: "persist_ready",
    });
    // A create-path effect with no create path is a caller bug, not a state the
    // loop can recover from: it fails loudly instead of skipping a paid session.
    await expect(executeEffect(EFFECT_VARIANTS.start_pod, noHandshake)).rejects.toBeInstanceOf(
      EffectContextError,
    );
  });

  it("defers when the create path cannot supply a workspace yet", async () => {
    const { runtime } = recordingRuntime();
    const create = recordingCreatePath();
    const ctx = effectContext(runtime, session(), {
      create: createPath(
        { ...create.path, ensureWorkspace: async () => undefined },
        { relay: { host: "10.0.0.1", port: 8443 }, proxy: { host: "10.0.0.9", port: 3128 } },
      ),
    });
    expect(await executeEffect(EFFECT_VARIANTS.ensure_workspace_pvc, ctx)).toEqual({
      status: "deferred",
      effect: "ensure_workspace_pvc",
      reason: "not_ready",
    });
  });

  it("refuses a lost guarded write in start_pod and stops the list", async () => {
    const { runtime } = recordingRuntime();
    const create = recordingCreatePath({ started: false });
    const ctx = effectContext(runtime, session(), {
      create: createPath(create.path, {
        relay: { host: "10.0.0.1", port: 8443 },
        proxy: { host: "10.0.0.9", port: 3128 },
      }),
    });
    // A synthetic order: the table never emits an effect after `start_pod`, so
    // the interpreter's stop-on-refusal contract is what is under test.
    const outcome = await executeEffects(
      [EFFECT_VARIANTS.register_relay, EFFECT_VARIANTS.start_pod, EFFECT_VARIANTS.ensure_workspace_pvc],
      ctx,
    );
    expect(outcome).toEqual({ status: "refused", effect: "start_pod", reason: "guard_lost" });
    expect(create.calls).toEqual(["registerRelay", "startPod:cold"]);
  });

  it("only emits effects it has an execution for", () => {
    const emitted = new Set<SessionEffect["type"]>();
    for (const state of SESSION_STATES) {
      for (const event of tableEvents()) {
        for (const snapshot of snapshots(state)) {
          const result = transition(snapshot, event);
          if (!result.ok) continue;
          for (const effect of result.value.effects) emitted.add(effect.type);
        }
      }
    }
    // Equality, not a subset: a variant the table stops emitting should be
    // deleted rather than left as dead interpretation.
    expect([...emitted].sort()).toEqual(Object.keys(EFFECT_VARIANTS).sort());
  });

  it("terminationEffects is what the table returns on every entry into TERMINATING", () => {
    for (const event of [
      { type: "terminate_requested", reason: "client_destroy" },
      { type: "lease_expired" },
    ] as SessionEvent[]) {
      for (const state of SOURCE_STATES[event.type]) {
        for (const snapshot of snapshots(state)) {
          const result = transition(snapshot, event);
          expect(result.ok, `${state} + ${event.type}`).toBe(true);
          if (result.ok) {
            expect(result.value.state).toBe("TERMINATING");
            expect(result.value.effects).toEqual(terminationEffects(snapshot));
          }
        }
      }
    }
  });

  it("returns ok when every effect runs", async () => {
    const { runtime, calls } = recordingRuntime();
    const outcome = await executeEffects(
      [{ type: "persist_suspending" }, { type: "stop_guest", intent: "suspend" }],
      effectContext(runtime, session()),
    );
    expect(outcome).toEqual({ status: "ok" });
    expect(calls).toEqual(["markSuspending", "shutdown"]);
  });

  it("returns ok for an empty list", async () => {
    const { runtime, calls } = recordingRuntime();
    expect(await executeEffects([], effectContext(runtime, session()))).toEqual({ status: "ok" });
    expect(calls).toEqual([]);
  });

  it("stops at a refused guarded write", async () => {
    const { runtime, calls } = recordingRuntime({ guard: false });
    const applied = await executeEffects(
      [{ type: "persist_suspending" }, { type: "stop_guest", intent: "suspend" }],
      effectContext(runtime, session()),
    );
    expect(applied).toEqual({
      status: "refused",
      effect: "persist_suspending",
      reason: "guard_lost",
    });
    expect(calls).toEqual(["markSuspending"]);
  });

  it("treats a deferred outcome as a stop, not a success", () => {
    // `ensure_workspace_pvc` is the variant that defers today: a volume that
    // cannot be made yet stops the list and leaves the row where it is. This
    // pins the vocabulary itself, and the loop above stops on anything `isOk`
    // rejects, so deferred stops exactly like a refusal.
    const outcome: EffectOutcome = deferred(EFFECT_VARIANTS.persist_suspending);
    expect(outcome).toEqual({
      status: "deferred",
      effect: "persist_suspending",
      reason: "not_ready",
    });
    expect([isOk(OK), isOk(refused(EFFECT_VARIANTS.finalize)), isOk(outcome)]).toEqual([
      true,
      false,
      false,
    ]);
  });
});

describe("termination", () => {
  it("cleans up through the effects of entering TERMINATING, then finalises", async () => {
    const calls: string[] = [];
    const row = session({ state: "TERMINATING", terminationReason: "client_destroy" });
    const ctx = {
      cfg: controllerConfig(),
      store: {
        clearPod: () => calls.push("clearPod"),
        clearWorkspacePvc: () => calls.push("clearWorkspacePvc"),
        markRelayPurged: () => calls.push("markRelayPurged"),
        finalizeTermination: () => {
          calls.push("finalizeTermination");
          return "DESTROYED";
        },
        mergeTimings: () => calls.push("mergeTimings"),
        getLedgerBySession: () => null,
        markSuspending: () => false,
        markSuspended: () => false,
        setReady: () => false,
        getSession: () => row,
        requestTermination: () => true,
      },
      provisioner: {
        deletePod: vi.fn(async () => {
          calls.push("deletePod");
        }),
        suspendPod: vi.fn(async () => undefined),
        deleteWorkspacePvc: async () => {
          calls.push("deleteWorkspacePvc");
        },
      },
      relay: {
        shutdown: async () => {
          calls.push("shutdown");
        },
        purge: async () => {
          calls.push("purge");
        },
      },
      capacity: {
        beginRelease: () => calls.push("beginRelease"),
      },
      snapshotter: {
        discard: async () => {
          calls.push("discard");
        },
      },
      now: () => NOW,
      serviceAddress: async () => null,
    } as unknown as ReconcilerContext;

    await new Termination(ctx).terminate(row);

    expect(calls).toEqual([
      "shutdown",
      "deletePod",
      "clearPod",
      "purge",
      "markRelayPurged",
      "discard",
      "deleteWorkspacePvc",
      "clearWorkspacePvc",
      "beginRelease",
      "mergeTimings",
      "finalizeTermination",
    ]);
    expect(ctx.provisioner.deletePod).toHaveBeenCalledWith("sbx-effects-0001", 1);
  });
});

describe("lifecycle suspend", () => {
  interface Harness {
    lifecycle: Lifecycle;
    calls: string[];
    setGuard: (value: boolean) => void;
  }

  function harness(state: SessionState = "READY"): Harness {
    const calls: string[] = [];
    let guard = true;
    const row = session({ state });
    const ctx = {
      cfg: controllerConfig(),
      store: {
        getSession: () => row,
        markSuspending: () => {
          calls.push("markSuspending");
          if (guard) row.state = "SUSPENDING";
          return guard;
        },
        markSuspended: () => {
          calls.push("markSuspended");
          if (guard) {
            row.state = "SUSPENDED";
            row.suspendedAt = NOW;
          }
          return guard;
        },
        markRelayPurged: () => calls.push("markRelayPurged"),
        clearPod: () => {
          calls.push("clearPod");
          row.podName = null;
        },
        setNodeName: () => undefined,
        clearWorkspacePvc: () => calls.push("clearWorkspacePvc"),
        finalizeTermination: () => null,
        setReady: () => false,
        requestTermination: () => true,
        listNonTerminal: () => [],
        listTerminalWithPvc: () => [],
      },
      provisioner: {
        getPod: async () => null,
        suspendPod: async () => {
          calls.push("suspendPod");
        },
        deletePod: async () => calls.push("deletePod"),
        deleteWorkspacePvc: async () => calls.push("deleteWorkspacePvc"),
      },
      relay: {
        shutdown: async () => {
          calls.push("shutdown");
        },
        purge: async () => {
          calls.push("purge");
        },
      },
      capacity: {
        suspend: () => calls.push("capacity.suspend"),
      },
      snapshotter: {
        capture: async () => {
          calls.push("capture");
        },
        discard: async () => calls.push("discard"),
      },
      now: () => NOW,
      serviceAddress: async () => null,
    } as unknown as ReconcilerContext;
    return {
      lifecycle: new Lifecycle(ctx, {} as Provisioning),
      calls,
      setGuard: (value) => {
        guard = value;
      },
    };
  }

  it("suspends in table order: fence the state, stop the guest, release compute", async () => {
    const { lifecycle, calls } = harness();
    await lifecycle.suspend("sbx_effects_0001");
    expect(calls).toEqual([
      "markSuspending",
      "shutdown",
      "capture",
      "suspendPod",
      "clearPod",
      "markSuspended",
      "purge",
      "markRelayPurged",
      "capacity.suspend",
    ]);
  });

  it("runs no external effect when the persist_suspending guard loses the race", async () => {
    const { lifecycle, calls, setGuard } = harness();
    setGuard(false);
    // The same refusal the store's guarded UPDATE produced before the table
    // drove the sequence: one error, nothing else touched.
    await expect(lifecycle.suspend("sbx_effects_0001")).rejects.toMatchObject({
      code: "not_suspendable",
      message: "session changed state while suspending",
    });
    expect(calls).toEqual(["markSuspending"]);
    expect(calls).not.toContain("shutdown");
    expect(calls).not.toContain("capture");
    expect(calls).not.toContain("suspendPod");
  });

  it("refuses a session that is not suspendable", async () => {
    const { lifecycle, calls } = harness("PAID");
    await expect(lifecycle.suspend("sbx_effects_0001")).rejects.toMatchObject({
      code: "not_suspendable",
      message: "session is PAID",
    });
    expect(calls).toEqual([]);
  });

  it("replays the stop of an interrupted suspend as a table transition", () => {
    const snapshot = snapshots("SUSPENDING")[0]!;
    const retry = transition(snapshot, { type: "suspend_retry" });
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      // A self-transition: the stop is replayed, the row does not move until
      // the checkpoint is committed by `guest_stopped`.
      expect(retry.value.state).toBe("SUSPENDING");
      expect(retry.value.effects).toEqual([{ type: "stop_guest", intent: "suspend" }]);
    }
    expect(SOURCE_STATES.suspend_retry).toEqual(["SUSPENDING"]);
  });

  it("drives the replay and then the commit of an interrupted suspend", async () => {
    const { lifecycle, calls } = harness("SUSPENDING");
    await lifecycle.reconcileSuspend(session({ state: "SUSPENDING" }));
    expect(calls).toEqual([
      "shutdown",
      "capture",
      "suspendPod",
      "clearPod",
      "markSuspended",
      "purge",
      "markRelayPurged",
      "capacity.suspend",
    ]);
  });
});

function controllerConfig() {
  return loadControllerConfig({
    ADMIN_TOKEN: "p".repeat(24),
    ROLE: "all",
    EXECUTION_MODE: "dev",
    ALLOW_INSECURE_DEV: "true",
    KUBERNETES_ENABLED: "false",
    DB_PATH: ":memory:",
    RELAY_ADMIN_TOKEN: "r".repeat(24),
    WAKE_TOKEN: "w".repeat(24),
    PROXY_TOKEN_SECRET: "proxy-secret-0123456789",
  });
}

/** Every event the table accepts, with a value for the ones that carry one. */
function tableEvents(): SessionEvent[] {
  return [
    { type: "payment_settled" },
    { type: "provision_requested" },
    { type: "guest_ready" },
    { type: "operation_started" },
    { type: "operation_finished" },
    { type: "suspend_requested" },
    { type: "guest_stopped" },
    { type: "suspend_retry" },
    { type: "resume_requested" },
    { type: "lease_expired" },
    { type: "terminate_requested", reason: "client_destroy" },
    { type: "terminated", final: "DESTROYED" },
  ];
}

/** The resource and policy combinations the effect lists depend on. */
function snapshots(state: SessionState): SessionSnapshot[] {
  const out: SessionSnapshot[] = [];
  for (const hasPod of [false, true]) {
    for (const hasPvc of [false, true]) {
      for (const hasRelay of [false, true]) {
        for (const suspendable of [false, true]) {
          out.push({
            state,
            suspendable,
            hasPod,
            hasPvc,
            hasRelay,
            leaseExpiresAt: NOW + 60_000,
            suspendedAt: NOW - 1_000,
            createdAt: NOW - 60_000,
            maxLifetimeSeconds: 3_600,
            idlePolicy: suspendable ? { maxIdleSeconds: 60 } : null,
            lastActivityAt: NOW - 1_000,
          });
        }
      }
    }
  }
  return out;
}
