------------------------------ MODULE SandboxSession ------------------------------
(*
 * Executable model of the sandbox control plane: session lifecycle, payment
 * intent, the single-operation slot and capacity reservation, under client
 * retries, controller crash/restart and relay loss.
 *
 * This is not a product specification. It is a bounded, deliberately abstract
 * model whose job is to check temporal invariants that example- and
 * property-based tests can only sample. Correspondence to the implementation:
 *
 *   shared/src/domain/session.ts              SOURCE_STATES, transition()
 *   controller/src/store.ts                   claimPaymentIntent,
 *                                             completeEntitlement,
 *                                             claimOperation, finishOperation,
 *                                             recoverInterruptedOperations,
 *                                             finalizeTermination
 *   controller/src/capacity/reservations.ts   admit, attachToSession, resume,
 *                                             beginRelease, confirmRelease
 *   controller/src/termination.ts             cleanup ordering before finalize
 *   controller/src/refunds.ts                 refund policy + reconcile
 *
 * Deliberate abstraction: there is one controller process (the store is the
 * single writer), so a crash is an epoch bump rather than a lost process; the
 * relay is a boolean; time is not modelled, so hold expiry and lease expiry
 * are nondeterministic environment steps.
 *)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
  Sessions,      \* set of session identities the client may create
  Payments,      \* set of payment keys the client may retry with
  Requests,      \* set of operation (exec) request ids per session
  NodeCapacity,  \* compute slots on the (single) node, in reservation units
  MaxRestarts,   \* bound on controller crash/restart cycles
  PodIds         \* Pod instances a session may ever hold at once

States ==
  {"CREATED", "PAID", "PROVISIONING", "READY", "ACTIVE", "SUSPENDING",
   "SUSPENDED", "RESUMING", "TERMINATING", "DESTROYED", "EXPIRED", "FAILED"}

TerminalStates == {"DESTROYED", "EXPIRED", "FAILED"}

ReadyStates == {"READY", "ACTIVE"}

\* SOURCE_STATES.terminate_requested: every non-terminal state except CREATED.
TerminableStates ==
  {"PAID", "PROVISIONING", "READY", "ACTIVE", "SUSPENDING", "SUSPENDED", "RESUMING"}

\* SOURCE_STATES.lease_expired.
LeaseExpirableStates ==
  {"PROVISIONING", "READY", "ACTIVE", "SUSPENDING", "SUSPENDED", "RESUMING"}

\* Reservation states, mirroring controller/src/capacity/reservations.ts.
RStates == {"NONE", "ATTACHED", "ALLOCATED", "SUSPENDED", "RELEASING", "RELEASED"}

\* Reservation states that hold compute. RELEASING holds compute on purpose:
\* capacity is returned only once the Pod object is observed gone.
ComputingRStates == {"ATTACHED", "ALLOCATED", "RELEASING"}

Finals == {"NONE", "DESTROYED", "EXPIRED", "FAILED"}

VARIABLES
  created,      \* SUBSET Sessions                  session rows that exist
  state,        \* [Sessions -> States]
  payOf,        \* [Sessions -> Payments \cup {"none"}]
  everReady,    \* [Sessions -> BOOLEAN]            has the session ever been READY
  intent,       \* [Payments -> {"none", "claimed", "settled"}]
  intentEpoch,  \* [Payments -> 0..MaxRestarts]     epoch of the claim, for stale reclaim
  settledTo,    \* [Payments -> Sessions \cup {"none"}]
  charges,      \* [Payments -> 0..1]               payment rows written
  refund,       \* [Payments -> {"none", "pending", "refunded"}]
  reservations, \* [Sessions -> RStates]
  resPayment,   \* [Sessions -> Payments \cup {"none"}]
  pod,          \* [Sessions -> PodIds \cup {"none"}]  Pod instance recorded on the session row
  creating,     \* [Sessions -> SUBSET PodIds]         Pod instances created, not yet recorded
  pvc,          \* [Sessions -> BOOLEAN]
  relay,        \* [Sessions -> BOOLEAN]
  slots,        \* [Sessions -> SUBSET Requests]       controller-side operation gate
  guest,        \* [Sessions -> SUBSET Requests]       guest-side in-flight command
  slotEpoch,    \* [Sessions -> 0..MaxRestarts]        epoch the slot was claimed in
  final,        \* [Sessions -> Finals]                terminal state chosen at termination
  epoch         \* 0..MaxRestarts                      controller generation

