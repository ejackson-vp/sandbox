/**
 * The effect interpreter: the one place a `SessionEffect` reaches the world.
 *
 * The transition table is pure, so every use that changes state is a
 * `transition()` decision followed by `executeEffects()`. The switch below is
 * exhaustive over `SessionEffect["type"]` and ends in `assertNever`, so adding
 * a variant to the domain fails `tsc` until it is executed here.
 *
 * Three rules keep the shell honest:
 *
 *  - `persist_*` effects are guarded writes, and the guard is the authority. A
 *    refusal means the row moved on; the remaining effects are skipped and the
 *    next reconcile pass retries. No effect runs after a lost guard.
 *  - A `deferred` outcome means not now, try again next pass: a volume that
 *    cannot be created yet, an endpoint that has not appeared. It stops the list
 *    exactly like a refusal.
 *  - External failures follow the call they replace: a lost pod delete during
 *    termination is logged and cleanup continues, a lost pod suspend aborts so
 *    the suspend is retried, a failed checkpoint discard is logged.
 *
 * The create path (`register_relay`, `ensure_workspace_pvc`, `start_pod`) is
 * the one place the interpreter needs more than a session row, because the
 * token registered with the relay is the token the pod boots with and the
 * volume has to exist before the pod that mounts it. `CreatePath` is that
 * dependency, implemented by the provisioning use case, so the machinery stays
 * where the pod spec and the guarded writes live and this file stays a
 * dispatcher.
 */
import { assertNever, type SessionEffect } from "@x402s/shared/protocol";
import { log } from "@x402s/shared/runtime";
import type { Provisioner } from "./k8s.js";
import type { RelayClient } from "./relay-client.js";
import type { Snapshotter } from "./snapshotter.js";
import type { SessionRecord } from "./store/models.js";
import type { EffectStore } from "./store/ports.js";
import type { Endpoint, RelayRegistration } from "./provisioning/endpoints.js";

/** Values the readiness handshake contributes to `persist_ready`. */
interface ReadyHandshake {
  readyAt: number;
  leaseExpiresAt: number;
  attestationJson: string;
  guestPublicKey: string;
}

/**
 * What `start_pod` needs that the table cannot know: the addresses admission
 * resolved and the placement the capacity reservation asked for.
 *
 * The table decides *whether* a pod starts and whether it may be a warm claim;
 * the shell decides *where*, because that answer depends on the cluster this
 * controller is talking to and must be resolved before the transition (an
 * unavailable endpoint is a defer, not a failed session).
 */
export interface StartPodPlan {
  readonly relay: Endpoint;
  readonly proxy: Endpoint;
  /** Node the compute reservation pinned; absent when placement is free. */
  readonly nodeName?: string;
  /** Boot against the checkpointed workspace instead of a fresh one. */
  readonly resume?: boolean;
  /** When this pass began; the warm claim records it in the session timings. */
  readonly provisionBeginAt?: number;
}

/** One `start_pod`: the plan, the table's warm decision, the staged volume. */
export interface StartPodRequest extends StartPodPlan {
  readonly warm: boolean;
  /** Volume `ensure_workspace_pvc` staged for this create, when it made one. */
  readonly workspacePvc?: string;
}

/**
 * The provisioning machinery the three create-path effects delegate to.
 *
 * Declared here and implemented by the provisioning use case, so the arrow
 * points interpreter -> use case: an effect cannot reach Kubernetes without a
 * caller that has already admitted the session and can name its endpoints. The
 * implementations live where the pod spec, the claim and the guarded writes
 * live, not in this switch.
 */
export interface CreatePath {
  /** Register the credential a create presents; `start_pod` boots with it. */
  registerRelay(session: SessionRecord): Promise<RelayRegistration>;
  /**
   * The workspace volume a suspendable session needs before its pod, or
   * undefined when it cannot be provisioned this pass.
   */
  ensureWorkspace(session: SessionRecord): Promise<string | undefined>;
  /**
   * Claim a warm pod or create a cold one, then perform the guarded write that
   * names it. False means that write lost the race, so nothing after it may run.
   */
  startPod(
    session: SessionRecord,
    registration: RelayRegistration,
    request: StartPodRequest,
  ): Promise<boolean>;
}

/**
 * The create path for one transition: the machinery, what admission decided,
 * and the values `register_relay` and `ensure_workspace_pvc` stage for the
 * `start_pod` that follows them in the same list.
 *
 * The staged fields are the only mutable state in the interpreter. They exist
 * because the table splits one admission into three effects: the token
 * registered with the relay is the token the guest boots with, and the volume
 * has to exist before the pod that mounts it.
 */
interface CreatePathContext {
  readonly path: CreatePath;
  readonly plan: StartPodPlan;
  /** Credential `register_relay` staged for the create that follows. */
  staged?: RelayRegistration;
  /** Workspace volume `ensure_workspace_pvc` staged for that same create. */
  workspacePvc?: string;
}

export function createPath(path: CreatePath, plan: StartPodPlan): CreatePathContext {
  return { path, plan };
}

