/**
 * What Kubernetes reports about a provisioning pod, reconciled into the row.
 *
 * Extracted from the readiness handshake because it is a separate concern: the
 * handshake decides whether the guest is ready, this decides whether placement,
 * the workspace node pin and the pod phase agree with what the controller
 * recorded. It runs on every readiness pass, before and after READY.
 */
import { log, metrics } from "@x402s/shared/runtime";
import type { CapacityService } from "../capacity/service.js";
import type { Provisioner } from "../k8s.js";
import type { SessionRecord } from "../store/models.js";
import type { ProvisioningStore } from "../store/ports.js";

type PodStatusStore = Pick<ProvisioningStore, "mergeTimings" | "requestTermination" | "setNodeName">;

/** The narrow view of the reconciler that pod observation is allowed to use. */
export interface PodStatusRuntime {
  readonly store: PodStatusStore;
  readonly provisioner: Pick<Provisioner, "getPod">;
  readonly capacity: Pick<CapacityService, "getReservation" | "pinSessionNode">;
  now(): number;
}

export class PodStatus {
  constructor(private readonly ctx: PodStatusRuntime) {}

  /** A session with no pod name has nothing to observe. */
  async reconcile(session: SessionRecord): Promise<void> {
    if (!session.podName) return;
    const pod = await this.ctx.provisioner.getPod(session.podName).catch(() => null);
    if (pod?.nodeName) {
      const reservation = this.ctx.capacity.getReservation(session.id);
      if (reservation && reservation.nodeId !== pod.nodeName && reservation.nodeId !== "disabled") {
        this.ctx.capacity.pinSessionNode(session.id, pod.nodeName);
        metrics.counter("sandbox_capacity_placement_reconciled_total", "Placement intents reconciled with Kubernetes").inc();
        log.warn("sandbox_placement_reconciled", {
          sessionId: session.id,
          intended: reservation.nodeId,
          actual: pod.nodeName,
        });
      }
      if (session.workspacePvc && !session.nodeName) {
        this.ctx.store.setNodeName(session.id, pod.nodeName);
        session.nodeName = pod.nodeName;
      }
    }
    if (pod && pod.phase === "Running") {
      // Record the first observation of a running container (tick resolution).
      const timings = session.timingsJson ? (JSON.parse(session.timingsJson) as Record<string, unknown>) : {};
      if (!timings.podRunningObservedAt && timings.warmPoolHit !== 1) {
        this.ctx.store.mergeTimings(session.id, { podRunningObservedAt: this.ctx.now() });
      }
    }
    if (pod && (pod.phase === "Failed" || pod.phase === "Succeeded")) {
      this.ctx.store.requestTermination(session.id, "failure:pod_terminated", {
        code: "pod_terminated",
        message: `pod reached phase ${pod.phase}`,
      });
    }
  }
}
