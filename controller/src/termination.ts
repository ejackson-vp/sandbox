/**
 * Termination use case: stop the guest, delete pod/PVC, purge relay, finalise,
 * reap orphan pods, and delete workspace PVCs that no live session owns.
 *
 * The cleanup and the final write are the transition table's work: the effects
 * of entering TERMINATING are replayed here (the guarded UPDATE that moved the
 * row did so before this pass), and TERMINATING + `terminated` decides the
 * final state. Both go through the effect interpreter.
 */
import { finalStateForReason, terminationEffects, transition } from "@x402s/shared/protocol";
import { LATENCY_BUCKETS, log, metrics } from "@x402s/shared/runtime";
import type { ReconcilerContext } from "./reconciler-context.js";
import type { EffectStore, TerminationStore } from "./store/ports.js";

type TerminationContext = Omit<ReconcilerContext, "store"> & {
  store: TerminationStore & EffectStore;
};
import { RefundService } from "./refunds.js";
import { workspacePvcReapReason } from "./checkpoint-retention.js";
import type { SessionRecord } from "./store/models.js";
import { effectContext, executeEffects, isOk } from "./effects.js";
import { snapshotOf } from "./session-snapshot.js";

export class Termination {
  private readonly refunds: RefundService;

  constructor(private readonly ctx: TerminationContext) {
    this.refunds = new RefundService(ctx.store);
  }

  /** Housekeeping repair for refunds that were interrupted by a crash. */
  reconcileRefunds(): Promise<void> {
    return this.refunds.reconcile();
  }

  async terminate(session: SessionRecord): Promise<void> {
    const cleanupStarted = session.terminatingAt ?? this.ctx.now();
    const snapshot = snapshotOf(session);
    const effects = effectContext(this.ctx, session);
    // Replay the effects of entering TERMINATING. Every step is idempotent, so
    // a crash halfway through is repaired by the next pass.
    await executeEffects(terminationEffects(snapshot), effects);
    await this.ctx.capacity.beginRelease(session.id, session.podName);
    const cleanupMs = Date.now() - cleanupStarted;
    await this.ctx.store.mergeTimings(session.id, {
      terminationStartedAt: cleanupStarted,
      podDeletedAt: Date.now(),
      cleanupMs,
    });
    metrics
      .histogram("sandbox_cleanup_duration_seconds", "TERMINATING to cleanup complete", LATENCY_BUCKETS)
      .observe(cleanupMs / 1000);
    // TERMINATING + terminated is the only transition out. Its `finalize`
    // effect performs the guarded write; the state it names is the state the
    // store writes, both derived from the termination reason.
    const decision = transition(snapshot, {
      type: "terminated",
      final: finalStateForReason(session.terminationReason ?? ""),
    });
    const finalized =
      decision.ok && isOk(await executeEffects(decision.value.effects, effects))
        ? decision.value.state
        : null;
    if (finalized) {
      try {
        await this.refunds.refund(session, finalized);
      } catch (err) {
        log.warn("payment_refund_failed", { sessionId: session.id, error: (err as Error).message });
      }
    }
    if (finalized === "FAILED" || finalized === "EXPIRED") {
      metrics
        .counter("sandbox_sessions_failed_total", "Sessions that ended in FAILED or EXPIRED")
        .inc({ final_state: finalized, reason: (session.terminationReason ?? "unknown").split(":")[0]! });
    }
    log.info("sandbox_destroyed", {
      sessionId: session.id,
      state: finalized ?? "unknown",
      reason: session.terminationReason ?? "unknown",
    });
  }

  /**
   * Delete workspace PVCs that no live session owns.
   *
   * Termination deletes the volume on the normal path; this covers the residues
   * (a terminal session whose cleanup was interrupted, a volume left after a
   * database restore, and an unattributable volume in the workspace pool).
   * Checkpoint volumes are plaintext, so the sweep is the only bound on how long
   * an unowned one survives.
   */
  async sweepPvcs(): Promise<void> {
    let pvcs;
    try {
      pvcs = await this.ctx.provisioner.listWorkspacePvcs();
    } catch {
      return;
    }
    const now = this.ctx.now();
    for (const pvc of pvcs) {
      if (!pvc.name) continue;
      const session = pvc.sessionId ? await this.ctx.store.getSession(pvc.sessionId) : null;
      const reason = workspacePvcReapReason({
        pvc,
        session,
        now,
        orphanGraceMs: this.ctx.cfg.orphanPvcGraceMs,
      });
      if (!reason) continue;
      try {
        await this.ctx.provisioner.deleteWorkspacePvc(pvc.name);
      } catch (err) {
        log.warn("workspace_pvc_reap_failed", {
          pvc: pvc.name,
          sessionId: pvc.sessionId || undefined,
          error: (err as Error).message,
        });
        continue;
      }
      if (session) await this.ctx.store.clearWorkspacePvc(session.id);
      metrics
        .counter(
          "sandbox_workspace_pvcs_reaped_total",
          "Workspace PVCs deleted without a live session",
        )
        .inc({ reason });
      log.warn("workspace_pvc_reaped", {
        pvc: pvc.name,
        sessionId: pvc.sessionId || undefined,
        reason,
      });
    }
  }

  /** Delete pods that no session owns, or that outlived every possible deadline. */

  async sweep(): Promise<void> {
    let pods;
    try {
      pods = await this.ctx.provisioner.listSandboxPods();
    } catch {
      return;
    }
    const now = this.ctx.now();
    for (const pod of pods) {
      const session = pod.sessionId ? await this.ctx.store.getSession(pod.sessionId) : null;
      const terminal =
        !session || ["DESTROYED", "EXPIRED", "FAILED", "TERMINATING"].includes(session.state);
      const tooOld = pod.createdAt > 0 && now - pod.createdAt > this.ctx.cfg.maxPodAgeMs;
      if (terminal || tooOld) {
        let deleted = true;
        try {
          await this.ctx.provisioner.deletePod(pod.name, 0);
        } catch (err) {
          deleted = false;
          log.warn("orphan_pod_delete_failed", {
            podName: pod.name,
            sessionId: pod.sessionId || undefined,
            error: (err as Error).message,
          });
        }
        if (deleted) {
          log.warn("orphan_pod_reaped", {
            podName: pod.name,
            sessionId: pod.sessionId || undefined,
            reason: terminal ? "no_live_session" : "max_age",
          });
        }
        if (session && session.state !== "TERMINATING") {
          await this.ctx.store.requestTermination(session.id, "failure:reaped", {
            code: "reaped",
            message: "sandbox exceeded the maximum pod age",
          });
        }
      }
    }
  }
}
