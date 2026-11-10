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
 * restarted too, the guest's relay connection dropped and its supervisor
 * exited, so there is no command left to fence. A connected guest that has
 * never reported status (an older guest build) keeps the gate closed: failing
 * closed is the contract.
 */
import { log } from "@x402s/shared";
import type { RelayClient } from "./relay-client.js";
import type { FenceStore } from "./store/ports.js";

export interface FenceReconcileResult {
  /** Fenced gates released because the guest reported the request finished. */
  cleared: number;
  /** Gates still held because the guest reports an active operation. */
  held: number;
  /** Relay lookups or epoch publications that failed; the gate is left closed. */
  errors: number;
}

export class OperationFence {
  constructor(
    private readonly store: FenceStore,
    private readonly relay: RelayClient,
  ) {}

  async reconcile(): Promise<FenceReconcileResult> {
    const result: FenceReconcileResult = { cleared: 0, held: 0, errors: 0 };
    for (const session of this.store.listFencedSessions()) {
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

      // No guest is connected: the supervisor exits when its relay link drops,
      // so the command cannot still be running. (A pod that outlives its relay
      // link is killed by the lease and by guest shutdown on reconnect failure.)
      if (!state.registered || !state.connected) {
        if (this.release(session.id, requestId, session.execEpoch)) result.cleared += 1;
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

      if (this.release(session.id, requestId, session.execEpoch)) result.cleared += 1;
    }
    return result;
  }

  private release(sessionId: string, requestId: string, epoch: number): boolean {
    const cleared = this.store.clearFencedGate(sessionId, requestId, epoch);
    if (cleared) {
      log.info("operation_fence_cleared", { sessionId, requestId, epoch });
    }
    return cleared;
  }
}
