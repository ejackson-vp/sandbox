/**
 * Lifecycle use cases: suspend, resume, idle/expiry policy, PVC cleanup.
 *
 * Suspend is table-driven: READY/ACTIVE + `suspend_requested` moves the row and
 * stops the guest, SUSPENDING + `guest_stopped` releases the pod and completes
 * the checkpoint. Both effect lists are executed by the effect interpreter.
 */
import {
  canResume,
  idleExpired,
  lifetimeExpired,
  metrics,
  suspendedExpired,
  transition,
} from "@x402s/shared";
import { log } from "@x402s/shared";
import type { ReconcilerContext } from "./reconciler-context.js";
import type { EffectStore, LifecycleStore } from "./store/ports.js";

type LifecycleContext = Omit<ReconcilerContext, "store"> & {
  store: LifecycleStore & EffectStore;
};
import type { SessionRecord } from "./store/models.js";
import { snapshotOf } from "./session-snapshot.js";
import type { Provisioning } from "./provisioning.js";
import { createPath, effectContext, executeEffects, isOk } from "./effects.js";
import type { EffectOutcome, StartPodPlan } from "./effects.js";

export class LifecycleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 409,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LifecycleError";
  }
}

export class Lifecycle {
  constructor(
    private readonly ctx: LifecycleContext,
    private readonly provisioning: Provisioning,
  ) {}

  async enforce(): Promise<void> {
    const now = this.ctx.now();
    for (const session of this.ctx.store.listNonTerminal()) {
      if (this.lifetimeExceeded(session)) {
        this.ctx.store.requestTermination(session.id, "max_lifetime");
        continue;
      }
      const snap = snapshotOf(session);
      if (idleExpired(snap, now)) {
        try {
          await this.suspend(session.id);
        } catch (err) {
          log.warn("auto_suspend_failed", { sessionId: session.id, error: (err as Error).message });
        }
        continue;
      }
      if (suspendedExpired(snap, now)) {
        this.ctx.store.requestTermination(session.id, "suspended_expired");
      }
    }
  }

  async cleanup(): Promise<void> {
    for (const session of this.ctx.store.listTerminalWithPvc()) {
      if (!session.workspacePvc) continue;
      await this.ctx.provisioner.deleteWorkspacePvc(session.workspacePvc).catch(() => undefined);
      this.ctx.store.clearWorkspacePvc(session.id);
    }
  }


  private lifetimeExceeded(session: SessionRecord): boolean {
    return lifetimeExpired(snapshotOf(session), this.ctx.now());
  }

  /**
   * Checkpoint a live session: move to SUSPENDING, stop the workload, keep its
   * workspace PVC, and release compute. There is no memory snapshot in this
   * mode; the guest is booted fresh on resume and sees the persisted files.
   */
  async suspend(id: string): Promise<void> {
    const session = this.ctx.store.getSession(id);
    if (!session) throw new LifecycleError("not_found", "session not found", 404);
    const decision = transition(snapshotOf(session), { type: "suspend_requested" });
    if (!decision.ok) {
      // Same refusal the store's guarded UPDATE gives for the same state.
      throw new LifecycleError("not_suspendable", `session is ${session.state}`, 409);
    }
    // persist_suspending runs first: losing that race must not stop the guest.
    // A deferred outcome (no producer yet) aborts here too: same retry next pass.
    const applied = await executeEffects(decision.value.effects, effectContext(this.ctx, session));
    if (!isOk(applied)) {
      throw new LifecycleError("not_suspendable", "session changed state while suspending", 409);
    }
    await this.finishSuspend(this.ctx.store.getSession(id) ?? session);
  }

  /**
   * Reconcile a row already in SUSPENDING: replay the stop_guest of the entry
   * transition (a crash may have happened before it ran), then complete.
   *
   * The replay is a table decision like any other, so the effect list has one
   * definition. A refusal means the row moved on under us (a destroy, a lease
   * expiry); `finishSuspend` is what reports that, exactly as it did before the
   * replay was table-driven.
   */
  async reconcileSuspend(session: SessionRecord): Promise<void> {
    const decision = transition(snapshotOf(session), { type: "suspend_retry" });
    if (decision.ok) {
      await executeEffects(decision.value.effects, effectContext(this.ctx, session));
    }
    await this.finishSuspend(session);
  }

