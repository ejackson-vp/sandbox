/**
 * Relay generation recovery.
 *
 * The relay registry is in memory, one per relay process. A relay restart drops
 * every registration and every guest socket on that shard. Before this module
 * existed the supervisor exited with its link, the Pod went terminal, and the
 * controller failed a paid session with `failure:guest_exited`.
 *
 * The guest now reconnects, so the controller has to do three things when the
 * relay it registered a session on is replaced (or the registration disappears):
 *
 *   1. fence the operation that was in flight exactly once: mark the request
 *      `outcome_unknown` and bump `sessions.exec_epoch`, which is the same fence
 *      a controller restart uses (`OperationFence`, ADR 0008). A frame the old
 *      relay accepted is never redelivered and is never re-executed;
 *   2. re-register the session on the current relay generation with the same
 *      token hash and the same shard claim rules the create path uses, so the
 *      reconnecting guest has somewhere to land;
 *   3. hold the operation gate until the reconnected guest reports its slot idle,
 *      and end the session `failure:relay_lost` if that does not happen inside
 *      the configured grace.
 *
 * Detection is per session, from the snapshot that also carries the generation
 * (`RelayClient.state`), so a snapshot can never be half old and half new. The
 * generation this process last observed is kept in memory: after a controller
 * restart the first observation establishes the baseline, because startup
 * recovery (`recoverInterruptedOperations`) has already fenced anything that was
 * in flight before this process existed.
 */
import { log, metrics } from "@x402s/shared/runtime";
import type { ControllerConfig } from "./config.js";
import type { RelayClient } from "./relay-client.js";
import type { OperationFence } from "./operation-fence.js";
import type { RelayRecoveryStore } from "./store/ports.js";
import type { SessionRecord } from "./store/models.js";

/**
 * Bound on sessions inspected per pass; the scan runs at housekeeping cadence.
 * The scan pages by session id, so a deployment with more live sessions than
 * this is covered over successive passes rather than the tail never being
 * scanned. At the default 1 s cadence, 500 costs 500 relay state reads/s, which
 * the control listener's internal rate limit (2000/s) absorbs.
 */
export const RELAY_SCAN_LIMIT = 500;

/** Map entries unseen for this long are dropped (a terminated session's). */
const FORGET_AFTER_MS = 600_000;

/**
 * How far before the lease deadline relay loss must be decided.
 *
 * `enforceLease` cannot request `lease_expired` before `leaseExpiresAt +
 * leaseGraceMs` (2 s by default), so firing `relay_lost` at
 * `leaseExpiresAt - margin` leaves at least the margin plus the lease grace
 * between the two. The grace alone is not enough: a 60 s lease with a 90 s
 * grace would otherwise end as `lease_expired`, which the refund policy does
 * not compensate, even though the relay loss caused the interruption.
 */
const RELAY_LOSS_LEASE_MARGIN_MS = 1_000;

export interface RelayRecoveryResult {
  /** Sessions inspected this pass. */
  scanned: number;
  /** Interrupted operations fenced after a link loss. */
  fenced: number;
  /** Sessions re-registered on the current relay generation. */
  reregistered: number;
  /** Sessions ended because the guest did not come back inside the grace. */
  lost: number;
  /** Relay observations or registrations that failed; retried next pass. */
  errors: number;
}

type RelayRecoveryConfig = Pick<
  ControllerConfig,
  "relayLossGraceMs" | "relayRegistrationTimeoutMs"
> & {
  /** Override for tests; defaults to RELAY_SCAN_LIMIT. */
  scanLimit?: number;
};

export class RelayRecovery {
  /** Last relay generation observed per session. In memory, like the link. */
  private readonly generations = new Map<string, string>();
  /** When a session's guest link was first observed lost. */
  private readonly lostAt = new Map<string, number>();
  /** Sessions whose grace expiry was already requested, so it is asked once. */
  private readonly expiring = new Set<string>();
  /** Last pass that inspected each session, for bounded map cleanup. */
  private readonly lastSeen = new Map<string, number>();
  /**
   * Paging cursor: the last session id inspected. `null` starts a fresh sweep.
   * Without it, a deployment with more sessions than RELAY_SCAN_LIMIT would
   * only ever scan the first page.
   */
  private cursor: string | null = null;

  private readonly limit: number;

  constructor(
    private readonly cfg: RelayRecoveryConfig,
    private readonly store: RelayRecoveryStore,
    private readonly relay: RelayClient,
    private readonly fence: OperationFence,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.limit = Math.max(1, cfg.scanLimit ?? RELAY_SCAN_LIMIT);
  }

