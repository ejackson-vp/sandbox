/**
 * Capacity service: builds an immutable snapshot from Kubernetes and the
 * reservation rows, delegates the decision to the pure model, and persists the
 * reservation.
 */
import { LATENCY_BUCKETS, metrics } from "@x402s/shared/runtime";
import { isTerminal } from "@x402s/shared/protocol";
import type { ControllerConfig } from "../config.js";
import type { Provisioner } from "../k8s.js";
import type { SessionRecord } from "../store/models/session.js";
import type { CapacityStore } from "../store/ports.js";
import { admitCapacity } from "./admission.js";
import { availableOnNode, placementCandidates } from "./placement.js";
import type {
  AdmissionDecision,
  CapacitySnapshot,
  ReservationState,
  ResourceVector,
} from "./types.js";
import { accountedResources, addResources, requestForLimits, requestForSession, ZERO_RESOURCES } from "./types.js";
import { CapacitySnapshotBuilder } from "./snapshot.js";
import type { ReservationAdmission, ReservationRecord, ReservationStore } from "./reservation-store.js";

interface CapacityDeps {
  cfg: ControllerConfig;
  store: CapacityStore;
  provisioner: Provisioner;
  /** Override the reservation store port; defaults to the store's own adapter. */
  reservations?: ReservationStore;
}

interface CapacityView {
  accounting: "baseline" | "peak";
  nodes: Array<{
    id: string;
    allocatable: ResourceVector;
    platformOverhead: ResourceVector;
    reserved: ResourceVector;
    available: ResourceVector;
    eligible: boolean;
  }>;
  reservations: {
    total: number;
    held: number;
    allocated: number;
    suspended: number;
    releasing: number;
  };
  reserved: ResourceVector;
  available: ResourceVector;
}

/** The smallest request the placement model can place; see `totals`. */
const ANY_REQUEST = {
  baseline: { cpuMillicores: 1, memoryBytes: 1, storageBytes: 1 },
  peak: { cpuMillicores: 1, memoryBytes: 1, storageBytes: 1 },
};

export class CapacityService {
  private readonly builder: CapacitySnapshotBuilder;
  private readonly reservations: ReservationStore;

  constructor(private readonly deps: CapacityDeps) {
    this.reservations = deps.reservations ?? deps.store.reservations;
    this.builder = new CapacitySnapshotBuilder(deps.cfg, this.reservations, deps.provisioner);
  }

  private observe(
    decision: { admitted: boolean; reason?: string; retryable?: boolean },
    durationMs: number,
  ): void {
    metrics
      .histogram("sandbox_admission_duration_seconds", "Admission decision latency", LATENCY_BUCKETS)
      .observe(durationMs / 1000);
    metrics
      .counter("sandbox_admission_total", "Capacity admission decisions")
      .inc({
        result: decision.admitted ? "admitted" : "rejected",
        reason: decision.admitted ? "ok" : (decision.reason ?? "unknown"),
      });
    if (!decision.admitted) {
      metrics
        .counter("sandbox_admission_rejections_total", "Capacity rejections by reason")
        .inc({ reason: decision.reason ?? "unknown", retryable: String(decision.retryable) });
    }
  }

  /**
   * The cluster totals both the scrape and the operator summary publish.
   *
   * One computation, because a gauge and `/capacity` disagreeing about the same
   * cluster is worse than either being wrong: an operator sizes against the
   * summary while an alert fires on the gauge.
   *
   * `ANY_REQUEST` is the smallest request the model can place. Asking it which
   * nodes would accept anything is how "eligible" is defined without inventing
   * a second definition of eligibility beside the placement model.
   */
  private totals(snapshot: CapacitySnapshot): {
    reserved: ResourceVector;
    available: ResourceVector;
    eligible: ReadonlySet<string>;
  } {
    let reserved = ZERO_RESOURCES;
    for (const reservation of snapshot.reservations) {
      if (reservation.state === "RELEASED") continue;
      reserved = addResources(reserved, accountedResources(reservation, snapshot.accounting));
    }
    const eligible = new Set(
      placementCandidates(snapshot, ANY_REQUEST).map((candidate) => candidate.node.id),
    );
    let available = ZERO_RESOURCES;
    for (const node of snapshot.nodes) {
      if (!eligible.has(node.id)) continue;
      available = addResources(
        available,
        availableOnNode(node, snapshot.reservations, snapshot.now, snapshot.accounting),
      );
    }
    return { reserved, available, eligible };
  }