/**
 * What the interpreter may touch. Deliberately narrower than the reconciler
 * context: no policy, no config, no service discovery.
 */
export interface EffectRuntime {
  readonly store: EffectStore;
  readonly relay: Pick<RelayClient, "shutdown" | "purge">;
  readonly provisioner: Pick<Provisioner, "deletePod" | "suspendPod" | "deleteWorkspacePvc">;
  readonly snapshotter: Pick<Snapshotter, "discard">;
  now(): number;
}

interface EffectContext extends EffectRuntime {
  /** The row the effects act on: pod name, workspace PVC and reason live here. */
  readonly session: SessionRecord;
  /** Supplied by the readiness path; `persist_ready` cannot run without it. */
  readonly ready?: ReadyHandshake;
  /** Supplied by the create paths; the three provisioning effects need it. */
  readonly create?: CreatePathContext;
}

export function effectContext(
  runtime: EffectRuntime,
  session: SessionRecord,
  extra: { ready?: ReadyHandshake; create?: CreatePathContext } = {},
): EffectContext {
  return {
    ...runtime,
    session,
    ...(extra.ready ? { ready: extra.ready } : {}),
    ...(extra.create ? { create: extra.create } : {}),
  };
}

/**
 * What one pass of effects achieved.
 *
 *  - `ok`: every effect ran.
 *  - `refused`: a guarded write lost the race, so the transition did not happen
 *    and the row moved on without us.
 *  - `deferred`: a precondition is not ready yet (admission, endpoint
 *    resolution). Nothing is decided; the next pass tries again.
 *
 * The caller stops the remaining effects on either of the last two.
 */
export type EffectOutcome =
  | { readonly status: "ok" }
  | {
      readonly status: "refused";
      readonly effect: SessionEffect["type"];
      readonly reason: "guard_lost";
    }
  | {
      readonly status: "deferred";
      readonly effect: SessionEffect["type"];
      readonly reason: "not_ready";
    };

/** Every effect in the list ran. */
export const OK: EffectOutcome = { status: "ok" };

/** The guarded write refused: the row is no longer in the source state. */
export function refused(effect: SessionEffect): EffectOutcome {
  return { status: "refused", effect: effect.type, reason: "guard_lost" };
}

/** Try again next pass: a precondition is not ready. */
export function deferred(effect: SessionEffect): EffectOutcome {
  return { status: "deferred", effect: effect.type, reason: "not_ready" };
}

/**
 * The only stop condition the interpreter has. Written as a switch so a fourth
 * outcome is a `tsc` error rather than a silently non-`ok` value that some
 * caller treats as success.
 */
export function isOk(outcome: EffectOutcome): outcome is Extract<EffectOutcome, { status: "ok" }> {
  switch (outcome.status) {
    case "ok":
      return true;
    case "refused":
    case "deferred":
      return false;
    default:
      return assertNever(outcome, "EffectOutcome");
  }
}

/**
 * An effect the context cannot satisfy. Thrown rather than silently skipped:
 * the alternative is a session that looks handled. It is never an excuse for an
 * unimplemented variant, only for a caller that did not supply what the effect
 * acts on (a readiness handshake, a create path).
 */
export class EffectContextError extends Error {
  constructor(
    readonly effect: SessionEffect["type"],
    reason: string,
  ) {
    super(`${effect} cannot run: ${reason}`);
    this.name = "EffectContextError";
  }
}

/** The create path an effect needs, or a loud failure naming the effect. */
function requireCreate(ctx: EffectContext, effect: SessionEffect): CreatePathContext {
  if (!ctx.create) {
    throw new EffectContextError(
      effect.type,
      "the caller must supply a create path (only the provision and resume use cases start pods)",
    );
  }
  return ctx.create;
}

/**
 * Execute a transition's effects in table order.
 *
 * Stops at the first outcome that is not `ok` and returns it; the caller maps
 * that to the error it already returned for the same race (the store's guarded
 * UPDATE would have refused identically) or retries on the next pass.
 */
export async function executeEffects(
  effects: readonly SessionEffect[],
  ctx: EffectContext,
): Promise<EffectOutcome> {
  for (const effect of effects) {
    const outcome = await executeEffect(effect, ctx);
    if (!isOk(outcome)) return outcome;
  }
  return OK;
}

