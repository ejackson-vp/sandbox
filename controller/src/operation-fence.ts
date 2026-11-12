/**
 * Restart-recovery fence for the single operation slot.
 *
 * `Store.recoverInterruptedOperations` marks the request that was in flight
 * `outcome_unknown` and leaves the session's gate closed. This reconciler is
 * the only code that may release that gate, and it releases it only after the
 * guest itself reports that the fenced request is no longer running.
 *
 * A fenced session is one whose `exec_epoch` was bumped for a request the
 * previous controller generation owned. Before it trusts the relay's view, the
 * reconciler publishes that epoch to the relay:
 *
 *   - the relay refuses any later frame below it (`stale_epoch` at the relay,
 *     never reaching the guest), and
 *   - a frame that was already forwarded but never observed is withdrawn; if
 *     the guest has not reported that epoch itself, the relay resets the guest
 *     link so the frame cannot be read from the socket queue. A reset guest
 *     process exits, exactly like any other relay-link loss; the reconciler
 *     then observes the dead Pod and fails the session with `guest_exited`
 *     (`restartPolicy: Never`). See docs/adr/0008.
 *
 * The relay keeps the guest's own status report (see GuestStatusMessage). That
 * report survives a controller restart when the relay does; when the relay
 * restarted too, the guest had to reconnect to a new relay generation, so its
 * status report starts again from "unknown". A session that lost its relay link
 * is marked with `requireGuestIdle`: those gates are released only once the
 * reconnected guest reports its slot idle. A disconnected guest is no longer
 * proof that the command is gone, because the same supervisor reconnects.
 *
 * A connected guest that has never reported status (an older guest build) keeps
 * the gate closed: failing closed is the contract.
 */
import { log } from "@x402s/shared/runtime";
import type { RelayClient } from "./relay-client.js";
import type { FenceStore } from "./store/ports.js";

interface FenceReconcileResult {
  /** Fenced gates released because the guest reported the request finished. */
  cleared: number;
  /** Gates still held because the guest reports an active operation. */
  held: number;
  /** Relay lookups or epoch publications that failed; the gate is left closed. */
  errors: number;
}

export class OperationFence {
  /**
   * Sessions whose guest link was lost and whose guest is expected back. Set by
   * relay-recovery when it fences an interrupted operation; cleared when the
   * gate is released. In memory on purpose: it describes the live relay link,
   * which is exactly as durable as this process.
   */
  private readonly awaitReconnect = new Set<string>();

  constructor(
    private readonly store: FenceStore,
    private readonly relay: RelayClient,
  ) {}

  /**
   * Hold this session's gate until a guest reconnects and reports idle. Called
   * before the relay is re-registered, so the fence cannot mistake the empty
   * registry of a new relay generation for "the guest is gone for good".
   */
  requireGuestIdle(sessionId: string): void {
    this.awaitReconnect.add(sessionId);
  }

  async reconcile(): Promise<FenceReconcileResult> {
    const result: FenceReconcileResult = { cleared: 0, held: 0, errors: 0 };
    const fenced = await this.store.listFencedSessions();
    // A session that is no longer fenced cannot be waiting for a reconnect.
    const stillFenced = new Set(fenced.map((session) => session.id));
    for (const id of this.awaitReconnect) {
      if (!stillFenced.has(id)) this.awaitReconnect.delete(id);
    }
    for (const session of fenced) {
      const requestId = session.activeRequestId;
      if (!requestId) continue;

      // Publish the generation that owns the fence before reading the relay's
      // state. A failure here means the relay cannot be told to reject the old
      // generation, so clearing the gate would be unsound: retry next tick.
      try {
        const raised = await this.relay.raiseEpoch(session.id, session.execEpoch);
        if (raised.reset) {
          // The relay ended the guest link to discard a frame from the
          // superseded generation. The supervisor exits on link loss, so this
          // session cannot continue with a live guest; the reconciler fails it
          // once the Pod reports terminal.
          log.warn("operation_fence_guest_reset", {
            sessionId: session.id,
            requestId,
            epoch: session.execEpoch,
            withdrawn: raised.withdrawn,
          });
        }
      } catch (err) {
        result.errors += 1;
        log.warn("operation_fence_epoch_failed", {
          sessionId: session.id,
          requestId,
          epoch: session.execEpoch,
          error: (err as Error).message,
        });
        continue;
      }

      let state;
      try {
        state = await this.relay.state(session.id);
      } catch (err) {
        // The relay may be restarting. Never clear a fence we cannot verify.
        result.errors += 1;
        log.warn("operation_fence_state_failed", {
          sessionId: session.id,
          requestId,
          error: (err as Error).message,
        });
        continue;
      }

      // No guest is connected. After a controller restart that means the
      // supervisor exited with its relay link, so the command cannot still be
      // running. After a relay loss it does not: the same supervisor is expected
      // to reconnect, so the gate waits for its idle status instead.
      if (!state.registered || !state.connected) {
        if (this.awaitReconnect.has(session.id)) {
          result.held += 1;
          continue;
        }
        if (await this.release(session.id, requestId, session.execEpoch)) result.cleared += 1;
        continue;
      }

      // A relay that did not take the floor could still forward an old frame.
      // It should never happen after a successful raiseEpoch, but a relay
      // restart between the two calls would leave a fresh registry behind.
      if ((state.epochFloor ?? 0) < session.execEpoch) {
        result.held += 1;
        continue;
      }

      // A connected guest that cannot state its execution status is not
      // trustworthy for this decision. Hold the gate until it disconnects,
      // reports status, or the lease ends.
      if (state.statusAt === undefined) {
        result.held += 1;
        continue;
      }

      if (state.activeRequestId) {
        result.held += 1;
        continue;
      }

      // The relay still has a request awaiting a guest response. Trust the
      // guest's status, but do not clear while the transport also believes the
      // request is outstanding.
      if (state.pending > 0) {
        result.held += 1;
        continue;
      }

      if (await this.release(session.id, requestId, session.execEpoch)) result.cleared += 1;
    }
    return result;
  }

  private async release(sessionId: string, requestId: string, epoch: number): Promise<boolean> {
    const cleared = await this.store.clearFencedGate(sessionId, requestId, epoch);
    if (cleared) {
      this.awaitReconnect.delete(sessionId);
      log.info("operation_fence_cleared", { sessionId, requestId, epoch });
    }
    return cleared;
  }
}