  private publishGauges(snapshot: CapacitySnapshot): void {
    const { reserved, available } = this.totals(snapshot);
    metrics.gauge("sandbox_capacity_reserved_cpu_millicores", "Reserved CPU millicores").set({}, reserved.cpuMillicores);
    metrics.gauge("sandbox_capacity_reserved_memory_bytes", "Reserved memory bytes").set({}, reserved.memoryBytes);
    metrics.gauge("sandbox_capacity_available_cpu_millicores", "Available CPU millicores").set({}, available.cpuMillicores);
    metrics.gauge("sandbox_capacity_available_memory_bytes", "Available memory bytes").set({}, available.memoryBytes);
  }

  async preflight(spec: { runtime?: string; limits: { cpuMillis: number; memoryMiB: number; diskMiB: number }; baseline?: { cpuMillis: number; memoryMiB: number } }): Promise<AdmissionDecision> {
    const unavailable = this.runtimeUnavailable(spec);
    if (unavailable) return unavailable;
    const started = Date.now();
    const snapshot = await this.builder.snapshotWithWarm();
    const decision = admitCapacity(snapshot, requestForLimits(spec.limits, spec.baseline));
    this.observe(decision, Date.now() - started);
    this.publishGauges(snapshot);
    return decision;
  }

  async hold(
    paymentKey: string,
    specHash: string,
    spec: { runtime?: string; limits: { cpuMillis: number; memoryMiB: number; diskMiB: number }; baseline?: { cpuMillis: number; memoryMiB: number } },
  ): Promise<ReservationAdmission> {
    const unavailable = this.runtimeUnavailable(spec);
    if (unavailable) return unavailable;
    const started = Date.now();
    const snapshot = await this.builder.snapshotWithWarm();
    const admission = await this.reservations.admit(
      snapshot,
      requestForLimits(spec.limits, spec.baseline),
      { paymentKey, specHash, ttlMs: this.deps.cfg.capacityHoldTtlMs },
    );
    this.observe(admission, Date.now() - started);
    this.publishGauges(snapshot);
    return admission;
  }

  /**
   * A known profile is only runnable when the controller has an image for it.
   * Reject it before a settlement hold is created, not after payment.
   */
  private runtimeUnavailable(spec: {
    runtime?: string;
    limits: { cpuMillis: number; memoryMiB: number; diskMiB: number };
  }): Extract<AdmissionDecision, { admitted: false }> | null {
    const runtime = spec.runtime ?? "base";
    if (this.deps.cfg.runtimeProfiles[runtime]) return null;
    return {
      admitted: false,
      reason: "runtime_profile_unavailable",
      retryable: false,
      requested: requestForLimits(spec.limits, undefined).peak,
    };
  }

  async attach(
    paymentKey: string,
    sessionId: string,
    specHash: string,
    spec: { limits: { cpuMillis: number; memoryMiB: number; diskMiB: number }; baseline?: { cpuMillis: number; memoryMiB: number } },
  ): Promise<ReservationAdmission> {
    const started = Date.now();
    const snapshot = await this.builder.snapshotWithWarm();
    const admission = await this.reservations.attachToSession(
      snapshot,
      requestForLimits(spec.limits, spec.baseline),
      paymentKey,
      sessionId,
      specHash,
    );
    this.observe(admission, Date.now() - started);
    this.publishGauges(snapshot);
    return admission;
  }

  async resume(session: SessionRecord): Promise<ReservationAdmission> {
    const started = Date.now();
    const snapshot = await this.builder.snapshotWithWarm();
    const request = requestForSession(session);
    if (this.deps.cfg.pinCheckpointNode && session.nodeName) {
      request.requiredNodeId = session.nodeName;
    }
    const existing = await this.reservations.getBySession(session.id);
    const admission =
      !existing || existing.state === "RELEASED"
        ? await this.reservations.attachToSession(
            snapshot,
            request,
            session.paymentKey,
            session.id,
            "",
          )
        : await this.reservations.resume(snapshot, request, session.id);
    this.observe(admission, Date.now() - started);
    this.publishGauges(snapshot);
    return admission;
  }

  releasePayment(paymentKey: string): Promise<boolean> {
    return this.reservations.releasePayment(paymentKey);
  }

  suspend(sessionId: string): Promise<boolean> {
    return this.reservations.suspendSession(sessionId);
  }

  /** Reassert compute allocation after a resume that raced the reaper. */
  reassertAllocated(sessionId: string): Promise<boolean> {
    return this.reservations.reassertAllocated(sessionId);
  }

  beginRelease(sessionId: string, podName: string | null): Promise<boolean> {
    if (!podName) return this.reservations.releaseSession(sessionId);
    return this.reservations.beginRelease(sessionId, podName);
  }