vars ==
  <<created, state, payOf, everReady, intent, intentEpoch, settledTo, charges,
    refund, reservations, resPayment, pod, creating, pvc, relay, slots, guest,
    slotEpoch, final, epoch>>

(* ------------------------------------------------------------------ *)
(* Derived predicates                                                  *)
(* ------------------------------------------------------------------ *)

\* Every Pod instance the session owns, recorded or not. The unrecorded ones
\* are the crash window between a successful Kubernetes create and the session
\* row update that names the Pod.
podsAlive(s) ==
  (IF pod[s] = "none" THEN {} ELSE {pod[s]}) \cup creating[s]

\* Sessions that were admitted compute and can still consume it. A row is bound
\* to a payment key for its whole life, including the crash window in which the
\* session row does not exist yet.
\*
\* ATTACHED and ALLOCATED are the only states reachable through admission, so
\* they are what the over-reservation invariant counts. RELEASING is excluded on
\* purpose: holdsCompute() counts it too, but a SUSPENDED reservation that moves
\* to RELEASING was never holding compute, so counting it would measure the
\* controller's conservative accounting rather than the node's sold capacity.
\* See verification/README.md.
admittedCompute ==
  {s \in Sessions : resPayment[s] # "none" /\ reservations[s] \in {"ATTACHED", "ALLOCATED"}}

usedCompute == Cardinality(admittedCompute)

(* ------------------------------------------------------------------ *)
(* Initial state                                                       *)
(* ------------------------------------------------------------------ *)

Init ==
  /\ created = {}
  /\ state = [s \in Sessions |-> "CREATED"]
  /\ payOf = [s \in Sessions |-> "none"]
  /\ everReady = [s \in Sessions |-> FALSE]
  /\ intent = [p \in Payments |-> "none"]
  /\ intentEpoch = [p \in Payments |-> 0]
  /\ settledTo = [p \in Payments |-> "none"]
  /\ charges = [p \in Payments |-> 0]
  /\ refund = [p \in Payments |-> "none"]
  /\ reservations = [s \in Sessions |-> "NONE"]
  /\ resPayment = [s \in Sessions |-> "none"]
  /\ pod = [s \in Sessions |-> "none"]
  /\ creating = [s \in Sessions |-> {}]
  /\ pvc = [s \in Sessions |-> FALSE]
  /\ relay = [s \in Sessions |-> FALSE]
  /\ slots = [s \in Sessions |-> {}]
  /\ guest = [s \in Sessions |-> {}]
  /\ slotEpoch = [s \in Sessions |-> 0]
  /\ final = [s \in Sessions |-> "NONE"]
  /\ epoch = 0

(* ------------------------------------------------------------------ *)
(* Payment intent: claim, stale reclaim, settle, refund                *)
(* ------------------------------------------------------------------ *)

\* POST /internal/payment-intents/claim. A retry after a controller crash
\* reclaims a stale claim: the row is still `claimed` but was written in an
\* older epoch, so no progress is possible from it.
ClaimIntent(p) ==
  /\ \/ intent[p] = "none"
     \/ (intent[p] = "claimed" /\ intentEpoch[p] < epoch)
  /\ intent' = [intent EXCEPT ![p] = "claimed"]
  /\ intentEpoch' = [intentEpoch EXCEPT ![p] = epoch]
  /\ UNCHANGED <<created, state, payOf, everReady, settledTo, charges, refund,
                 reservations, resPayment, pod, creating, pvc, relay, slots,
                 guest, slotEpoch, final, epoch>>

\* capacity.admit for a payment: a provisional hold, taken before settlement.
\* One reservation per payment key; capacity is checked and written in the
\* same step, which is what BEGIN IMMEDIATE buys.
ReserveCapacity(s, p) ==
  /\ intent[p] = "claimed"
  /\ s \notin created
  /\ reservations[s] = "NONE"
  /\ \A t \in Sessions : resPayment[t] # p
  /\ usedCompute < NodeCapacity
  /\ reservations' = [reservations EXCEPT ![s] = "ATTACHED"]
  /\ resPayment' = [resPayment EXCEPT ![s] = p]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, pod, creating, pvc, relay, slots, guest,
                 slotEpoch, final, epoch>>

\* reservations.ts attachToSession: a crash between attach and entitlement
\* leaves a reservation under a session id that was never durable, so the same
\* row is rebound to the retry's session id instead of being re-admitted.
RebindReservation(s, t, p) ==
  /\ s \notin created
  /\ t \notin created
  /\ s # t
  /\ reservations[t] = "ATTACHED"
  /\ resPayment[t] = p
  /\ reservations[s] = "NONE"
  /\ reservations' = [reservations EXCEPT ![t] = "NONE", ![s] = "ATTACHED"]
  /\ resPayment' = [resPayment EXCEPT ![t] = "none", ![s] = p]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, pod, creating, pvc, relay, slots, guest,
                 slotEpoch, final, epoch>>

\* A reservation whose payment was rejected is released without a session.
AbandonReservation(s) ==
  /\ reservations[s] = "ATTACHED"
  /\ s \notin created
  /\ reservations' = [reservations EXCEPT ![s] = "RELEASED"]
  /\ resPayment' = [resPayment EXCEPT ![s] = "none"]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, pod, creating, pvc, relay, slots, guest,
                 slotEpoch, final, epoch>>

\* store.completeEntitlement: payment row, ledger row, session row and intent
\* settle commit together. The UNIQUE payment key is the `charges[p] = 0`
\* guard; the session is created in this same step.
ChargeSession(s, p) ==
  /\ intent[p] = "claimed"
  /\ reservations[s] = "ATTACHED"
  /\ resPayment[s] = p
  /\ charges[p] = 0
  /\ settledTo[p] = "none"
  /\ s \notin created
  /\ created' = created \cup {s}
  /\ state' = [state EXCEPT ![s] = "PAID"]
  /\ payOf' = [payOf EXCEPT ![s] = p]
  /\ charges' = [charges EXCEPT ![p] = 1]
  /\ settledTo' = [settledTo EXCEPT ![p] = s]
  /\ intent' = [intent EXCEPT ![p] = "settled"]
  /\ reservations' = [reservations EXCEPT ![s] = "ALLOCATED"]
  /\ UNCHANGED <<everReady, intentEpoch, refund, resPayment, pod, creating, pvc,
                 relay, slots, guest, slotEpoch, final, epoch>>

\* refunds.ts: a settled session that never reached READY gets a refund
\* obligation; mock mode settles it immediately, real modes wait for an
\* operator. Recording the obligation is what makes the outcome explicit.
MarkRefundPending(p) ==
  /\ refund[p] = "none"
  /\ charges[p] = 1
  /\ \E s \in Sessions :
       /\ settledTo[p] = s
       /\ state[s] \in TerminalStates
       /\ ~everReady[s]
  /\ refund' = [refund EXCEPT ![p] = "pending"]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, reservations, resPayment, pod, creating, pvc, relay,
                 slots, guest, slotEpoch, final, epoch>>

MarkRefunded(p) ==
  /\ refund[p] = "pending"
  /\ refund' = [refund EXCEPT ![p] = "refunded"]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, reservations, resPayment, pod, creating, pvc, relay,
                 slots, guest, slotEpoch, final, epoch>>

(* ------------------------------------------------------------------ *)
(* Session lifecycle                                                   *)
(* ------------------------------------------------------------------ *)

\* PAID --provision_requested--> PROVISIONING. Effects: register the relay
\* entry, ensure the checkpoint workspaceset PVC, start the Pod.
Provision(s) ==
  /\ state[s] = "PAID"
  /\ reservations[s] = "ALLOCATED"
  /\ state' = [state EXCEPT ![s] = "PROVISIONING"]
  /\ relay' = [relay EXCEPT ![s] = TRUE]
  /\ pvc' = [pvc EXCEPT ![s] = TRUE]
  /\ UNCHANGED <<created, payOf, everReady, intent, intentEpoch, settledTo, charges,
                 refund, reservations, resPayment, pod, creating, slots, guest,
                 slotEpoch, final, epoch>>

\* The Kubernetes create succeeds. It is a separate step from the session row
\* update, so a crash here leaves an unrecorded Pod: `creating` is non-empty and
\* `pod` is not yet set.
CreatePod(s) ==
  /\ state[s] \in {"PROVISIONING", "RESUMING"}
  /\ reservations[s] = "ALLOCATED"
  /\ pod[s] = "none"
  /\ creating[s] = {}
  /\ \E n \in PodIds :
       creating' = [creating EXCEPT ![s] = {n}]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, reservations, resPayment, pod, pvc, relay,
                 slots, guest, slotEpoch, final, epoch>>

\* Persist the Pod name, or adopt the labelled Pod after a restart: either way
\* the instance moves from `creating` to `pod`.
RecordPod(s) ==
  /\ pod[s] = "none"
  /\ creating[s] # {}
  /\ \E n \in creating[s] :
       /\ pod' = [pod EXCEPT ![s] = n]
       /\ creating' = [creating EXCEPT ![s] = creating[s] \ {n}]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, reservations, resPayment, pvc, relay, slots,
                 guest, slotEpoch, final, epoch>>

\* guest_ready requires a Pod and a relay entry; the transition table refuses
\* READY otherwise.
GuestReady(s) ==
  /\ state[s] \in {"PROVISIONING", "RESUMING"}
  /\ pod[s] # "none"
  /\ relay[s]
  /\ state' = [state EXCEPT ![s] = "READY"]
  /\ everReady' = [everReady EXCEPT ![s] = TRUE]
  /\ UNCHANGED <<created, payOf, intent, intentEpoch, settledTo, charges, refund,
                 reservations, resPayment, pod, creating, pvc, relay, slots,
                 guest, slotEpoch, final, epoch>>

\* suspend_requested: stop the guest; the Pod and relay are cleaned up when the
\* guest reports stopped, not before.
SuspendRequest(s) ==
  /\ state[s] \in ReadyStates
  /\ pvc[s]
  /\ reservations[s] = "ALLOCATED"
  /\ state' = [state EXCEPT ![s] = "SUSPENDING"]
  /\ UNCHANGED <<created, payOf, everReady, intent, intentEpoch, settledTo, charges,
                 refund, reservations, resPayment, pod, creating, pvc, relay,
                 slots, guest, slotEpoch, final, epoch>>

\* guest_stopped: delete the Pod, purge the relay, keep the workspace, release
\* compute but keep storage.
GuestStopped(s) ==
  /\ state[s] = "SUSPENDING"
  /\ state' = [state EXCEPT ![s] = "SUSPENDED"]
  /\ pod' = [pod EXCEPT ![s] = "none"]
  /\ creating' = [creating EXCEPT ![s] = {}]
  /\ relay' = [relay EXCEPT ![s] = FALSE]
  /\ reservations' = [reservations EXCEPT ![s] = "SUSPENDED"]
  /\ slots' = [slots EXCEPT ![s] = {}]
  /\ guest' = [guest EXCEPT ![s] = {}]
  /\ UNCHANGED <<created, payOf, everReady, intent, intentEpoch, settledTo, charges,
                 refund, resPayment, pvc, slotEpoch, final, epoch>>

\* resume_requested: admission happens before the Pod is created; the session
\* stays SUSPENDED (and holds no compute) until it is admitted.
ResumeRequest(s) ==
  /\ state[s] = "SUSPENDED"
  /\ pvc[s]
  /\ reservations[s] = "SUSPENDED"
  /\ usedCompute < NodeCapacity
  /\ state' = [state EXCEPT ![s] = "RESUMING"]
  /\ reservations' = [reservations EXCEPT ![s] = "ALLOCATED"]
  /\ relay' = [relay EXCEPT ![s] = TRUE]
  /\ UNCHANGED <<created, payOf, everReady, intent, intentEpoch, settledTo, charges,
                 refund, resPayment, pod, creating, pvc, slots, guest, slotEpoch,
                 final, epoch>>

(* ------------------------------------------------------------------ *)
(* Termination, cleanup, release                                       *)
(* ------------------------------------------------------------------ *)

\* terminate_requested. Effects are performed by the termination use case; the
\* session only reaches a terminal state after they are observed complete.
RequestDestroy(s) ==
  /\ state[s] \in TerminableStates
  /\ state' = [state EXCEPT ![s] = "TERMINATING"]
  /\ final' = [final EXCEPT ![s] = "DESTROYED"]
  /\ UNCHANGED <<created, payOf, everReady, intent, intentEpoch, settledTo, charges,
                 refund, reservations, resPayment, pod, creating, pvc, relay,
                 slots, guest, slotEpoch, epoch>>

\* lease_expired, max lifetime or suspended expiry.
ExpireLease(s) ==
  /\ state[s] \in LeaseExpirableStates
  /\ state' = [state EXCEPT ![s] = "TERMINATING"]
  /\ final' = [final EXCEPT ![s] = "EXPIRED"]
  /\ UNCHANGED <<created, payOf, everReady, intent, intentEpoch, settledTo, charges,
                 refund, reservations, resPayment, pod, creating, pvc, relay,
                 slots, guest, slotEpoch, epoch>>

\* Relay loss fails the session closed: in-flight operations are abandoned, the
\* payment is kept (service was delivered), and the workload is torn down.
RelayLost(s) ==
  /\ relay[s]
  /\ state[s] \in {"PROVISIONING", "READY", "ACTIVE", "SUSPENDING", "RESUMING"}
  /\ state' = [state EXCEPT ![s] = "TERMINATING"]
  /\ relay' = [relay EXCEPT ![s] = FALSE]
  /\ slots' = [slots EXCEPT ![s] = {}]
  /\ guest' = [guest EXCEPT ![s] = {}]
  /\ final' = [final EXCEPT ![s] = "FAILED"]
  /\ UNCHANGED <<created, payOf, everReady, intent, intentEpoch, settledTo, charges,
                 refund, reservations, resPayment, pod, creating, pvc, slotEpoch,
                 epoch>>

\* Provisioning never completes (image pull, unschedulable, admission).
ProvisioningTimeout(s) ==
  /\ state[s] \in {"PAID", "PROVISIONING"}
  /\ state' = [state EXCEPT ![s] = "TERMINATING"]
  /\ final' = [final EXCEPT ![s] = "FAILED"]
  /\ UNCHANGED <<created, payOf, everReady, intent, intentEpoch, settledTo, charges,
                 refund, reservations, resPayment, pod, creating, pvc, relay,
                 slots, guest, slotEpoch, epoch>>

\* Delete the session's Pods. Deletion is by name for the recorded Pod and by
\* label for the crash-window instances, so both sets are cleared.
KillGuest(s) ==
  /\ state[s] = "TERMINATING"
  /\ podsAlive(s) # {}
  /\ pod' = [pod EXCEPT ![s] = "none"]
  /\ creating' = [creating EXCEPT ![s] = {}]
  /\ slots' = [slots EXCEPT ![s] = {}]
  /\ guest' = [guest EXCEPT ![s] = {}]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, reservations, resPayment, pvc, relay, slotEpoch,
                 final, epoch>>

DeleteWorkspace(s) ==
  /\ state[s] = "TERMINATING"
  /\ pvc[s]
  /\ pvc' = [pvc EXCEPT ![s] = FALSE]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, reservations, resPayment, pod, creating, relay,
                 slots, guest, slotEpoch, final, epoch>>

PurgeRelay(s) ==
  /\ state[s] = "TERMINATING"
  /\ relay[s]
  /\ relay' = [relay EXCEPT ![s] = FALSE]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, reservations, resPayment, pod, creating, pvc,
                 slots, guest, slotEpoch, final, epoch>>

\* capacity.beginRelease: capacity moves to RELEASING, not to free, as soon as
\* Pod deletion is requested. It is not returned until the Pod is gone.
BeginRelease(s) ==
  /\ state[s] = "TERMINATING"
  /\ reservations[s] \in {"ATTACHED", "ALLOCATED", "SUSPENDED"}
  /\ podsAlive(s) = {}
  /\ reservations' = [reservations EXCEPT ![s] = "RELEASING"]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, resPayment, pod, creating, pvc, relay, slots,
                 guest, slotEpoch, final, epoch>>

\* capacity.confirmRelease: the Pod is observed gone, so the capacity is free.
\* Driven by the reservation row, not the session state: the reaper confirms a
\* release even when the session already reached a terminal state.
ConfirmRelease(s) ==
  /\ reservations[s] = "RELEASING"
  /\ reservations' = [reservations EXCEPT ![s] = "RELEASED"]
  /\ resPayment' = [resPayment EXCEPT ![s] = "none"]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, pod, creating, pvc, relay, slots, guest,
                 slotEpoch, final, epoch>>

\* The termination use case runs cleanup before finalizeTermination. Gating the
\* write on the observed effects is the invariant this model is checking.
Finalize(s) ==
  /\ state[s] = "TERMINATING"
  /\ podsAlive(s) = {}
  /\ ~pvc[s]
  /\ ~relay[s]
  /\ reservations[s] \in {"RELEASING", "RELEASED"}
  /\ slots[s] = {}
  /\ guest[s] = {}
  /\ state' = [state EXCEPT ![s] = final[s]]
  /\ UNCHANGED <<created, payOf, everReady, intent, intentEpoch, settledTo, charges,
                 refund, reservations, resPayment, pod, creating, pvc, relay,
                 slots, guest, slotEpoch, final, epoch>>

(* ------------------------------------------------------------------ *)
(* Operation slot                                                      *)
(* ------------------------------------------------------------------ *)

\* store.claimOperation: the gate is checked and written atomically under
\* BEGIN IMMEDIATE, keyed by request id for idempotency.
StartOp(s, r) ==
  /\ state[s] \in ReadyStates
  /\ reservations[s] = "ALLOCATED"
  /\ slots[s] = {}
  /\ r \notin slots[s]
  /\ slots' = [slots EXCEPT ![s] = {r}]
  /\ slotEpoch' = [slotEpoch EXCEPT ![s] = epoch]
  /\ state' = [state EXCEPT ![s] = "ACTIVE"]
  /\ UNCHANGED <<created, payOf, everReady, intent, intentEpoch, settledTo, charges,
                 refund, reservations, resPayment, pod, creating, pvc, relay,
                 guest, final, epoch>>

\* The relay forwards the command to the guest, which has its own single-slot
\* gate. That gate is what stops overlapping work after a controller restart
\* abandons a request whose command is still running.
DispatchOp(s, r) ==
  /\ r \in slots[s]
  /\ guest[s] = {}
  /\ relay[s]
  /\ guest' = [guest EXCEPT ![s] = {r}]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, reservations, resPayment, pod, creating, pvc,
                 relay, slots, slotEpoch, final, epoch>>

GuestDone(s, r) ==
  /\ r \in guest[s]
  /\ guest' = [guest EXCEPT ![s] = {}]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, reservations, resPayment, pod, creating, pvc,
                 relay, slots, slotEpoch, final, epoch>>

\* store.finishOperation: clears the gate and returns the session to READY. A
\* finish cannot overtake the guest's own completion, so the command is never
\* still in flight on the wire.
FinishOp(s, r) ==
  /\ r \in slots[s]
  /\ r \notin guest[s]
  /\ slots' = [slots EXCEPT ![s] = {}]
  /\ state' = [state EXCEPT ![s] = IF state[s] = "ACTIVE" THEN "READY" ELSE state[s]]
  /\ UNCHANGED <<created, payOf, everReady, intent, intentEpoch, settledTo, charges,
                 refund, reservations, resPayment, pod, creating, pvc, relay,
                 guest, slotEpoch, final, epoch>>

\* store.recoverInterruptedOperations at startup: a request claimed before the
\* restart is abandoned and the gate is cleared, otherwise the paid session
\* stays `busy` forever.
RecoverInterruptedOp(s) ==
  /\ slotEpoch[s] < epoch
  /\ slots[s] # {}
  /\ slots' = [slots EXCEPT ![s] = {}]
  /\ state' = [state EXCEPT ![s] = IF state[s] = "ACTIVE" THEN "READY" ELSE state[s]]
  /\ UNCHANGED <<created, payOf, everReady, intent, intentEpoch, settledTo, charges,
                 refund, reservations, resPayment, pod, creating, pvc, relay,
                 guest, slotEpoch, final, epoch>>

CrashRestart ==
  /\ epoch < MaxRestarts
  /\ epoch' = epoch + 1
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, reservations, resPayment, pod, creating, pvc,
                 relay, slots, guest, slotEpoch, final>>

\* An idle tick. It exists so that quiescent states have a successor: TLC only
\* reports a liveness violation along a cycle, so a sink state with no self-loop
\* would hide every "eventually" that a terminal state fails. Stuttering is not
\* fair, so it cannot be used to dodge a weak-fairness obligation.
Stutter == UNCHANGED vars

(* ------------------------------------------------------------------ *)
(* Action groups (so verification/broken can substitute one at a time) *)
(* ------------------------------------------------------------------ *)

IntentActions == \E p \in Payments : ClaimIntent(p)

ReservationActions ==
  \/ \E s \in Sessions, p \in Payments : ReserveCapacity(s, p)
  \/ \E s \in Sessions, t \in Sessions, p \in Payments : RebindReservation(s, t, p)
  \/ \E s \in Sessions : AbandonReservation(s)

SettlementActions == \E s \in Sessions, p \in Payments : ChargeSession(s, p)

RefundActions ==
  \/ \E p \in Payments : MarkRefundPending(p)
  \/ \E p \in Payments : MarkRefunded(p)

PaymentActions ==
  IntentActions \/ ReservationActions \/ SettlementActions \/ RefundActions

ProvisionActions == \E s \in Sessions : Provision(s)

PodActions == \E s \in Sessions : CreatePod(s) \/ RecordPod(s) \/ GuestReady(s)

SuspendActions ==
  \E s \in Sessions : SuspendRequest(s) \/ GuestStopped(s) \/ ResumeRequest(s)

TerminateActions ==
  \E s \in Sessions : RequestDestroy(s) \/ ExpireLease(s) \/ RelayLost(s)
                      \/ ProvisioningTimeout(s)

CleanupActions ==
  \E s \in Sessions : KillGuest(s) \/ DeleteWorkspace(s) \/ PurgeRelay(s)
                      \/ BeginRelease(s) \/ ConfirmRelease(s)

FinalizeActions == \E s \in Sessions : Finalize(s)

LifecycleActions ==
  ProvisionActions \/ PodActions \/ SuspendActions \/ TerminateActions
  \/ CleanupActions \/ FinalizeActions \/ CrashRestart

OperationActions ==
  \/ \E s \in Sessions, r \in Requests : StartOp(s, r) \/ DispatchOp(s, r)
                                          \/ GuestDone(s, r) \/ FinishOp(s, r)
  \/ \E s \in Sessions : RecoverInterruptedOp(s)

Next == PaymentActions \/ LifecycleActions \/ OperationActions \/ Stutter

(* ------------------------------------------------------------------ *)
(* Invariants                                                          *)
(* ------------------------------------------------------------------ *)

\* The store's column domains. Catches a modelling slip that would otherwise
\* silently widen the state space.
TypeOK ==
  /\ created \subseteq Sessions
  /\ state \in [Sessions -> States]
  /\ payOf \in [Sessions -> Payments \cup {"none"}]
  /\ everReady \in [Sessions -> BOOLEAN]
  /\ intent \in [Payments -> {"none", "claimed", "settled"}]
  /\ intentEpoch \in [Payments -> 0 .. MaxRestarts]
  /\ settledTo \in [Payments -> Sessions \cup {"none"}]
  /\ charges \in [Payments -> 0 .. 1]
  /\ refund \in [Payments -> {"none", "pending", "refunded"}]
  /\ reservations \in [Sessions -> RStates]
  /\ resPayment \in [Sessions -> Payments \cup {"none"}]
  /\ pod \in [Sessions -> PodIds \cup {"none"}]
  /\ creating \in [Sessions -> SUBSET PodIds]
  /\ pvc \in [Sessions -> BOOLEAN]
  /\ relay \in [Sessions -> BOOLEAN]
  /\ slots \in [Sessions -> SUBSET Requests]
  /\ guest \in [Sessions -> SUBSET Requests]
  /\ slotEpoch \in [Sessions -> 0 .. MaxRestarts]
  /\ final \in [Sessions -> Finals]
  /\ epoch \in 0 .. MaxRestarts

\* A session row exists for every session the model talks about.
ExistingSessions == \A s \in Sessions : s \in created \/ state[s] = "CREATED"

\* I1. No double charge: one payment key writes at most one payment row, so a
\* retried or concurrently replayed settlement cannot charge twice.
NoDoubleCharge == \A p \in Payments : charges[p] <= 1

\* I2. Settlement is atomic with entitlement: a payment row always has its
\* ledger/session row, bound in the same commit.
SettlementAtomic ==
  \A p \in Payments :
    charges[p] = 1 =>
      /\ intent[p] = "settled"
      /\ settledTo[p] # "none"
      /\ settledTo[p] \in created
      /\ payOf[settledTo[p]] = p
      /\ state[settledTo[p]] # "CREATED"

\* I3. One payment key, one session: replaying a settlement with a different
\* session id cannot mint a second entitlement.
OneSessionPerPayment ==
  \A s, t \in Sessions :
    payOf[s] # "none" /\ payOf[s] = payOf[t] => s = t

\* I4. No two active operations on one session (controller gate).
SingleActiveOperation ==
  \A s \in Sessions : Cardinality(slots[s]) <= 1

\* I5. No two commands in flight at the guest, even when a controller restart
\* abandoned the request that started one.
SingleGuestOperation ==
  \A s \in Sessions : Cardinality(guest[s]) <= 1

\* I6. No operation slot survives a terminal state.
NoSlotAfterTerminal ==
  \A s \in Sessions : state[s] \in TerminalStates => slots[s] = {} /\ guest[s] = {}

\* I7. No orphaned Pod/PVC/relay after a terminal state.
NoOrphanedWorkloadAfterTerminal ==
  \A s \in Sessions :
    state[s] \in TerminalStates =>
      /\ podsAlive(s) = {}
      /\ ~pvc[s]
      /\ ~relay[s]

\* I8. At most one Pod per session: the crash window between create and record
\* must not leave a second, untracked Pod.
AtMostOnePod ==
  \A s \in Sessions : Cardinality(podsAlive(s)) <= 1

\* I9. No capacity over-reservation: the atomically admitted rows never exceed
\* the node, so two concurrent creates cannot both take the same free slot.
NoCapacityOverReservation == usedCompute <= NodeCapacity

\* I9b. RELEASING is entered only after the Pod is gone, which is what makes
\* holding capacity there conservative rather than a leak of a live Pod.
ReleasingAfterPodGone ==
  \A s \in Sessions : reservations[s] = "RELEASING" => podsAlive(s) = {}

\* I10. A terminal session holds no compute slot that could still be sold.
TerminalDoesNotHoldCompute ==
  \A s \in Sessions :
    state[s] \in TerminalStates => reservations[s] \in {"RELEASING", "RELEASED"}

\* I11. READY implies the workload and relay it promises.
ReadyImpliesPodAndRelay ==
  \A s \in Sessions :
    state[s] \in {"READY", "ACTIVE", "SUSPENDING"} => pod[s] # "none" /\ relay[s]

\* I12. SUSPENDED implies a checkpoint and no compute.
SuspendedImpliesCheckpoint ==
  \A s \in Sessions :
    state[s] = "SUSPENDED" => pvc[s] /\ pod[s] = "none" /\ ~relay[s]

\* I13. Every reservation is bound to a payment key.
ReservationBoundToPayment ==
  \A s \in Sessions :
    reservations[s] \in (ComputingRStates \cup {"SUSPENDED"}) => resPayment[s] # "none"

\* I14. A refund is only ever issued for a session that delivered no service.
RefundOnlyWhenNoService ==
  \A p \in Payments :
    refund[p] # "none" =>
      \E s \in Sessions :
        settledTo[p] = s /\ state[s] \in TerminalStates /\ ~everReady[s]

\* I15. A session that was never charged has no reservation and no workload.
NoEntitlementWithoutPayment ==
  \A s \in Sessions :
    state[s] # "CREATED" /\ s \in created => payOf[s] # "none"

(* ------------------------------------------------------------------ *)
(* Liveness (checked under the fairness below)                         *)
(* ------------------------------------------------------------------ *)

\* I16. No paid session is stuck before READY: every settled payment either
\* reaches a READY session or gets an explicit refund obligation.
PaidSessionProgress ==
  \A p \in Payments :
    (intent[p] = "settled")
      ~> (refund[p] # "none"
          \/ \E s \in Sessions : settledTo[p] = s /\ everReady[s])

\* I17. A terminal session eventually returns its capacity.
TerminalReleasesCapacity ==
  \A s \in Sessions :
    (state[s] \in TerminalStates) ~> (reservations[s] = "RELEASED")

\* I18. A slot claimed before a restart is eventually released. The gate stays
\* busy while a client has an operation in flight, so the property is scoped to
\* claims that the restart orphaned: without startup recovery the paid session
\* stays `busy` forever.
InterruptedSlotClears ==
  \A s \in Sessions :
    (slotEpoch[s] < epoch) ~> (slots[s] = {})

\* Fairness is split by subsystem so a deliberately broken variant can keep the
\* obligations of the actions it still has. Weak fairness is what turns "the
\* controller always gets another turn" into a checkable eventual property.
ProvisionFairness ==
  /\ \A s \in Sessions : WF_vars(Provision(s))
  /\ \A s \in Sessions : WF_vars(CreatePod(s))
  /\ \A s \in Sessions : WF_vars(RecordPod(s))
  /\ \A s \in Sessions : WF_vars(GuestReady(s))

CleanupFairness ==
  /\ \A s \in Sessions : WF_vars(KillGuest(s))
  /\ \A s \in Sessions : WF_vars(DeleteWorkspace(s))
  /\ \A s \in Sessions : WF_vars(PurgeRelay(s))
  /\ \A s \in Sessions : WF_vars(BeginRelease(s))
  /\ \A s \in Sessions : WF_vars(Finalize(s))

ReleaseFairness ==
  \A s \in Sessions : WF_vars(ConfirmRelease(s))

OperationFairness ==
  /\ \A s \in Sessions, r \in Requests : WF_vars(DispatchOp(s, r))
  /\ \A s \in Sessions, r \in Requests : WF_vars(GuestDone(s, r))
  /\ \A s \in Sessions, r \in Requests : WF_vars(FinishOp(s, r))
  /\ \A s \in Sessions : WF_vars(RecoverInterruptedOp(s))

RefundFairness ==
  /\ \A p \in Payments : WF_vars(MarkRefundPending(p))
  /\ \A p \in Payments : WF_vars(MarkRefunded(p))

Fairness ==
  ProvisionFairness /\ CleanupFairness /\ ReleaseFairness /\ OperationFairness
  /\ RefundFairness

Spec == Init /\ [][Next]_vars /\ Fairness

=============================================================================
