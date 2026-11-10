------------------------------ MODULE SlotRace ------------------------------
(*
 * Deliberately broken variant: the single-operation gate is read and written in
 * two steps. Two concurrent requesters both observe `slots = {}` and both take
 * a slot, which is exactly what BEGIN IMMEDIATE in store.claimOperation
 * prevents. The model checker must reject this.
 *
 * Isolated in verification/broken/; the good spec is ../SandboxSession.tla.
 *)
EXTENDS SandboxSession

BrokenStartOp(s, r) ==
  /\ recovered
  /\ state[s] \in ReadyStates
  /\ reservations[s] = "ALLOCATED"
  /\ ~fenced(s)
  \* Missing: slots[s] = {}. The read and the write are separate steps.
  /\ r \notin slots[s]
  /\ slots' = [slots EXCEPT ![s] = slots[s] \cup {r}]
  /\ slotEpoch' = [slotEpoch EXCEPT ![s] = execEpoch[s]]
  /\ state' = [state EXCEPT ![s] = "ACTIVE"]
  /\ fence' = [fence EXCEPT ![s] = "none"]
  /\ fenceReq' = [fenceReq EXCEPT ![s] = "none"]
  /\ UNCHANGED <<created, payOf, everReady, intent, intentEpoch, settledTo, charges,
                 refund, reservations, resPayment, pod, creating, pvc, relay,
                 guest, final, epoch, execEpoch, guestConnected, guestStatus,
                 guestEpoch, admittedEpoch, relayPending, recovered, startGen>>

BrokenOperationActions ==
  \/ \E s \in Sessions, r \in Requests :
       BrokenStartOp(s, r) \/ DispatchOp(s, r) \/ GuestResponse(s, r)
       \/ GuestDone(s, r) \/ FinishOp(s, r)
  \/ \E s \in Sessions : FenceRelease(s) \/ RejectStaleFrame(s)

BrokenNext ==
  PaymentActions \/ LifecycleActions \/ ConnectionActions
  \/ BrokenOperationActions \/ RecoveryActions

BrokenSpec == Init /\ [][BrokenNext]_vars

=============================================================================