  releaseSession(sessionId: string): Promise<boolean> {
    return this.reservations.releaseSession(sessionId);
  }

  getReservation(sessionId: string): Promise<ReservationRecord | null> {
    return this.reservations.getBySession(sessionId);
  }

  updatePod(sessionId: string, podName: string): Promise<void> {
    return this.reservations.updatePod(sessionId, podName);
  }

  pinSessionNode(sessionId: string, nodeId: string): Promise<boolean> {
    return this.reservations.pinNode(sessionId, nodeId);
  }

  /**
   * A stale hold is ordinary; an allocation that never named a session is a
   * create that failed after taking capacity (a duplicate, a lost claim), so the
   * two are counted apart. Neither carries an id or a key.
   */
  private recordReaped(reaped: { holds: number; allocations: number }): void {
    const counter = metrics.counter(
      "sandbox_reservation_recovery_total",
      "Reservations recovered or expired",
    );
    if (reaped.holds > 0) counter.inc({ kind: "expired_hold" }, reaped.holds);
    if (reaped.allocations > 0) counter.inc({ kind: "expired_allocation" }, reaped.allocations);
  }

  async reap(): Promise<void> {
    const now = Date.now();
    this.recordReaped(await this.reservations.reapExpired(now));
    // Each iteration now awaits, so a reservation can move between the read of
    // the snapshot and the write below. The write is still the model's answer
    // for the state it saw, and the one case that matters is already covered:
    // a resume that this loop re-suspends is reasserted by the resume path
    // (`Provisioning.startResumePod` calls `reassertAllocated` after its guarded
    // write, precisely because the reaper can win this race).
    for (const reservation of await this.reservations.listActive()) {
      if (!reservation.sessionId) continue;
      const session = await this.deps.store.getSession(reservation.sessionId);
      if (!session) continue;
      if (isTerminal(session.state) && reservation.state !== "RELEASING") {
        if (reservation.podName) {
          await this.reservations.beginRelease(reservation.sessionId, reservation.podName);
        } else {
          await this.reservations.releaseSession(reservation.sessionId);
        }
        metrics.counter("sandbox_reservation_recovery_total", "Reservations recovered or expired").inc({ kind: "terminal_session" });
      } else if (session.state === "SUSPENDED" && reservation.state === "ALLOCATED") {
        await this.reservations.suspendSession(reservation.sessionId);
        metrics.counter("sandbox_reservation_recovery_total", "Reservations recovered or expired").inc({ kind: "suspended_session" });
      }
    }
    for (const reservation of await this.reservations.listReleasing()) {
      if (!reservation.podName) {
        await this.reservations.confirmRelease(reservation.sessionId ?? "");
        continue;
      }
      const pod = await this.deps.provisioner.getPod(reservation.podName).catch(() => null);
      // Only a missing Pod object confirms release. A Succeeded/Failed Pod
      // still exists until Kubernetes deletes it, so freeing capacity here
      // would hide a persistent deletion failure.
      if (!pod) {
        await this.reservations.confirmRelease(reservation.sessionId ?? "");
        metrics.counter("sandbox_reservation_recovery_total", "Reservations recovered or expired").inc({ kind: "released_pod_gone" });
      } else if (now - reservation.updatedAt > 60_000) {
        metrics.counter("sandbox_reservation_leaks_detected_total", "Reservations stuck in RELEASING").inc();
      }
    }
    this.publishGauges(await this.builder.snapshotWithWarm());
  }

  async summary(): Promise<CapacityView> {
    const snapshot = await this.builder.snapshotWithWarm();
    const reservations = snapshot.reservations;
    const count = (state: ReservationState) => reservations.filter((r) => r.state === state).length;
    const { reserved, available, eligible: eligibleIds } = this.totals(snapshot);
    return {
      accounting: snapshot.accounting,
      nodes: snapshot.nodes.map((node) => ({
        id: node.id,
        allocatable: node.allocatable,
        platformOverhead: node.platformOverhead,
        reserved: reservations
          .filter((r) => r.nodeId === node.id && r.state !== "RELEASED")
          .reduce(
            (sum, r) => addResources(sum, accountedResources(r, snapshot.accounting)),
            ZERO_RESOURCES,
          ),
        available: availableOnNode(node, reservations, snapshot.now, snapshot.accounting),
        eligible: eligibleIds.has(node.id),
      })),
      reservations: {
        total: reservations.length,
        held: count("HELD"),
        allocated: count("ALLOCATED"),
        suspended: count("SUSPENDED"),
        releasing: count("RELEASING"),
      },
      reserved,
      available,
    };
  }
}
