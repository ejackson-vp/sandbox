/**
 * Lease enforcement for a READY/ACTIVE session: pod health, then the deadline.
 *
 * Extracted from the scheduler because it is the one place a Kubernetes
 * observation and a wall-clock reading turn into a state decision. Keeping it
 * out of `reconciler.ts` leaves that file as tick, dispatch and the state
 * switch, which is the boundary the architecture doc asks for: the scheduler
 * lists work and dispatches, this module owns the policy for a live lease.
 *
 * Two rules are load-bearing and stay written down here:
 *
 *  - a failed probe (timeout, 429, connection reset) never terminates a paid
 *    session. Only a successful read reporting the pod missing or terminal
 *    counts, and it must happen twice in a row.
 *  - expiry is decided by the controller's clock, never by the guest. The
 *    deadline is immutable once READY; the grace is the only slack.
 */
import { log } from "@x402s/shared/runtime";
import type { Provisioner } from "../k8s.js";
import type { RelayRecovery } from "../relay-recovery.js";
import type { SessionRecord } from "../store/models.js";
import type { ReconcilerStore } from "../store/ports.js";

/** The narrow view of the shell that lease enforcement is allowed to use. */
interface LeaseRuntime {
  readonly store: Pick<ReconcilerStore, "requestTermination">;
  readonly provisioner: Pick<Provisioner, "getPod">;
  readonly relayRecovery: Pick<RelayRecovery, "awaitingReconnect">;
  /** Slack past the immutable deadline before the lease is over. */
  readonly leaseGraceMs: number;
  now(): number;
}

export class LeaseHealth {
  /** Last pod-health probe per session (guards K8s API traffic). */
  private readonly checkedAt = new Map<string, number>();
  /** Consecutive *successful* probes reporting a missing/terminal pod. */
  private readonly strikes = new Map<string, number>();

  constructor(private readonly ctx: LeaseRuntime) {}

  /** A session that reached a terminal state has nothing left to probe. */
  forget(sessionId: string): void {
    this.checkedAt.delete(sessionId);
    this.strikes.delete(sessionId);
  }

  async enforce(session: SessionRecord): Promise<void> {
    // Detect a dead guest/pod between operations (crash, OOM, relay loss).
    // Probed at most every 2s per session to bound Kubernetes API traffic.
    //
    // Safety: a failed probe (timeout, 429, connection reset) must never
    // terminate a paid session. Only a successful read that reports the pod
    // missing or terminal counts, and it must happen twice in a row.
    const readyAt = session.readyAt ?? 0;
    if (session.podName && this.ctx.now() - readyAt > 2000 && this.ctx.now() - (this.checkedAt.get(session.id) ?? 0) > 2000) {
      this.checkedAt.set(session.id, this.ctx.now());
      try {
        const pod = await this.ctx.provisioner.getPod(session.podName);
        if (!pod || pod.phase === "Failed" || pod.phase === "Succeeded") {
          const strikes = (this.strikes.get(session.id) ?? 0) + 1;
          this.strikes.set(session.id, strikes);
          if (strikes >= 2) {
            await this.ctx.store.requestTermination(session.id, "failure:guest_exited", {
              code: "guest_exited",
              message: "the sandbox guest exited before the lease ended",
            });
            this.strikes.delete(session.id);
            return;
          }
        } else {
          this.strikes.delete(session.id);
        }
      } catch (err) {
        log.warn("pod_health_probe_failed", { sessionId: session.id, error: (err as Error).message });
      }
    }
    const deadline = session.leaseExpiresAt;
    if (deadline === null) return;
    const now = this.ctx.now();
    if (now > deadline + this.ctx.leaseGraceMs) {
      // The lease is over. If the session is inside a relay-loss window, the
      // reason is the relay loss: the guest had no link to run anything on, and
      // the refund policy compensates `relay_lost` but not an ordinary lease
      // expiry. Relay recovery normally decides this a second before the lease
      // (RELAY_LOSS_LEASE_MARGIN_MS); this is the backstop for a delayed scan.
      const relayLost = this.ctx.relayRecovery.awaitingReconnect(session.id);
      await this.ctx.store.requestTermination(
        session.id,
        relayLost ? "failure:relay_lost" : "lease_expired",
        relayLost
          ? {
              code: "relay_lost",
              message: "the lease ended while the guest was disconnected after a relay loss",
            }
          : undefined,
      );
      log.warn("sandbox_lease_expired", {
        sessionId: session.id,
        state: session.state,
        overrunMs: now - deadline,
        ...(relayLost ? { reason: "relay_lost" } : {}),
      });
    }
  }
}