export async function executeEffect(
  effect: SessionEffect,
  ctx: EffectContext,
): Promise<EffectOutcome> {
  const id = ctx.session.id;
  switch (effect.type) {
    case "persist_ready": {
      if (!ctx.ready) {
        throw new EffectContextError(
          "persist_ready",
          "no ready handshake in the effect context (the readiness path supplies one)",
        );
      }
      const { readyAt, leaseExpiresAt, attestationJson, guestPublicKey } = ctx.ready;
      if (!(await ctx.store.setReady(id, readyAt, leaseExpiresAt, attestationJson, guestPublicKey))) {
        return refused(effect);
      }
      return OK;
    }

    case "persist_suspending":
      if (!(await ctx.store.markSuspending(id))) return refused(effect);
      return OK;

    case "persist_suspended":
      if (!(await ctx.store.markSuspended(id, ctx.now()))) return refused(effect);
      return OK;

    case "finalize": {
      const final = await ctx.store.finalizeTermination(id);
      if (!final) return refused(effect);
      // Both sides derive the state from the termination reason; a mismatch
      // means one of them moved, and the written value is the truth.
      if (final !== effect.final) {
        log.warn("session_finalize_mismatch", {
          sessionId: id,
          expected: effect.final,
          actual: final,
        });
      }
      return OK;
    }

    case "stop_guest": {
      const reason =
        effect.intent === "suspend" ? "suspend" : (ctx.session.terminationReason ?? "terminated");
      try {
        await ctx.relay.shutdown(id, reason);
      } catch {
        /* the relay entry may already be gone; pod deletion is the backstop */
      }
      return OK;
    }

    case "delete_pod": {
      const podName = ctx.session.podName;
      if (!podName) return OK;
      if (effect.intent === "suspend") {
        // Wait for the pod to disappear: resume reuses the deterministic name,
        // and a still-terminating pod would make the create conflict.
        await ctx.provisioner.suspendPod(podName);
      } else {
        try {
          await ctx.provisioner.deletePod(podName, 1);
        } catch (err) {
          log.warn("sandbox_pod_delete_failed", {
            sessionId: id,
            podName,
            error: (err as Error).message,
          });
        }
      }
      await ctx.store.clearPod(id);
      return OK;
    }

    case "purge_relay": {
      try {
        await ctx.relay.purge(id);
        await ctx.store.markRelayPurged(id);
      } catch (err) {
        log.warn("relay_purge_failed", { sessionId: id, error: (err as Error).message });
      }
      return OK;
    }

    case "discard_checkpoint": {
      try {
        await ctx.snapshotter.discard(ctx.session);
      } catch (err) {
        log.warn("snapshot_discard_failed", {
          sessionId: id,
          error: (err as Error).message,
        });
      }
      return OK;
    }

    case "delete_workspace_pvc": {
      const pvc = ctx.session.workspacePvc;
      if (!pvc) return OK;
      try {
        await ctx.provisioner.deleteWorkspacePvc(pvc);
        await ctx.store.clearWorkspacePvc(id);
      } catch (err) {
        log.warn("workspace_pvc_delete_failed", {
          sessionId: id,
          pvc,
          error: (err as Error).message,
        });
      }
      return OK;
    }

    // The three create-path effects delegate to the provisioning use case. The
    // table splits one admission into register -> volume -> pod because each
    // step has its own retry and its own failure; the machinery behind them
    // lives in provisioning/, so this switch stays a dispatcher.
    case "register_relay": {
      const create = requireCreate(ctx, effect);
      create.staged = await create.path.registerRelay(ctx.session);
      return OK;
    }

    case "ensure_workspace_pvc": {
      const create = requireCreate(ctx, effect);
      const pvc = await create.path.ensureWorkspace(ctx.session);
      // No volume, no pod: the session stays where it is and the next pass
      // asks again. Nothing has been created that would need undoing.
      if (!pvc) return deferred(effect);
      create.workspacePvc = pvc;
      return OK;
    }

    case "start_pod": {
      const create = requireCreate(ctx, effect);
      if (!create.staged) {
        throw new EffectContextError(
          "start_pod",
          "no relay registration in the effect context (register_relay must run first)",
        );
      }
      const started = await create.path.startPod(ctx.session, create.staged, {
        ...create.plan,
        warm: effect.warm,
        ...(create.workspacePvc ? { workspacePvc: create.workspacePvc } : {}),
      });
      // False is the guarded write having lost the race: the row moved on, so
      // the row is not PROVISIONING/RESUMING and nothing else may run.
      if (!started) return refused(effect);
      return OK;
    }

    default:
      return assertNever(effect, "SessionEffect");
  }
}

/**
 * One exemplar per effect variant.
 *
 * The key type is the union's discriminant, so a new `SessionEffect` fails
 * `tsc` here as well as in the switch. The exhaustiveness test drives every
 * entry through `executeEffect`, which covers the variants the transition table
 * does not emit today.
 */
export const EFFECT_VARIANTS: {
  readonly [K in SessionEffect["type"]]: Extract<SessionEffect, { type: K }>;
} = {
  register_relay: { type: "register_relay" },
  purge_relay: { type: "purge_relay" },
  ensure_workspace_pvc: { type: "ensure_workspace_pvc" },
  start_pod: { type: "start_pod", warm: false },
  stop_guest: { type: "stop_guest", intent: "terminate" },
  delete_pod: { type: "delete_pod", intent: "terminate" },
  discard_checkpoint: { type: "discard_checkpoint" },
  delete_workspace_pvc: { type: "delete_workspace_pvc" },
  persist_ready: { type: "persist_ready" },
  persist_suspending: { type: "persist_suspending" },
  persist_suspended: { type: "persist_suspended" },
  finalize: { type: "finalize", final: "DESTROYED" },
};
