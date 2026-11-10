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
  /\ state[s] \in ReadyStates
  /\ reservations[s] = "ALLOCATED"
  /\ r \notin slots[s]
  /\ slots' = [slots EXCEPT ![s] = slots[s] \cup {r}]
  /\ slotEpoch' = [slotEpoch EXCEPT ![s] = epoch]
  /\ state' = [state EXCEPT ![s] = "ACTIVE"]
  /\ UNCHANGED <<created, payOf, everReady, intent, intentEpoch, settledTo, charges,
                 refund, reservations, resPayment, pod, creating, pvc, relay,
                 guest, final, epoch>>

BrokenOperationActions ==
  \/ \E s \in Sessions, r \in Requests :
       BrokenStartOp(s, r) \/ DispatchOp(s, r) \/ GuestDone(s, r) \/ FinishOp(s, r)
  \/ \E s \in Sessions : RecoverInterruptedOp(s)

BrokenNext == PaymentActions \/ LifecycleActions \/ BrokenOperationActions

BrokenSpec == Init /\ [][BrokenNext]_vars

=============================================================================