  async reconcile(): Promise<RelayRecoveryResult> {
    const result: RelayRecoveryResult = {
      scanned: 0,
      fenced: 0,
      reregistered: 0,
      lost: 0,
      errors: 0,
    };
    let sessions: SessionRecord[];
    try {
      sessions = await this.store.listRelaySessions(this.limit, this.cursor);
    } catch (err) {
      log.warn("relay_recovery_list_failed", { error: (err as Error).message });
      result.errors += 1;
      return result;
    }
    this.cursor =
      sessions.length === this.limit ? (sessions[sessions.length - 1]?.id ?? null) : null;
    const now = this.now();
    this.prune(now);

    for (const session of sessions) {
      this.lastSeen.set(session.id, now);
      result.scanned += 1;
      if (!session.relayTokenHash) continue;
      try {
        await this.reconcileSession(session, result);
      } catch (err) {
        result.errors += 1;
        log.warn("relay_recovery_session_failed", {
          sessionId: session.id,
          error: (err as Error).message,
        });
      }
    }
    return result;
  }

  private async reconcileSession(
    session: SessionRecord,
    result: RelayRecoveryResult,
  ): Promise<void> {
    const now = this.now();
    // A lease that is already over has no paid work left to resume, and the
    // reconciler's lease check owns the outcome. A guest that disconnects at its
    // lease boundary is not a relay loss: classifying it as one would turn every
    // ordinary expiry into a refunded FAILED session. The loss window is only
    // opened while the lease is live, which is also the only time the
    // lease-bound deadline can fire.
    if (session.leaseExpiresAt !== null && now >= session.leaseExpiresAt) {
      this.lostAt.delete(session.id);
      this.expiring.delete(session.id);
      return;
    }
    let state;
    try {
      state = await this.relay.state(session.id);
    } catch (err) {
      // The relay is unreachable, so the link is not demonstrably alive.
      // Nothing can be re-registered yet; the grace still runs, because a relay
      // that never returns cannot serve the session either.
      this.markLost(session.id, now);
      log.warn("relay_recovery_state_failed", {
        sessionId: session.id,
        error: (err as Error).message,
      });
      result.errors += 1;
      await this.expireIfLost(session, now, result);
      return;
    }

    const known = this.generations.get(session.id);
    if (known === undefined) {
      // First observation since this process started. A generation change that
      // happened while the controller was down was already covered by startup
      // recovery, so recording a baseline here cannot lose a fence.
      this.generations.set(session.id, state.generation);
    }
    const baseline = known ?? state.generation;

    const live = state.registered && state.connected && state.generation === baseline;
    if (live) {
      this.lostAt.delete(session.id);
      this.expiring.delete(session.id);
      return;
    }

    this.markLost(session.id, now);
    const changed = known !== undefined && state.generation !== known;

    // 1. Fence the operation the lost link was carrying, before the session is
    //    re-registered: the guest may connect the moment the entry exists. The
    //    store transition is the guard, so a repeated scan cannot bump twice.
    //    A gate that an earlier pass already fenced still needs the hold: the
    //    operation is unknown either way and only the guest's idle status may
    //    release it.
    if (session.activeRequestId) {
      try {
        const recovered = await this.store.recoverSessionOperation(session.id);
        if (recovered.requestId) {
          result.fenced += 1;
          log.warn("relay_operation_fenced", {
            sessionId: session.id,
            requestId: recovered.requestId,
            epoch: recovered.epoch,
            generation: state.generation,
            generationChanged: changed,
            registered: state.registered,
            connected: state.connected,
          });
        }
        this.fence.requireGuestIdle(session.id);
      } catch (err) {
        result.errors += 1;
        log.warn("relay_operation_fence_failed", {
          sessionId: session.id,
          error: (err as Error).message,
        });
        // Without the fence the gate must stay closed, which it does: the row is
        // untouched and the relay link is gone.
        await this.expireIfLost(session, now, result);
        return;
      }
    }

    // 2. Put the session back on the relay that is serving now.
    if (!state.registered || changed) {
      const registered = await this.register(session, result);
      if (registered) {
        this.generations.set(session.id, registered);
        result.reregistered += 1;
      }
    } else {
      this.generations.set(session.id, state.generation);
    }

    // 3. A guest that does not come back inside the grace loses the session for
    //    a reason the refund policy can act on, rather than as `guest_exited`.
    await this.expireIfLost(session, now, result);
  }

