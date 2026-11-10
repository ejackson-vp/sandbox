------------------------------ MODULE StaleEpoch ------------------------------
(*
 * Deliberately broken variant: the guest admits a frame whose execution epoch
 * is below its high-water mark. `admitEpoch` in guest/supervisor.go compares
 * the frame epoch against the highest epoch already accepted and rejects a
 * lower one with `stale_epoch`; this variant removes that comparison and starts
 * the stale command anyway.
 *
 * A stale start leaves the guest running a request that does not hold the
 * controller gate (GuestRunsGateHeldRequest) at an epoch below the one the
 * guest has already observed. StaleFrameNeverStarts is the invariant this
 * variant exists to falsify.
 *
 * Isolated in verification/broken/; the good spec is ../SandboxSession.tla.
 *)
EXTENDS SandboxSession

BrokenStaleFrame(s, r, e) ==
  /\ guestConnected[s]
  /\ guest[s] = {}
  /\ e \in Epochs
  /\ e < guestEpoch[s]
  /\ e < execEpoch[s]
  \* Missing: admitEpoch's `epoch < s.epoch` reject. The stale command takes
  \* the guest slot instead of returning stale_epoch.
  /\ guest' = [guest EXCEPT ![s] = {r}]
  /\ guestStatus' = [guestStatus EXCEPT ![s] = r]
  /\ admittedEpoch' = [admittedEpoch EXCEPT ![s] = e]
  /\ relayPending' = [relayPending EXCEPT ![s] = 1]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, reservations, resPayment, pod, creating, pvc,
                 relay, slots, slotEpoch, final, epoch, execEpoch, guestConnected,
                 guestEpoch, fence, fenceReq, recovered>>

BrokenOperationActions ==
  \/ \E s \in Sessions, r \in Requests :
       StartOp(s, r) \/ DispatchOp(s, r) \/ GuestResponse(s, r)
       \/ GuestDone(s, r) \/ FinishOp(s, r)
  \/ \E s \in Sessions : FenceRelease(s)
  \/ \E s \in Sessions, r \in Requests, e \in Epochs : BrokenStaleFrame(s, r, e)

BrokenNext ==
  PaymentActions \/ LifecycleActions \/ ConnectionActions
  \/ BrokenOperationActions \/ RecoveryActions \/ Stutter

BrokenSpec == Init /\ [][BrokenNext]_vars

=============================================================================
