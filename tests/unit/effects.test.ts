/**
 * The effect interpreter.
 *
 * Three things are worth pinning here:
 *
 *  - every `SessionEffect` variant is either executed or refused by name, so a
 *    new variant cannot be silently ignored (the switch's `assertNever` is the
 *    compile-time half, this is the runtime half);
 *  - the transition table only emits variants the interpreter inventories, and
 *    `terminationEffects` is exactly what the table returns when it enters
 *    TERMINATING;
 *  - a guarded write that loses the race stops the sequence, so no external
 *    effect runs for a transition that did not happen.
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
} from "../../shared/src/index.js";
import {
  EFFECT_VARIANTS,
  UnwiredEffectError,
  effectContext,
  executeEffect,
  executeEffects,
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
 * The effects no use case executes yet. Provisioning builds the guest token,
 * the pod spec and the workspace volume in one admission path, so splitting
 * them into separate calls would change when a pod starts. Listed here so the
 * set stays deliberate rather than accidental.
 */
const UNWIRED = new Set<SessionEffect["type"]>(["register_relay", "ensure_workspace_pvc", "start_pod"]);

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
      clearPod: () => calls.push("clearPod"),
      clearWorkspacePvc: () => calls.push("clearWorkspacePvc"),
      finalizeTermination: () => {
        calls.push("finalizeTermination");
        return guard ? "DESTROYED" : null;
      },
      markRelayPurged: () => calls.push("markRelayPurged"),
      markSuspended: () => {
        calls.push("markSuspended");
        return guard;
      },
      markSuspending: () => {
        calls.push("markSuspending");
        return guard;
      },
      setReady: () => {
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
  it("executes every variant or refuses it by name", async () => {
    for (const effect of Object.values(EFFECT_VARIANTS)) {
      const { runtime, calls } = recordingRuntime();
      const ctx = effectContext(runtime, session(), { ready: READY });
      if (UNWIRED.has(effect.type)) {
        await expect(executeEffect(effect, ctx), effect.type).rejects.toBeInstanceOf(UnwiredEffectError);
        continue;
      }
      await executeEffect(effect, ctx);
      expect(calls, `${effect.type} reached the world`).not.toHaveLength(0);
    }
  });

  it("names the variant it could not execute", async () => {
    const { runtime } = recordingRuntime();
    const ctx = effectContext(runtime, session());
    await expect(executeEffect({ type: "start_pod", warm: true }, ctx)).rejects.toMatchObject({
      name: "UnwiredEffectError",
      effect: "start_pod",
    });
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

  it("stops at a refused guarded write", async () => {
    const { runtime, calls } = recordingRuntime({ guard: false });
    const applied = await executeEffects(
      [{ type: "persist_suspending" }, { type: "stop_guest", intent: "suspend" }],
      effectContext(runtime, session()),
    );
    expect(applied).toEqual({ ok: false, error: { effect: "persist_suspending", reason: "guard_lost" } });
    expect(calls).toEqual(["markSuspending"]);
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
