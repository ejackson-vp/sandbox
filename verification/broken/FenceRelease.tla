------------------------------ MODULE FenceRelease ------------------------------
(*
 * Deliberately broken variant: OperationFence releases the recovery fence
 * without asking the guest. The gate is cleared as soon as the controller has
 * an active_request_id, regardless of whether the guest reports the fenced
 * request still running, has never reported status, or still has a relay frame
 * outstanding.
 *
 * The good spec releases only from FenceRelease, gated on the guest's own
 * idle status (or a lost guest) and on an empty relay pending set. This variant
 * is rejected by NoPrematureFenceRelease.
 *
 * Isolated in verification/broken/; the good spec is ../SandboxSession.tla.
 *)
EXTENDS SandboxSession

BrokenFenceRelease(s) ==
  /\ fenced(s)
  /\ slots[s] = {fenceReq[s]}
  \* Missing: relayPending[s] = 0, and either ~guestConnected[s] or the
  \* guest's reported idle status. clearFencedGate() is called unconditionally.
  /\ slots' = [slots EXCEPT ![s] = {}]
  /\ state' = [state EXCEPT ![s] = IF state[s] = "ACTIVE" THEN "READY" ELSE state[s]]
  /\ fence' = [fence EXCEPT ![s] = "released"]
  /\ UNCHANGED <<created, payOf, everReady, intent, intentEpoch, settledTo, charges,
                 refund, reservations, resPayment, pod, creating, pvc, relay,
                 guest, slotEpoch, final, epoch, execEpoch, guestConnected,
                 guestStatus, guestEpoch, admittedEpoch, relayPending, fenceReq,
                 recovered, startGen>>

BrokenOperationActions ==
  \/ \E s \in Sessions, r \in Requests :
       StartOp(s, r) \/ DispatchOp(s, r) \/ GuestResponse(s, r)
       \/ GuestDone(s, r) \/ FinishOp(s, r)
  \/ \E s \in Sessions : BrokenFenceRelease(s) \/ RejectStaleFrame(s)

BrokenNext ==
  PaymentActions \/ LifecycleActions \/ ConnectionActions
  \/ BrokenOperationActions \/ RecoveryActions \/ Stutter

BrokenSpec == Init /\ [][BrokenNext]_vars

=============================================================================
