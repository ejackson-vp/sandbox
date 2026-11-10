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
 *  - A `deferred` outcome means not now, try again next pass: admission and
 *    endpoint resolution are neither done nor failed, so they need a third
 *    answer. It stops the list exactly like a refusal.
 *  - External failures follow the call they replace: a lost pod delete during
 *    termination is logged and cleanup continues, a lost pod suspend aborts so
 *    the suspend is retried, a failed checkpoint discard is logged.
 */
import { assertNever, log, type SessionEffect } from "@x402s/shared";
import type { Provisioner } from "./k8s.js";
import type { RelayClient } from "./relay-client.js";
import type { Snapshotter } from "./snapshotter.js";
import type { SessionRecord } from "./store/models.js";
import type { EffectStore } from "./store/ports.js";

/** Values the readiness handshake contributes to `persist_ready`. */
export interface ReadyHandshake {
  readyAt: number;
  leaseExpiresAt: number;
  attestationJson: string;
  guestPublicKey: string;
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

export interface EffectContext extends EffectRuntime {
  /** The row the effects act on: pod name, workspace PVC and reason live here. */
  readonly session: SessionRecord;
  /** Supplied by the readiness path; `persist_ready` cannot run without it. */
  readonly ready?: ReadyHandshake;
}

export function effectContext(
  runtime: EffectRuntime,
  session: SessionRecord,
  extra: { ready?: ReadyHandshake } = {},
): EffectContext {
  return { ...runtime, session, ...(extra.ready ? { ready: extra.ready } : {}) };
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
 * An effect the table can emit but no use case executes yet. Thrown rather than
 * silently ignored: the alternative is a session that looks handled.
 */
export class UnwiredEffectError extends Error {
  constructor(
    readonly effect: SessionEffect["type"],
    reason: string,
  ) {
    super(`${effect} is not wired: ${reason}`);
    this.name = "UnwiredEffectError";
  }
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
        throw new UnwiredEffectError(
          "persist_ready",
          "no ready handshake in the effect context (the readiness path supplies one)",
        );
      }
      const { readyAt, leaseExpiresAt, attestationJson, guestPublicKey } = ctx.ready;
      if (!ctx.store.setReady(id, readyAt, leaseExpiresAt, attestationJson, guestPublicKey)) {
        return refused(effect);
      }
      return OK;
    }

    case "persist_suspending":
      if (!ctx.store.markSuspending(id)) return refused(effect);
      return OK;

    case "persist_suspended":
      if (!ctx.store.markSuspended(id, ctx.now())) return refused(effect);
      return OK;

    case "finalize": {
      const final = ctx.store.finalizeTermination(id);
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
      ctx.store.clearPod(id);
      return OK;
    }

    case "purge_relay": {
      try {
        await ctx.relay.purge(id);
        ctx.store.markRelayPurged(id);
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
        ctx.store.clearWorkspacePvc(id);
      } catch (err) {
        log.warn("workspace_pvc_delete_failed", {
          sessionId: id,
          pvc,
          error: (err as Error).message,
        });
      }
      return OK;
    }

    // The provisioning use case owns these. It creates the guest token, the
    // pod spec, the workspace volume and the relay registration together, so
    // they cannot be split into separate effect calls without changing when
    // and how a pod is admitted.
    case "register_relay":
      throw new UnwiredEffectError(
        "register_relay",
        "the guest token is shared with the pod spec that Provisioning.createPod builds",
      );

    case "ensure_workspace_pvc":
      throw new UnwiredEffectError(
        "ensure_workspace_pvc",
        "workspace creation is part of provisioning admission",
      );

    case "start_pod":
      throw new UnwiredEffectError("start_pod", "pod construction lives in the provisioning use case");

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
