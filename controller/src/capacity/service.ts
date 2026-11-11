/**
 * Capacity service: builds an immutable snapshot from Kubernetes + SQLite,
 * delegates the decision to the pure model, and persists the reservation.
 */
import { LATENCY_BUCKETS, metrics } from "@x402s/shared/runtime";
import type { ControllerConfig } from "../config.js";
import type { Provisioner } from "../k8s.js";
import type { SessionRecord } from "../store/models.js";
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

export interface CapacityDeps {
  cfg: ControllerConfig;
  store: CapacityStore;
  provisioner: Provisioner;
  /** Override the reservation store port; defaults to Store's SQLite adapter. */
  reservations?: ReservationStore;
}

export interface CapacityView {
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

  private publishGauges(snapshot: CapacitySnapshot): void {
    let reserved = ZERO_RESOURCES;
    for (const reservation of snapshot.reservations) {
      if (reservation.state === "RELEASED") continue;
      reserved = addResources(reserved, accountedResources(reservation, snapshot.accounting));
    }
    const eligible = new Set(
      placementCandidates(snapshot, {
        baseline: { cpuMillicores: 1, memoryBytes: 1, storageBytes: 1 },
        peak: { cpuMillicores: 1, memoryBytes: 1, storageBytes: 1 },
      }).map((candidate) => candidate.node.id),
    );
    let available = ZERO_RESOURCES;
    for (const node of snapshot.nodes) {
      if (!eligible.has(node.id)) continue;
      available = addResources(available, availableOnNode(node, snapshot.reservations, snapshot.now, snapshot.accounting));
    }
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

  async reap(): Promise<void> {
    const now = Date.now();
    const expired = await this.reservations.reapExpiredHolds(now);
    if (expired > 0) {
      metrics.counter("sandbox_reservation_recovery_total", "Reservations recovered or expired").inc({ kind: "expired_hold" }, expired);
    }
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
      if (["EXPIRED", "FAILED", "DESTROYED"].includes(session.state) && reservation.state !== "RELEASING") {
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
    const reserved = reservations.reduce((sum, reservation) => {
      if (reservation.state === "RELEASED") return sum;
      return addResources(sum, accountedResources(reservation, snapshot.accounting));
    }, ZERO_RESOURCES);
    const eligibleIds = new Set(
      placementCandidates(snapshot, {
        baseline: { cpuMillicores: 1, memoryBytes: 1, storageBytes: 1 },
        peak: { cpuMillicores: 1, memoryBytes: 1, storageBytes: 1 },
      }).map((candidate) => candidate.node.id),
    );
    let available = ZERO_RESOURCES;
    for (const node of snapshot.nodes) {
      if (!eligibleIds.has(node.id)) continue;
      available = addResources(available, availableOnNode(node, reservations, snapshot.now, snapshot.accounting));
    }
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