  private async register(session: SessionRecord, result: RelayRecoveryResult): Promise<string | null> {
    const remaining = Math.max(0, (session.leaseExpiresAt ?? this.now()) - this.now());
    // The entry must outlive the lease it serves, plus the same margin the
    // create path adds, so a long operation near the deadline is not refused.
    const ttlMs = Math.max(60_000, remaining + 300_000);
    try {
      const registered = await this.relay.registerCurrent(
        session.id,
        session.relayTokenHash!,
        ttlMs,
        { deadlineMs: this.cfg.relayRegistrationTimeoutMs },
      );
      metrics
        .counter(
          "sandbox_relay_sessions_reregistered_total",
          "Sessions the controller re-registered after a relay generation change",
        )
        .inc();
      log.info("relay_session_reregistered", {
        sessionId: session.id,
        generation: registered.generation,
      });
      return registered.generation;
    } catch (err) {
      result.errors += 1;
      log.warn("relay_reregister_failed", {
        sessionId: session.id,
        error: (err as Error).message,
      });
      return null;
    }
  }

  /**
   * Whether this session is inside a relay-loss window right now, i.e. its
   * guest is expected back and the controller has started the clock. The lease
   * check uses it to attribute an overrun that happens while the link is lost to
   * `relay_lost`, so a delayed scan cannot turn the same interruption into
   * `lease_expired`.
   */
  awaitingReconnect(sessionId: string): boolean {
    return this.lostAt.has(sessionId);
  }

  private markLost(sessionId: string, now: number): void {
    if (!this.lostAt.has(sessionId)) this.lostAt.set(sessionId, now);
  }

  /**
   * The moment relay loss may be declared: whichever comes first, the end of
   * the grace or just before the lease deadline. Both are "the guest had its
   * chance and the session has no time left", and the earlier one is what keeps
   * the reason `relay_lost` instead of a lease expiry the refund policy ignores.
   */
  private lossDeadline(session: SessionRecord, since: number): number {
    const graceDeadline = since + this.cfg.relayLossGraceMs;
    const lease = session.leaseExpiresAt;
    if (lease === null) return graceDeadline;
    return Math.min(graceDeadline, lease - RELAY_LOSS_LEASE_MARGIN_MS);
  }

  private async expireIfLost(
    session: SessionRecord,
    now: number,
    result: RelayRecoveryResult,
  ): Promise<void> {
    const since = this.lostAt.get(session.id);
    if (since === undefined) return;
    // Whichever comes first: the grace, or the end of the lease. A lease that is
    // already inside the margin declares the loss on this pass; it must not wait
    // for a grace the session will never see. While the lease has time and the
    // grace has not run, the guest is still allowed to reconnect.
    const deadline = this.lossDeadline(session, since);
    if (now < deadline) return;
    if (this.expiring.has(session.id)) return;
    let ended = false;
    try {
      ended = await this.store.requestTermination(session.id, "failure:relay_lost", {
        code: "relay_lost",
        message: "the guest did not reconnect to the relay before the grace expired",
      });
    } catch (err) {
      // A store failure is not an answer: retry on the next pass rather than
      // marking the session as "asked" and leaving it alive forever.
      result.errors += 1;
      log.warn("relay_lost_termination_failed", {
        sessionId: session.id,
        error: (err as Error).message,
      });
      return;
    }
    if (ended) {
      this.expiring.add(session.id);
      result.lost += 1;
      metrics
        .counter("sandbox_relay_lost_total", "Sessions ended because their guest did not reconnect")
        .inc();
      log.warn("sandbox_relay_lost", {
        sessionId: session.id,
        graceMs: now - since,
        leaseBound: session.leaseExpiresAt !== null &&
          session.leaseExpiresAt - RELAY_LOSS_LEASE_MARGIN_MS < since + this.cfg.relayLossGraceMs,
        leaseExpiresAt: session.leaseExpiresAt,
      });
    }
  }

  /**
   * Drop map entries for sessions this scan has not seen for a while (the
   * session terminated, or it left READY/ACTIVE). Deliberately not "not seen
   * this pass": the scan pages, so an id absent from one page is not gone.
   */
  private prune(now: number): void {
    for (const [id, seenAt] of this.lastSeen) {
      if (now - seenAt <= FORGET_AFTER_MS) continue;
      this.lastSeen.delete(id);
      this.generations.delete(id);
      this.lostAt.delete(id);
      this.expiring.delete(id);
    }
  }
}
