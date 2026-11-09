/**
 * Termination use case: stop the guest, delete pod/PVC, purge relay, finalise,
 * and reap orphan pods.
 */
import { LATENCY_BUCKETS, metrics } from "@x402s/shared";
import { log } from "@x402s/shared";
import type { ReconcilerContext } from "./reconciler-context.js";
import type { TerminationStore } from "./store/ports.js";

type TerminationContext = Omit<ReconcilerContext, "store"> & { store: TerminationStore };
import { RefundService } from "./refunds.js";
import type { SessionRecord } from "./store.js";

export class Termination {
  private readonly refunds: RefundService;

  constructor(private readonly ctx: TerminationContext) {
    this.refunds = new RefundService(ctx.store);
  }

  /** Housekeeping repair for refunds that were interrupted by a crash. */
  reconcileRefunds(): void {
    this.refunds.reconcile();
  }

  async terminate(session: SessionRecord): Promise<void> {
    const cleanupStarted = session.terminatingAt ?? this.ctx.now();
    // Ask the guest to stop so it can kill descendants before the pod goes away.
    try {
      await this.ctx.relay.shutdown(session.id, session.terminationReason ?? "terminated");
    } catch {
      /* relay may already be gone */
    }

    if (session.podName) {
      await this.ctx.provisioner.deletePod(session.podName, 1).catch(() => undefined);
      this.ctx.store.clearPod(session.id);
      this.ctx.capacity.beginRelease(session.id, session.podName);
    } else {
      this.ctx.capacity.beginRelease(session.id, null);
    }
    await this.ctx.snapshotter.discard(session).catch((err) => {
      log.warn("snapshot_discard_failed", { sessionId: session.id, error: (err as Error).message });
    });
    if (session.workspacePvc) {
      await this.ctx.provisioner.deleteWorkspacePvc(session.workspacePvc).catch((err) => {
        log.warn("workspace_pvc_delete_failed", {
          sessionId: session.id,
          pvc: session.workspacePvc,
          error: (err as Error).message,
        });
      });
      this.ctx.store.clearWorkspacePvc(session.id);
    }
    if (session.relayPurgedAt === null) {
      try {
        await this.ctx.relay.purge(session.id);
        this.ctx.store.markRelayPurged(session.id);
      } catch (err) {
        log.warn("relay_purge_failed", { sessionId: session.id, error: (err as Error).message });
      }
    }
    const cleanupMs = Date.now() - cleanupStarted;
    this.ctx.store.mergeTimings(session.id, {
      terminationStartedAt: cleanupStarted,
      podDeletedAt: Date.now(),
      cleanupMs,
    });
    metrics
      .histogram("sandbox_cleanup_duration_seconds", "TERMINATING to cleanup complete", LATENCY_BUCKETS)
      .observe(cleanupMs / 1000);
    const finalState = this.ctx.store.finalizeTermination(session.id);
    if (finalState) {
      try {
        this.refunds.refund(session, finalState);
      } catch (err) {
        log.warn("payment_refund_failed", { sessionId: session.id, error: (err as Error).message });
      }
    }
    if (finalState === "FAILED" || finalState === "EXPIRED") {
      metrics
        .counter("sandbox_sessions_failed_total", "Sessions that ended in FAILED or EXPIRED")
        .inc({ final_state: finalState, reason: (session.terminationReason ?? "unknown").split(":")[0]! });
    }
    log.info("sandbox_destroyed", {
      sessionId: session.id,
      state: finalState ?? "unknown",
      reason: session.terminationReason ?? "unknown",
    });
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
      const session = pod.sessionId ? this.ctx.store.getSession(pod.sessionId) : null;
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
          this.ctx.store.requestTermination(session.id, "failure:reaped", {
            code: "reaped",
            message: "sandbox exceeded the maximum pod age",
          });
        }
      }
    }
  }
}
