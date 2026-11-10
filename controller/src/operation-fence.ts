/**
 * Restart-recovery fence for the single operation slot.
 *
 * `Store.recoverInterruptedOperations` marks the request that was in flight
 * `outcome_unknown` and leaves the session's gate closed. This reconciler is
 * the only code that may release that gate, and it releases it only after the
 * guest itself reports that the fenced request is no longer running.
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
import type { Store } from "./store.js";

export interface FenceReconcileResult {
  /** Fenced gates released because the guest reported the request finished. */
  cleared: number;
  /** Gates still held because the guest reports an active operation. */
  held: number;
  /** Relay lookups that failed; the gate is left closed. */
  errors: number;
}

export class OperationFence {
  constructor(
    private readonly store: Store,
    private readonly relay: RelayClient,
  ) {}

  async reconcile(): Promise<FenceReconcileResult> {
    const result: FenceReconcileResult = { cleared: 0, held: 0, errors: 0 };
    for (const session of this.store.listFencedSessions()) {
      const requestId = session.activeRequestId;
      if (!requestId) continue;

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