  /**
   * Complete a SUSPENDING transition. Idempotent so a controller crash between
   * markSuspending and markSuspended is repaired by the next reconcile tick.
   */
  async finishSuspend(session: SessionRecord): Promise<void> {
    if (session.state === "SUSPENDED") return;
    if (session.state !== "SUSPENDING") {
      throw new LifecycleError("not_suspendable", `session is ${session.state}`, 409);
    }
    const id = session.id;
    await this.ctx.snapshotter.capture(session);
    if (session.podName && !session.nodeName && session.workspacePvc) {
      const pod = await this.ctx.provisioner.getPod(session.podName).catch(() => null);
      if (pod?.nodeName) {
        this.ctx.store.setNodeName(id, pod.nodeName);
        session.nodeName = pod.nodeName;
      }
    }
    const decision = transition(snapshotOf(session), { type: "guest_stopped" });
    if (!decision.ok) {
      throw new LifecycleError("not_suspendable", `session is ${session.state}`, 409);
    }
    const applied = await executeEffects(decision.value.effects, effectContext(this.ctx, session));
    if (!isOk(applied)) {
      if (this.ctx.store.getSession(id)?.state === "SUSPENDED") return;
      throw new LifecycleError("not_suspendable", "session changed state while suspending", 409);
    }
    this.ctx.capacity.suspend(id);
    metrics.counter("sandbox_sessions_suspended_total", "Sessions suspended").inc();
    log.info("sandbox_suspended", {
      sessionId: id,
      suspendedAt: this.ctx.store.getSession(id)?.suspendedAt,
    });
  }

  /** Boot a fresh guest against the persisted workspace. */
  async resume(id: string): Promise<void> {
    const session = this.ctx.store.getSession(id);
    if (!session) throw new LifecycleError("not_found", "session not found", 404);
    if (session.state !== "SUSPENDED" || !canResume(snapshotOf(session))) {
      throw new LifecycleError("not_suspended", `session is ${session.state}`, 409);
    }
    if (this.lifetimeExceeded(session)) {
      this.ctx.store.requestTermination(id, "max_lifetime");
      throw new LifecycleError("max_lifetime", "session exceeded its maximum lifetime", 409);
    }
    const idle = session.idlePolicyJson
      ? (JSON.parse(session.idlePolicyJson) as { suspendedDurationSeconds?: number })
      : {};
    if (
      idle.suspendedDurationSeconds &&
      session.suspendedAt &&
      this.ctx.now() - session.suspendedAt > idle.suspendedDurationSeconds * 1000
    ) {
      this.ctx.store.requestTermination(id, "suspended_expired");
      throw new LifecycleError("suspended_expired", "session was suspended for too long", 409);
    }
    if (!session.workspacePvc) {
      throw new LifecycleError("not_resumable", "session has no persistent workspace", 409);
    }
    if (!(await this.ctx.provisioner.workspacePvcExists(session.workspacePvc).catch(() => false))) {
      this.ctx.store.requestTermination(id, "failure:checkpoint_missing", {
        code: "checkpoint_missing",
        message: "the checkpoint workspace no longer exists",
      });
      throw new LifecycleError(
        "resume_unavailable",
        "the checkpoint workspace no longer exists; the session cannot be resumed",
        409,
      );
    }
    if (this.ctx.cfg.pinCheckpointNode && session.nodeName) {
      const available = await this.ctx.provisioner.nodeAvailable(session.nodeName).catch(() => false);
      if (!available) {
        throw new LifecycleError(
          "resume_unavailable",
          `the checkpoint's node ${session.nodeName} is unavailable; it cannot be resumed on another node`,
          409,
        );
      }
    }
    // Above one replica these are the session shard's ready pod IPs, not pod
    // names: the guest has no DNS. A shard with no ready endpoint leaves this
    // null and the resume fails rather than creating an unreachable pod.
    const { relay: relayAddr, proxy: proxyAddr } = await this.provisioning.endpointsFor(id);
    if (!relayAddr || !proxyAddr) {
      throw new LifecycleError("control_plane_unavailable", "relay or proxy unavailable", 503);
    }
    const admission = await this.ctx.capacity.resume(session);
    if (!admission.admitted) {
      throw new LifecycleError(
        "capacity_unavailable",
        `cannot resume: ${admission.reason}`,
        409,
        {
          retryable: admission.retryable,
          requested: admission.requested,
        },
      );
    }
    // SUSPENDED + resume_requested is the table's decision: register the guest
    // credential, then boot a cold pod against the checkpointed workspace. Its
    // guarded write moves the row to RESUMING only once that pod exists.
    const plan: StartPodPlan = {
      relay: relayAddr,
      proxy: proxyAddr,
      resume: true,
      ...(this.ctx.cfg.pinCheckpointNode && session.nodeName ? { nodeName: session.nodeName } : {}),
    };
    let outcome: EffectOutcome;
    try {
      await this.ctx.snapshotter.restore(session);
      const decision = transition(snapshotOf(session), { type: "resume_requested" });
      if (!decision.ok) {
        throw new LifecycleError("not_suspended", "session changed state while resuming", 409);
      }
      outcome = await executeEffects(
        decision.value.effects,
        effectContext(this.ctx, session, { create: createPath(this.provisioning, plan) }),
      );
    } catch (err) {
      // The compute reservation is no longer usable; return it before the
      // caller retries. The workspace stays SUSPENDED.
      this.ctx.capacity.suspend(id);
      throw err;
    }
    if (!isOk(outcome)) {
      // The guarded write refused, so the pod was already rolled back inside
      // the effect: the caller retries from SUSPENDED.
      throw new LifecycleError("not_suspended", "session changed state while resuming", 409);
    }
  }
}
