------------------------------ MODULE DoubleCharge ------------------------------
(*
 * Deliberately broken variant: the payment row and the entitlement are written
 * in two transactions, and the payment insert does not enforce the UNIQUE
 * payment key. A crash between the two steps plus a client retry that rebinds
 * the reservation to a new session id charges the same key twice.
 *
 * The good spec commits both rows in ChargeSession (store.completeEntitlement).
 * Isolated in verification/broken/; the good spec is ../SandboxSession.tla.
 *)
EXTENDS SandboxSession

BrokenInsertPayment(s, p) ==
  /\ intent[p] = "claimed"
  /\ reservations[s] = "ATTACHED"
  /\ resPayment[s] = p
  /\ s \notin created
  \* Missing, and not enforced by a unique index either: charges[p] = 0.
  /\ charges' = [charges EXCEPT ![p] = charges[p] + 1]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 refund, reservations, resPayment, pod, creating, pvc, relay,
                 slots, guest, slotEpoch, final, epoch, execEpoch, guestConnected,
                 guestStatus, guestEpoch, admittedEpoch, relayPending, fence,
                 fenceReq, recovered, startGen>>

BrokenCreateEntitlement(s, p) ==
  /\ intent[p] = "claimed"
  /\ reservations[s] = "ATTACHED"
  /\ resPayment[s] = p
  /\ charges[p] = 1
  /\ settledTo[p] = "none"
  /\ s \notin created
  /\ created' = created \cup {s}
  /\ state' = [state EXCEPT ![s] = "PAID"]
  /\ payOf' = [payOf EXCEPT ![s] = p]
  /\ settledTo' = [settledTo EXCEPT ![p] = s]
  /\ intent' = [intent EXCEPT ![p] = "settled"]
  /\ reservations' = [reservations EXCEPT ![s] = "ALLOCATED"]
  /\ UNCHANGED <<everReady, intentEpoch, charges, refund, resPayment, pod, creating,
                 pvc, relay, slots, guest, slotEpoch, final, epoch, execEpoch,
                 guestConnected, guestStatus, guestEpoch, admittedEpoch,
                 relayPending, fence, fenceReq, recovered, startGen>>

BrokenSettlementActions ==
  \E s \in Sessions, p \in Payments :
    BrokenInsertPayment(s, p) \/ BrokenCreateEntitlement(s, p)

BrokenNext ==
  IntentActions \/ ReservationActions \/ BrokenSettlementActions \/ RefundActions
  \/ LifecycleActions \/ ConnectionActions \/ OperationActions \/ RecoveryActions
  \/ Stutter

BrokenSpec == Init /\ [][BrokenNext]_vars

=============================================================================
