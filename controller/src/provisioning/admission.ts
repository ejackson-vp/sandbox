/**
 * What must hold before a pod request is made.
 *
 * Split from the provisioning use case because each of these is a defer-and-
 * retry, not a failure: a relay mid-replacement, no compute reservation, or a
 * workspace volume that has to exist before the pod that mounts it. Keeping
 * them together means the use case reads as the sequence of prerequisites it
 * actually is, and none of them can terminate a paid session except on the
 * configured timeout.
 */
import { LATENCY_BUCKETS, log, metrics } from "@x402s/shared/runtime";
import type { CapacityService } from "../capacity/service.js";
import type { ReservationRecord } from "../capacity/reservation-store.js";
import {
  resolveRuntimeProfile,
  sessionRuntime,
  type ControllerConfig,
  type RuntimeProfile,
} from "../config.js";
import type { Provisioner } from "../k8s.js";
import type { RelayClient } from "../relay-client.js";
import type { SessionRecord } from "../store/models.js";
import type { ProvisioningStore } from "../store/ports.js";

type AdmissionStore = Pick<ProvisioningStore, "mergeTimings" | "requestTermination" | "setWorkspacePvc">;

/** The narrow view of the reconciler that admission is allowed to use. */
export interface AdmissionRuntime {
  readonly cfg: ControllerConfig;
  readonly store: AdmissionStore;
  readonly provisioner: Pick<Provisioner, "createWorkspacePvc" | "workspacePvcExists">;
  readonly relay: Pick<RelayClient, "isReady">;
  readonly capacity: Pick<CapacityService, "attach" | "getReservation">;
  now(): number;
}

export class ProvisioningAdmission {
  constructor(private readonly ctx: AdmissionRuntime) {}

  /**
   * The runtime profile this session asked for, or null after terminating it.
   *
   * Fails closed: an unknown profile terminates the session instead of running
   * it on `base`. The customer asked for a runtime this controller does not
   * run, and silently substituting another image would break the only promise
   * the profile makes. Terminating before READY leaves the payment refundable.
   *
   * This runs before the relay gate and the compute reservation, because a
   * session that can never be provisioned must not hold capacity or a slot.
   */
  runtimeProfile(session: SessionRecord): RuntimeProfile | null {
    const requested = sessionRuntime(session);
    const profile = resolveRuntimeProfile(this.ctx.cfg.runtimeProfiles, requested);
    if (profile) return profile;
    metrics
      .counter("sandbox_runtime_profile_total", "Runtime profile selection outcomes")
      .inc({ result: "unknown" });
    // Bounded: the value comes from a client request.
    log.error("sandbox_runtime_profile_unknown", {
      sessionId: session.id,
      runtime: requested.slice(0, 64),
      configured: Object.keys(this.ctx.cfg.runtimeProfiles).join(","),
    });
    this.ctx.store.requestTermination(session.id, "failure:runtime_profile_unavailable", {
      code: "runtime_profile_unavailable",
      message: `runtime profile ${requested.slice(0, 64)} is not available on this controller`,
    });
    return null;
  }

  /**
   * Admission gate: a paid create must not start while the relay is being
   * replaced. Its registry is in memory, so a pod created now can dial a
   * relay that never accepted the registration and never recover inside the
   * provisioning budget. Holding the session in PAID costs nothing: no pod,
   * no capacity claim, and the next tick re-checks after the relay is ready.
   *
   * False means this pass must stop: the session was either held for another
   * tick or terminated on the timeout.
   */
  async relayReady(session: SessionRecord): Promise<boolean> {
    if (await this.ctx.relay.isReady()) return true;

    const waited = session.paidAt === null ? 0 : this.ctx.now() - session.paidAt;
    if (this.ctx.cfg.provisioningTimeoutMs > 0 && waited > this.ctx.cfg.provisioningTimeoutMs) {
      metrics
        .counter("sandbox_provisioning_relay_gate_total", "Creates held for relay readiness")
        .inc({ result: "timeout" });
      this.ctx.store.requestTermination(session.id, "failure:provisioning_timeout", {
        code: "provisioning_timeout",
        message: "the relay did not become ready in time",
      });
      log.warn("sandbox_relay_not_ready_timeout", { sessionId: session.id, waitedMs: waited });
    } else {
      metrics
        .counter("sandbox_provisioning_relay_gate_total", "Creates held for relay readiness")
        .inc({ result: "wait" });
      log.info("sandbox_relay_not_ready_deferred", { sessionId: session.id, waitedMs: waited });
    }
    return false;
  }

  /**
   * The compute reservation this session already holds, or a fresh one.
   *
   * Null means the pass must stop and retry: the scheduler did not admit the
   * session yet, and no pod may exist without a reservation behind it. The
   * queue wait is recorded once, on the pass that finally admits it.
   */
  async reserve(session: SessionRecord): Promise<ReservationRecord | null> {
    let reservation = this.ctx.capacity.getReservation(session.id);
    if (!reservation) {
      const admission = await this.ctx.capacity.attach(
        session.paymentKey,
        session.id,
        "",
        { limits: session.limits, ...(session.baselineCpuMillis && session.baselineMemoryMib ? {
          baseline: { cpuMillis: session.baselineCpuMillis, memoryMiB: session.baselineMemoryMib },
        } : {}) },
      );
      if (!admission.admitted) {
        metrics.counter("sandbox_capacity_provision_deferred_total", "Paid sessions waiting for capacity").inc({
          reason: admission.reason,
        });
        log.warn("sandbox_capacity_deferred", { sessionId: session.id, reason: admission.reason });
        return null;
      }
      reservation = admission.reservation;
    }
    const queued = session.timingsJson
      ? (JSON.parse(session.timingsJson) as Record<string, unknown>)
      : {};
    if (typeof queued.provisionQueueEnteredAt === "number" && typeof queued.provisionQueueWaitMs !== "number") {
      const waitMs = Math.max(0, this.ctx.now() - queued.provisionQueueEnteredAt);
      metrics
        .histogram("sandbox_provisioning_wait_seconds", "Time spent waiting for a provisioning slot", LATENCY_BUCKETS)
        .observe(waitMs / 1000);
      this.ctx.store.mergeTimings(session.id, { provisionQueueWaitMs: waitMs });
    }
    return reservation;
  }

  /**
   * The workspace volume a suspendable session needs before its pod.
   *
   * A checkpointed session needs its workspace to outlive the pod. It also
   * cannot use a warm pod: volumes are immutable at claim time.
   */
  async workspaceFor(session: SessionRecord): Promise<string | undefined> {
    let workspacePvc = session.workspacePvc ?? undefined;
    if (!workspacePvc) {
      workspacePvc = await this.ctx.provisioner.createWorkspacePvc(session.id, session.limits.diskMiB);
      this.ctx.store.setWorkspacePvc(session.id, workspacePvc);
    } else if (!(await this.ctx.provisioner.workspacePvcExists(workspacePvc).catch(() => false))) {
      // A stale name from a failed attempt; create a fresh PVC rather than
      // leaving the first pod Pending forever.
      workspacePvc = await this.ctx.provisioner.createWorkspacePvc(session.id, session.limits.diskMiB);
      this.ctx.store.setWorkspacePvc(session.id, workspacePvc);
    }
    return workspacePvc;
  }
}
