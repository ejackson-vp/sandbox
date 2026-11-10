------------------------------ MODULE CapacityRace ------------------------------
(*
 * Deliberately broken variant: admission accounts only ALLOCATED rows and
 * ignores the ATTACHED rows written before entitlement settles, double-counting
 * the crash window instead of excluding it (the `replacingExisting` case in
 * controller/src/capacity/reservations.ts). Two concurrent attaches then both
 * take the node's last free slot.
 *
 * Isolated in verification/broken/; the good spec is ../SandboxSession.tla.
 *)
EXTENDS SandboxSession

BrokenReserveCapacity(s, p) ==
  /\ intent[p] = "claimed"
  /\ s \notin created
  /\ reservations[s] = "NONE"
  /\ \A t \in Sessions : resPayment[t] # p
  /\ Cardinality(
       {t \in Sessions : resPayment[t] # "none" /\ reservations[t] = "ALLOCATED"}
     ) < NodeCapacity
  /\ reservations' = [reservations EXCEPT ![s] = "ATTACHED"]
  /\ resPayment' = [resPayment EXCEPT ![s] = p]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, pod, creating, pvc, relay, slots, guest,
                 slotEpoch, final, epoch>>

BrokenReservationActions ==
  \/ \E s \in Sessions, p \in Payments : BrokenReserveCapacity(s, p)
  \/ \E s \in Sessions, t \in Sessions, p \in Payments : RebindReservation(s, t, p)
  \/ \E s \in Sessions : AbandonReservation(s)

BrokenNext ==
  IntentActions \/ BrokenReservationActions \/ SettlementActions \/ RefundActions
  \/ LifecycleActions \/ OperationActions \/ Stutter

BrokenSpec == Init /\ [][BrokenNext]_vars

=============================================================================
