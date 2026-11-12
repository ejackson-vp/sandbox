------------------------------ MODULE SandboxSession ------------------------------
(*
 * Executable model of the sandbox control plane: session lifecycle, payment
 * intent, the single-operation slot, capacity reservation and the
 * execution-epoch fence, under client retries, controller crash/restart and
 * relay loss (with guest reconnect and the relay-loss grace).
 *
 * This is not a product specification. It is a bounded, deliberately abstract
 * model whose job is to check temporal invariants that example- and
 * property-based tests can only sample. Correspondence to the implementation:
 *
 *   shared/src/domain/session.ts              SOURCE_STATES, transition()
 *   shared/src/protocol/relay.ts              GuestStatusMessage
 *   controller/src/relay/registry.ts          the request frame's epoch and
 *                                             the forwarding floor
 *   guest/supervisor.go                       admitEpoch, publishStatus,
 *                                             the single guest slot
 *   controller/src/store.ts                   claimPaymentIntent,
 *                                             completeEntitlement,
 *                                             claimOperation, finishOperation,
 *                                             recoverInterruptedOperations,
 *                                             listFencedSessions, clearFencedGate,
 *                                             finalizeTermination
 *   controller/src/operation-fence.ts         OperationFence.reconcile
 *   controller/src/capacity/reservations.ts   admit, attachToSession, resume,
 *                                             beginRelease, confirmRelease
 *   controller/src/termination.ts             cleanup ordering before finalize
 *   controller/src/refunds.ts                 refund policy + reconcile
 *
 * Deliberate abstraction: there is one controller process (the store is the
 * single writer), so a crash is an epoch bump rather than a lost process; the
 * relay is a boolean ("this session is registered on the current relay
 * process") plus a pending-frame count; time is not modelled, so hold expiry,
 * lease expiry and the relay-loss grace are nondeterministic environment steps.
 *
 * Relay loss (ADR 0011) is three actions: RelayRestart drops the registration
 * and the guest link and fences any operation in flight (epoch bump + held
 * gate); ReregisterRelay puts the session back on the current generation;
 * RelayGraceExpired is the bounded-grace outcome, the only relay-loss path that
 * ends a session. A session that re-registers and reconnects keeps its lease.
 * The fence's disconnect release requires that no registration exists: once the
 * session is registered again, only the reconnected guest's idle status may
 * clear the gate.
 *
 * The fence (#19) is modelled as state, not as a call into OperationFence:
 *
 *   execEpoch      sessions.exec_epoch. Bumped by recoverInterruptedOperations
 *                  for a session whose gate is closed by an interrupted request.
 *   slotEpoch      the epoch of the request holding the gate. slotEpoch <
 *                  execEpoch means the gate is fenced by an older generation.
 *   guestStatus    the guest's last status frame: "unknown" (no report since
 *                  the guest connected), "idle", or a request id.
 *   guestEpoch     the guest's execution-epoch high-water mark (admitEpoch).
 *   startGen       the controller generation (epoch) that started the active
 *                  guest command. A command that is still running under a held
 *                  fence must have startGen < epoch: it started before recovery.
 *   fence          "none" -> "held" (recovery) -> "released" (OperationFence).
 *                  Only FenceRelease moves a held fence to released.
 *
 * The relay's execution-epoch floor is not a separate variable: recovery
 * publishes execEpoch to the relay before the fence clears, so "at or above
 * the floor" is exactly "slotEpoch >= execEpoch" in DispatchOp. A frame
 * forwarded before recovery and not yet observed is withdrawn by that publish
 * (the implementation resets the guest link); the model's DispatchOp cannot
 * take a slot below execEpoch, which is the same guarantee.
 *)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
  Sessions,      \* set of session identities the client may create
  Payments,      \* set of payment keys the client may retry with
  Requests,      \* set of operation (exec) request ids per session
  NodeCapacity,  \* compute slots on the (single) node, in reservation units
  MaxRestarts,   \* bound on controller crash/restart cycles
  MaxRelayRestarts, \* bound on relay restart cycles per bounded run
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

\* `final` is the terminal outcome chosen at termination. It matches `state`
\* except for RELAY_LOST: that is written as FAILED, but the reason is what the
\* refund policy keys on, so it is a distinct value here.
Finals == {"NONE", "DESTROYED", "EXPIRED", "FAILED", "RELAY_LOST"}

\* Session execution epochs. The store's exec_epoch starts at 1 and is bumped
\* once for a session that had an operation in flight across either a controller
\* restart or a relay restart, so a bounded run never needs more than
\* MaxRestarts + MaxRelayRestarts + 1 values.
Epochs == 1 .. MaxRestarts + MaxRelayRestarts + 1

\* A guest's high-water mark starts at 0 ("no epoch observed") and can reach
\* the largest session epoch.
HighWater == 0 .. MaxRestarts + MaxRelayRestarts + 1

\* The guest's own view of its single execution slot.
GuestStatuses == {"unknown", "idle"} \cup Requests

\* Only OperationFence clears a held fence. Termination abandons it ("none")
\* instead, because the guest is killed with the session.
FenceStates == {"none", "held", "released"}

VARIABLES
  created,        \* SUBSET Sessions                  session rows that exist
  state,          \* [Sessions -> States]
  payOf,          \* [Sessions -> Payments \cup {"none"}]
  everReady,      \* [Sessions -> BOOLEAN]            has the session ever been READY
  intent,         \* [Payments -> {"none", "claimed", "settled"}]
  intentEpoch,    \* [Payments -> 0..MaxRestarts]     epoch of the claim, for stale reclaim
  settledTo,      \* [Payments -> Sessions \cup {"none"}]
  charges,        \* [Payments -> 0..1]               payment rows written
  refund,         \* [Payments -> {"none", "pending", "refunded"}]
  reservations,   \* [Sessions -> RStates]
  resPayment,     \* [Sessions -> Payments \cup {"none"}]
  pod,            \* [Sessions -> PodIds \cup {"none"}]  Pod instance recorded on the session row
  creating,       \* [Sessions -> SUBSET PodIds]         Pod instances created, not yet recorded
  pvc,            \* [Sessions -> BOOLEAN]
  relay,          \* [Sessions -> BOOLEAN]
  slots,          \* [Sessions -> SUBSET Requests]       controller-side operation gate
  guest,          \* [Sessions -> SUBSET Requests]       guest-side in-flight command
  slotEpoch,      \* [Sessions -> Epochs]                epoch the gate was claimed in
  final,          \* [Sessions -> Finals]                terminal state chosen at termination
  epoch,          \* 0..MaxRestarts                      controller generation
  execEpoch,      \* [Sessions -> Epochs]                sessions.exec_epoch
  guestConnected, \* [Sessions -> BOOLEAN]               relay reports a live guest socket
  guestStatus,    \* [Sessions -> GuestStatuses]         guest's last status frame
  guestEpoch,     \* [Sessions -> HighWater]             guest epoch high-water mark
  admittedEpoch,  \* [Sessions -> HighWater]             epoch of the active guest command
  startGen,       \* [Sessions -> 0..MaxRestarts]        controller generation that started the active command
  relayPending,   \* [Sessions -> 0..1]                  frames awaiting a guest response
  fence,          \* [Sessions -> FenceStates]
  fenceReq,       \* [Sessions -> Requests \cup {"none"}] request the fence holds
  recovered       \* BOOLEAN                             startup recovery completed

vars ==
  <<created, state, payOf, everReady, intent, intentEpoch, settledTo, charges,
    refund, reservations, resPayment, pod, creating, pvc, relay, slots, guest,
    slotEpoch, final, epoch, execEpoch, guestConnected, guestStatus, guestEpoch,
    admittedEpoch, relayPending, fence, fenceReq, recovered, startGen>>

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

\* A gate whose request belongs to a controller generation older than the
\* session's current execution epoch. recoverInterruptedOperations creates it;
\* only the guest's status (or its disconnect) lets OperationFence clear it.
fenced(s) == fence[s] = "held"

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
  /\ slotEpoch = [s \in Sessions |-> 1]
  /\ final = [s \in Sessions |-> "NONE"]
  /\ epoch = 0
  /\ execEpoch = [s \in Sessions |-> 1]
  /\ guestConnected = [s \in Sessions |-> FALSE]
  /\ guestStatus = [s \in Sessions |-> "unknown"]
  /\ guestEpoch = [s \in Sessions |-> 0]
  /\ admittedEpoch = [s \in Sessions |-> 0]
  /\ startGen = [s \in Sessions |-> 0]
  /\ relayPending = [s \in Sessions |-> 0]
  /\ fence = [s \in Sessions |-> "none"]
  /\ fenceReq = [s \in Sessions |-> "none"]
  /\ recovered = TRUE

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
                 guest, slotEpoch, final, epoch, execEpoch, guestConnected,
                 guestStatus, guestEpoch, admittedEpoch, relayPending, fence,
                 fenceReq, recovered, startGen>>

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
                 slotEpoch, final, epoch, execEpoch, guestConnected, guestStatus,
                 guestEpoch, admittedEpoch, relayPending, fence, fenceReq,
                 recovered, startGen>>

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
                 slotEpoch, final, epoch, execEpoch, guestConnected, guestStatus,
                 guestEpoch, admittedEpoch, relayPending, fence, fenceReq,
                 recovered, startGen>>

\* A reservation whose payment was rejected is released without a session.
AbandonReservation(s) ==
  /\ reservations[s] = "ATTACHED"
  /\ s \notin created
  /\ reservations' = [reservations EXCEPT ![s] = "RELEASED"]
  /\ resPayment' = [resPayment EXCEPT ![s] = "none"]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, pod, creating, pvc, relay, slots, guest,
                 slotEpoch, final, epoch, execEpoch, guestConnected, guestStatus,
                 guestEpoch, admittedEpoch, relayPending, fence, fenceReq,
                 recovered, startGen>>

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
                 relay, slots, guest, slotEpoch, final, epoch, execEpoch,
                 guestConnected, guestStatus, guestEpoch, admittedEpoch,
                 relayPending, fence, fenceReq, recovered, startGen>>

\* refunds.ts: a settled session that never reached READY gets a refund
\* obligation, and so does a READY session ended by the relay-loss grace: the
\* paid time after the loss was undeliverable. A client destroy or an ordinary
\* lease expiry after READY stays settled. Mock mode settles immediately, real
\* modes wait for the worker. Recording the obligation is what makes the
\* outcome explicit.
MarkRefundPending(p) ==
  /\ refund[p] = "none"
  /\ charges[p] = 1
  /\ \E s \in Sessions :
       /\ settledTo[p] = s
       /\ state[s] \in TerminalStates
       /\ \/ ~everReady[s]
          \/ final[s] = "RELAY_LOST"
  /\ refund' = [refund EXCEPT ![p] = "pending"]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, reservations, resPayment, pod, creating, pvc, relay,
                 slots, guest, slotEpoch, final, epoch, execEpoch, guestConnected,
                 guestStatus, guestEpoch, admittedEpoch, relayPending, fence,
                 fenceReq, recovered, startGen>>

MarkRefunded(p) ==
  /\ refund[p] = "pending"
  /\ refund' = [refund EXCEPT ![p] = "refunded"]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, reservations, resPayment, pod, creating, pvc, relay,
                 slots, guest, slotEpoch, final, epoch, execEpoch, guestConnected,
                 guestStatus, guestEpoch, admittedEpoch, relayPending, fence,
                 fenceReq, recovered, startGen>>

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
                 slotEpoch, final, epoch, execEpoch, guestConnected, guestStatus,
                 guestEpoch, admittedEpoch, relayPending, fence, fenceReq,
                 recovered, startGen>>

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
                 slots, guest, slotEpoch, final, epoch, execEpoch, guestConnected,
                 guestStatus, guestEpoch, admittedEpoch, relayPending, fence,
                 fenceReq, recovered, startGen>>

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
                 guest, slotEpoch, final, epoch, execEpoch, guestConnected,
                 guestStatus, guestEpoch, admittedEpoch, relayPending, fence,
                 fenceReq, recovered, startGen>>

\* guest_ready requires a Pod and a relay entry; the transition table refuses
\* READY otherwise. The guest publishes its status on hello, so the relay now
\* has a status even when the slot is empty.
GuestReady(s) ==
  /\ state[s] \in {"PROVISIONING", "RESUMING"}
  /\ pod[s] # "none"
  /\ relay[s]
  /\ state' = [state EXCEPT ![s] = "READY"]
  /\ everReady' = [everReady EXCEPT ![s] = TRUE]
  /\ guestConnected' = [guestConnected EXCEPT ![s] = TRUE]
  /\ guestStatus' = [guestStatus EXCEPT ![s] = "idle"]
  /\ guestEpoch' = [guestEpoch EXCEPT ![s] = 0]
  /\ admittedEpoch' = [admittedEpoch EXCEPT ![s] = 0]
  /\ relayPending' = [relayPending EXCEPT ![s] = 0]
  /\ UNCHANGED <<created, payOf, intent, intentEpoch, settledTo, charges, refund,
                 reservations, resPayment, pod, creating, pvc, relay, slots,
                 guest, slotEpoch, final, epoch, execEpoch, fence, fenceReq,
                 recovered, startGen>>

\* suspend_requested: stop the guest; the Pod and relay are cleaned up when the
\* guest reports stopped, not before.
SuspendRequest(s) ==
  /\ state[s] \in ReadyStates
  /\ pvc[s]
  /\ reservations[s] = "ALLOCATED"
  /\ state' = [state EXCEPT ![s] = "SUSPENDING"]
  /\ UNCHANGED <<created, payOf, everReady, intent, intentEpoch, settledTo, charges,
                 refund, reservations, resPayment, pod, creating, pvc, relay, slots,
                 guest, slotEpoch, final, epoch, execEpoch, guestConnected,
                 guestStatus, guestEpoch, admittedEpoch, relayPending, fence,
                 fenceReq, recovered, startGen>>

\* guest_stopped: delete the Pod, purge the relay, keep the workspace, release
\* compute but keep storage. The guest process dies, so any command and any
\* fence die with it: termination/suspension abandons the fence ("none") rather
\* than claiming OperationFence released it.
GuestStopped(s) ==
  /\ state[s] = "SUSPENDING"
  /\ state' = [state EXCEPT ![s] = "SUSPENDED"]
  /\ pod' = [pod EXCEPT ![s] = "none"]
  /\ creating' = [creating EXCEPT ![s] = {}]
  /\ relay' = [relay EXCEPT ![s] = FALSE]
  /\ reservations' = [reservations EXCEPT ![s] = "SUSPENDED"]
  /\ slots' = [slots EXCEPT ![s] = {}]
  /\ guest' = [guest EXCEPT ![s] = {}]
  /\ guestConnected' = [guestConnected EXCEPT ![s] = FALSE]
  /\ guestStatus' = [guestStatus EXCEPT ![s] = "unknown"]
  /\ guestEpoch' = [guestEpoch EXCEPT ![s] = 0]
  /\ admittedEpoch' = [admittedEpoch EXCEPT ![s] = 0]
  /\ relayPending' = [relayPending EXCEPT ![s] = 0]
  /\ fence' = [fence EXCEPT ![s] = "none"]
  /\ fenceReq' = [fenceReq EXCEPT ![s] = "none"]
  /\ UNCHANGED <<created, payOf, everReady, intent, intentEpoch, settledTo, charges,
                 refund, resPayment, pvc, slotEpoch, final, epoch, execEpoch,
                 recovered, startGen>>

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
                 final, epoch, execEpoch, guestConnected, guestStatus, guestEpoch,
                 admittedEpoch, relayPending, fence, fenceReq, recovered, startGen>>

(* ------------------------------------------------------------------ *)
(* Guest connection and status                                         *)
(* ------------------------------------------------------------------ *)

\* A guest reconnects to an existing relay registration. The supervisor survives
\* the link loss, so its execution-epoch high-water mark survives too (ADR 0011)
\* and a frame below it is still rejected. It publishes an idle status on hello.
\* A fresh supervisor (first boot, resume) starts at 0 via GuestReady or
\* GuestStopped.
GuestConnect(s) ==
  /\ state[s] \in ReadyStates
  /\ relay[s]
  /\ ~guestConnected[s]
  /\ guest[s] = {}
  /\ guestConnected' = [guestConnected EXCEPT ![s] = TRUE]
  /\ guestStatus' = [guestStatus EXCEPT ![s] = "idle"]
  /\ admittedEpoch' = [admittedEpoch EXCEPT ![s] = 0]
  /\ relayPending' = [relayPending EXCEPT ![s] = 0]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, reservations, resPayment, pod, creating, pvc,
                 relay, slots, guest, slotEpoch, final, epoch, execEpoch, fence,
                 fenceReq, recovered, startGen, guestEpoch>>

\* The relay link drops. The link loss aborts the command it was carrying, so
\* the guest slot empties; the supervisor keeps its high-water mark and is
\* expected to reconnect (GuestConnect), so the fence does not treat this as
\* "the command is gone for good" while a registration still exists.
GuestDisconnect(s) ==
  /\ guestConnected[s]
  /\ guestConnected' = [guestConnected EXCEPT ![s] = FALSE]
  /\ guest' = [guest EXCEPT ![s] = {}]
  /\ guestStatus' = [guestStatus EXCEPT ![s] = "unknown"]
  /\ admittedEpoch' = [admittedEpoch EXCEPT ![s] = 0]
  /\ relayPending' = [relayPending EXCEPT ![s] = 0]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, reservations, resPayment, pod, creating, pvc,
                 relay, slots, slotEpoch, final, epoch, execEpoch, fence, fenceReq,
                 recovered, startGen, guestEpoch>>

\* The relay process is replaced: its in-memory registration is gone and every
\* guest socket on the shard drops. Any operation holding the gate is fenced
\* exactly like a controller restart (epoch bump, held gate); the session itself
\* stays READY/ACTIVE with its lease, Pod and workspace.
RelayRestart(s) ==
  /\ state[s] \in ReadyStates
  /\ relay[s]
  /\ \/ slots[s] = {}
     \/ execEpoch[s] < MaxRestarts + MaxRelayRestarts + 1
  /\ execEpoch' = [execEpoch EXCEPT ![s] =
        IF slots[s] # {} THEN execEpoch[s] + 1 ELSE execEpoch[s]]
  /\ fence' = [fence EXCEPT ![s] =
        IF slots[s] # {} THEN "held" ELSE fence[s]]
  /\ fenceReq' = [fenceReq EXCEPT ![s] =
        IF slots[s] # {} /\ fence[s] # "held"
        THEN CHOOSE r \in slots[s] : TRUE
        ELSE fenceReq[s]]
  /\ relay' = [relay EXCEPT ![s] = FALSE]
  /\ guest' = [guest EXCEPT ![s] = {}]
  /\ guestConnected' = [guestConnected EXCEPT ![s] = FALSE]
  /\ guestStatus' = [guestStatus EXCEPT ![s] = "unknown"]
  /\ admittedEpoch' = [admittedEpoch EXCEPT ![s] = 0]
  /\ relayPending' = [relayPending EXCEPT ![s] = 0]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, reservations, resPayment, pod, creating, pvc,
                 slots, slotEpoch, final, epoch, guestEpoch, recovered, startGen>>

\* The controller re-registers the session on the relay serving now, with the
\* token hash it already has. The guest can dial again after this step.
ReregisterRelay(s) ==
  /\ state[s] \in ReadyStates
  /\ ~relay[s]
  /\ relay' = [relay EXCEPT ![s] = TRUE]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, reservations, resPayment, pod, creating, pvc,
                 slots, guest, slotEpoch, final, epoch, execEpoch, guestConnected,
                 guestStatus, guestEpoch, admittedEpoch, relayPending, fence,
                 fenceReq, recovered, startGen>>

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
                 slots, guest, slotEpoch, epoch, execEpoch, guestConnected,
                 guestStatus, guestEpoch, admittedEpoch, relayPending, fence,
                 fenceReq, recovered, startGen>>

\* lease_expired, max lifetime or suspended expiry.
\*
\* A READY/ACTIVE session whose relay link is lost is not lease-expired: relay
\* recovery declares the loss at min(lostAt + grace, leaseExpiresAt - margin),
\* which is before `enforceLease` may run (leaseExpiresAt + leaseGraceMs), and
\* this guard is the abstraction of that ordering. The reason matters: the
\* refund policy compensates `relay_lost`, not an ordinary lease expiry.
ExpireLease(s) ==
  /\ state[s] \in LeaseExpirableStates
  /\ \/ state[s] \notin ReadyStates
     \/ (relay[s] /\ guestConnected[s])
  /\ state' = [state EXCEPT ![s] = "TERMINATING"]
  /\ final' = [final EXCEPT ![s] = "EXPIRED"]
  /\ UNCHANGED <<created, payOf, everReady, intent, intentEpoch, settledTo, charges,
                 refund, reservations, resPayment, pod, creating, pvc, relay,
                 slots, guest, slotEpoch, epoch, execEpoch, guestConnected,
                 guestStatus, guestEpoch, admittedEpoch, relayPending, fence,
                 fenceReq, recovered, startGen>>

\* The relay-loss grace expired: the guest did not reconnect inside the bound,
\* or the session had no registration left to reconnect to. This is the only
\* relay-loss path that ends a session, and it is distinct from a guest crash
\* (`failure:relay_lost`, not `guest_exited`). In-flight operations stay
\* `outcome_unknown`; the payment is kept because service was delivered.
RelayGraceExpired(s) ==
  /\ state[s] \in ReadyStates
  /\ \/ ~relay[s]
     \/ ~guestConnected[s]
  /\ state' = [state EXCEPT ![s] = "TERMINATING"]
  /\ relay' = [relay EXCEPT ![s] = FALSE]
  /\ slots' = [slots EXCEPT ![s] = {}]
  /\ guest' = [guest EXCEPT ![s] = {}]
  /\ guestConnected' = [guestConnected EXCEPT ![s] = FALSE]
  /\ guestStatus' = [guestStatus EXCEPT ![s] = "unknown"]
  /\ guestEpoch' = [guestEpoch EXCEPT ![s] = 0]
  /\ admittedEpoch' = [admittedEpoch EXCEPT ![s] = 0]
  /\ relayPending' = [relayPending EXCEPT ![s] = 0]
  /\ fence' = [fence EXCEPT ![s] = "none"]
  /\ fenceReq' = [fenceReq EXCEPT ![s] = "none"]
  /\ final' = [final EXCEPT ![s] = "RELAY_LOST"]
  /\ UNCHANGED <<created, payOf, everReady, intent, intentEpoch, settledTo, charges,
                 refund, reservations, resPayment, pod, creating, pvc, slotEpoch,
                 epoch, execEpoch, recovered, startGen>>

\* Provisioning never completes (image pull, unschedulable, admission).
ProvisioningTimeout(s) ==
  /\ state[s] \in {"PAID", "PROVISIONING"}
  /\ state' = [state EXCEPT ![s] = "TERMINATING"]
  /\ final' = [final EXCEPT ![s] = "FAILED"]
  /\ UNCHANGED <<created, payOf, everReady, intent, intentEpoch, settledTo, charges,
                 refund, reservations, resPayment, pod, creating, pvc, relay,
                 slots, guest, slotEpoch, epoch, execEpoch, guestConnected,
                 guestStatus, guestEpoch, admittedEpoch, relayPending, fence,
                 fenceReq, recovered, startGen>>

\* Delete the session's Pods. Deletion is by name for the recorded Pod and by
\* label for the crash-window instances, so both sets are cleared.
KillGuest(s) ==
  /\ state[s] = "TERMINATING"
  /\ podsAlive(s) # {}
  /\ pod' = [pod EXCEPT ![s] = "none"]
  /\ creating' = [creating EXCEPT ![s] = {}]
  /\ slots' = [slots EXCEPT ![s] = {}]
  /\ guest' = [guest EXCEPT ![s] = {}]
  /\ guestConnected' = [guestConnected EXCEPT ![s] = FALSE]
  /\ guestStatus' = [guestStatus EXCEPT ![s] = "unknown"]
  /\ guestEpoch' = [guestEpoch EXCEPT ![s] = 0]
  /\ admittedEpoch' = [admittedEpoch EXCEPT ![s] = 0]
  /\ relayPending' = [relayPending EXCEPT ![s] = 0]
  /\ fence' = [fence EXCEPT ![s] = "none"]
  /\ fenceReq' = [fenceReq EXCEPT ![s] = "none"]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, reservations, resPayment, pvc, relay, slotEpoch,
                 final, epoch, execEpoch, recovered, startGen>>

DeleteWorkspace(s) ==
  /\ state[s] = "TERMINATING"
  /\ pvc[s]
  /\ pvc' = [pvc EXCEPT ![s] = FALSE]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, reservations, resPayment, pod, creating, relay,
                 slots, guest, slotEpoch, final, epoch, execEpoch, guestConnected,
                 guestStatus, guestEpoch, admittedEpoch, relayPending, fence,
                 fenceReq, recovered, startGen>>

PurgeRelay(s) ==
  /\ state[s] = "TERMINATING"
  /\ relay[s]
  /\ relay' = [relay EXCEPT ![s] = FALSE]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, reservations, resPayment, pod, creating, pvc,
                 slots, guest, slotEpoch, final, epoch, execEpoch, guestConnected,
                 guestStatus, guestEpoch, admittedEpoch, relayPending, fence,
                 fenceReq, recovered, startGen>>

\* capacity.beginRelease: capacity moves to RELEASING, not to free, as soon as
\* Pod deletion is requested. It is not returned until the Pod is gone.
BeginRelease(s) ==
  /\ state[s] = "TERMINATING"
  /\ reservations[s] \in {"ATTACHED", "ALLOCATED", "SUSPENDED"}
  /\ podsAlive(s) = {}
  /\ reservations' = [reservations EXCEPT ![s] = "RELEASING"]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, resPayment, pod, creating, pvc, relay, slots,
                 guest, slotEpoch, final, epoch, execEpoch, guestConnected,
                 guestStatus, guestEpoch, admittedEpoch, relayPending, fence,
                 fenceReq, recovered, startGen>>

\* capacity.confirmRelease: the Pod is observed gone, so the capacity is free.
\* Driven by the reservation row, not the session state: the reaper confirms a
\* release even when the session already reached a terminal state.
ConfirmRelease(s) ==
  /\ reservations[s] = "RELEASING"
  /\ reservations' = [reservations EXCEPT ![s] = "RELEASED"]
  /\ resPayment' = [resPayment EXCEPT ![s] = "none"]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, pod, creating, pvc, relay, slots, guest,
                 slotEpoch, final, epoch, execEpoch, guestConnected, guestStatus,
                 guestEpoch, admittedEpoch, relayPending, fence, fenceReq,
                 recovered, startGen>>

\* The termination use case runs cleanup before finalizeTermination. Gating the
\* write on the observed effects is the invariant this model is checking. A
\* held fence is abandoned with the guest, so it must already be "none".
Finalize(s) ==
  /\ state[s] = "TERMINATING"
  /\ podsAlive(s) = {}
  /\ ~pvc[s]
  /\ ~relay[s]
  /\ ~guestConnected[s]
  /\ reservations[s] \in {"RELEASING", "RELEASED"}
  /\ slots[s] = {}
  /\ guest[s] = {}
  /\ fence[s] = "none"
  /\ state' = [state EXCEPT ![s] =
        IF final[s] = "RELAY_LOST" THEN "FAILED" ELSE final[s]]
  /\ UNCHANGED <<created, payOf, everReady, intent, intentEpoch, settledTo, charges,
                 refund, reservations, resPayment, pod, creating, pvc, relay,
                 slots, guest, slotEpoch, final, epoch, execEpoch, guestConnected,
                 guestStatus, guestEpoch, admittedEpoch, relayPending, fence,
                 fenceReq, recovered, startGen>>

(* ------------------------------------------------------------------ *)
(* Operation slot and the execution-epoch fence                        *)
(* ------------------------------------------------------------------ *)

\* store.claimOperation: the gate is checked and written atomically under
\* BEGIN IMMEDIATE, keyed by request id for idempotency. A claim records the
\* session's current execution epoch on the request and on the frame.
StartOp(s, r) ==
  /\ recovered
  /\ state[s] \in ReadyStates
  /\ reservations[s] = "ALLOCATED"
  /\ slots[s] = {}
  /\ ~fenced(s)
  /\ r \notin slots[s]
  /\ slots' = [slots EXCEPT ![s] = {r}]
  /\ slotEpoch' = [slotEpoch EXCEPT ![s] = execEpoch[s]]
  /\ state' = [state EXCEPT ![s] = "ACTIVE"]
  /\ fence' = [fence EXCEPT ![s] = "none"]
  /\ fenceReq' = [fenceReq EXCEPT ![s] = "none"]
  /\ UNCHANGED <<created, payOf, everReady, intent, intentEpoch, settledTo, charges,
                 refund, reservations, resPayment, pod, creating, pvc, relay,
                 guest, final, epoch, execEpoch, guestConnected, guestStatus,
                 guestEpoch, admittedEpoch, relayPending, recovered, startGen>>

\* The relay forwards the command to the guest, which takes its own single-slot
\* gate. A fenced request is never forwarded by the current controller: the
\* command, if it is still running, was forwarded before the crash.
\*
\* The frame's epoch is the claim's epoch (slotEpoch) and the relay's floor is
\* the session's current execEpoch (recovery publishes it before the fence can
\* clear). A frame claimed in an older generation can therefore never be
\* forwarded again: slotEpoch < execEpoch after recovery. That is the #88
\* contract the relay enforces, and it replaces the weaker #19 check against
\* the guest's own high-water mark.
DispatchOp(s, r) ==
  /\ recovered
  /\ r \in slots[s]
  /\ guest[s] = {}
  /\ relay[s]
  /\ guestConnected[s]
  /\ relayPending[s] = 0
  /\ ~fenced(s)
  /\ slotEpoch[s] >= execEpoch[s]
  /\ guest' = [guest EXCEPT ![s] = {r}]
  /\ guestStatus' = [guestStatus EXCEPT ![s] = r]
  /\ guestEpoch' = [guestEpoch EXCEPT ![s] = slotEpoch[s]]
  /\ admittedEpoch' = [admittedEpoch EXCEPT ![s] = slotEpoch[s]]
  /\ startGen' = [startGen EXCEPT ![s] = epoch]
  /\ relayPending' = [relayPending EXCEPT ![s] = 1]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, reservations, resPayment, pod, creating, pvc,
                 relay, slots, slotEpoch, final, epoch, execEpoch, guestConnected,
                 fence, fenceReq, recovered>>

\* The guest replies; the relay records the response and drops the frame from
\* its pending set. The guest's slot is released in GuestDone, and the fence
\* requires both observations before it clears.
GuestResponse(s, r) ==
  /\ r \in guest[s]
  /\ relayPending[s] = 1
  /\ relayPending' = [relayPending EXCEPT ![s] = 0]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, reservations, resPayment, pod, creating, pvc,
                 relay, slots, guest, slotEpoch, final, epoch, execEpoch,
                 guestConnected, guestStatus, guestEpoch, admittedEpoch, fence,
                 fenceReq, recovered, startGen>>

\* The guest releases its single slot and publishes an idle status. The response
\* is sent before the idle status (the supervisor replies, then releases the
\* slot in its defer), so the relay's pending frame is already gone here. That
\* status is what lets OperationFence clear a held gate.
GuestDone(s, r) ==
  /\ r \in guest[s]
  /\ relayPending[s] = 0
  /\ guest' = [guest EXCEPT ![s] = {}]
  /\ guestStatus' = [guestStatus EXCEPT ![s] = "idle"]
  /\ admittedEpoch' = [admittedEpoch EXCEPT ![s] = 0]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, reservations, resPayment, pod, creating, pvc,
                 relay, slots, slotEpoch, final, epoch, execEpoch, guestConnected,
                 guestEpoch, relayPending, fence, fenceReq, recovered, startGen>>

\* store.finishOperation: clears the gate and returns the session to READY. It
\* is the current controller's completion path, so it must not touch a gate
\* held by a recovery fence: only FenceRelease may clear that one.
FinishOp(s, r) ==
  /\ recovered
  /\ r \in slots[s]
  /\ r \notin guest[s]
  /\ ~fenced(s)
  /\ slots' = [slots EXCEPT ![s] = {}]
  /\ state' = [state EXCEPT ![s] = IF state[s] = "ACTIVE" THEN "READY" ELSE state[s]]
  /\ fence' = [fence EXCEPT ![s] = "none"]
  /\ fenceReq' = [fenceReq EXCEPT ![s] = "none"]
  /\ UNCHANGED <<created, payOf, everReady, intent, intentEpoch, settledTo, charges,
                 refund, reservations, resPayment, pod, creating, pvc, relay,
                 guest, slotEpoch, final, epoch, execEpoch, guestConnected,
                 guestStatus, guestEpoch, admittedEpoch, relayPending, recovered, startGen>>

\* OperationFence.reconcile, the only action that releases a recovery fence.
\* It requires the gate it is holding, no relay frame still awaiting a guest
\* response, and either the reconnected guest's own idle status or a session
\* that has no registration left (the guest is not expected back, and the link
\* loss already aborted the command). A registered session with no connected
\* guest waits for the reconnect: ADR 0011 replaced "the supervisor exits with
\* its link" with "the same supervisor reconnects". A connected guest that has
\* never reported status ("unknown") keeps the gate closed too.
FenceRelease(s) ==
  /\ recovered
  /\ fenced(s)
  /\ slots[s] = {fenceReq[s]}
  /\ relayPending[s] = 0
  /\ \/ /\ ~guestConnected[s]
        /\ ~relay[s]
     \/ /\ guestConnected[s]
        /\ guestStatus[s] = "idle"
  /\ slots' = [slots EXCEPT ![s] = {}]
  /\ state' = [state EXCEPT ![s] = IF state[s] = "ACTIVE" THEN "READY" ELSE state[s]]
  /\ fence' = [fence EXCEPT ![s] = "released"]
  /\ UNCHANGED <<created, payOf, everReady, intent, intentEpoch, settledTo, charges,
                 refund, reservations, resPayment, pod, creating, pvc, relay,
                 guest, slotEpoch, final, epoch, execEpoch, guestConnected,
                 guestStatus, guestEpoch, admittedEpoch, relayPending, fenceReq,
                 recovered, startGen>>

\* store.recoverInterruptedOperations at startup: mark the pending request
\* `outcome_unknown`, bump the session execution epoch, and leave the gate
\* closed. The request holding the gate is now a fence, not a lost operation.
\* OperationFence publishes the bumped epoch to the relay (the floor) before it
\* may clear the fence, which is why DispatchOp compares against execEpoch.
\* Recovery is one transaction over all sessions, so it is a single step here.
RecoverInterruptedOps ==
  /\ ~recovered
  /\ recovered' = TRUE
  /\ execEpoch' = [s \in Sessions |->
        IF slots[s] # {} THEN execEpoch[s] + 1 ELSE execEpoch[s]]
  /\ fence' = [s \in Sessions |->
        IF slots[s] # {} THEN "held" ELSE fence[s]]
  /\ fenceReq' = [s \in Sessions |->
        IF slots[s] # {} /\ fence[s] # "held"
        THEN CHOOSE r \in slots[s] : TRUE
        ELSE fenceReq[s]]
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, reservations, resPayment, pod, creating, pvc,
                 relay, slots, guest, slotEpoch, final, epoch, guestConnected,
                 guestStatus, guestEpoch, admittedEpoch, relayPending, startGen>>

\* A frame from an older controller generation, carrying an epoch below the
\* session's execution epoch (the relay's floor). The relay rejects it with
\* `stale_epoch` and withdraws a frame that was already forwarded but not
\* observed, so this action records no transition. The StaleEpoch variant
\* removes the floor check; TLC then falsifies NoStaleFrameStarts.
RejectStaleFrame(s) ==
  /\ guestConnected[s]
  /\ guest[s] = {}
  /\ \E e \in Epochs : e < execEpoch[s]
  /\ UNCHANGED vars

CrashRestart ==
  /\ recovered
  /\ epoch < MaxRestarts
  /\ epoch' = epoch + 1
  /\ recovered' = FALSE
  /\ UNCHANGED <<created, state, payOf, everReady, intent, intentEpoch, settledTo,
                 charges, refund, reservations, resPayment, pod, creating, pvc,
                 relay, slots, guest, slotEpoch, final, execEpoch, guestConnected,
                 guestStatus, guestEpoch, admittedEpoch, relayPending, fence,
                 fenceReq, startGen>>

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

ConnectionActions ==
  \E s \in Sessions : GuestConnect(s) \/ GuestDisconnect(s) \/ ReregisterRelay(s)

SuspendActions ==
  \E s \in Sessions : SuspendRequest(s) \/ GuestStopped(s) \/ ResumeRequest(s)

TerminateActions ==
  \E s \in Sessions : RequestDestroy(s) \/ ExpireLease(s) \/ RelayGraceExpired(s)
                      \/ ProvisioningTimeout(s)

CleanupActions ==
  \E s \in Sessions : KillGuest(s) \/ DeleteWorkspace(s) \/ PurgeRelay(s)
                      \/ BeginRelease(s) \/ ConfirmRelease(s)

FinalizeActions == \E s \in Sessions : Finalize(s)

LifecycleActions ==
  ProvisionActions \/ PodActions \/ SuspendActions \/ TerminateActions
  \/ CleanupActions \/ FinalizeActions \/ CrashRestart

OperationActions ==
  \/ \E s \in Sessions, r \in Requests :
       StartOp(s, r) \/ DispatchOp(s, r) \/ GuestResponse(s, r)
       \/ GuestDone(s, r) \/ FinishOp(s, r)
  \/ \E s \in Sessions : FenceRelease(s) \/ RejectStaleFrame(s)

RecoveryActions == RecoverInterruptedOps

Next ==
  PaymentActions \/ LifecycleActions \/ ConnectionActions \/ OperationActions
  \/ RecoveryActions \/ Stutter

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
  /\ slotEpoch \in [Sessions -> Epochs]
  /\ final \in [Sessions -> Finals]
  /\ epoch \in 0 .. MaxRestarts
  /\ execEpoch \in [Sessions -> Epochs]
  /\ guestConnected \in [Sessions -> BOOLEAN]
  /\ guestStatus \in [Sessions -> GuestStatuses]
  /\ guestEpoch \in [Sessions -> HighWater]
  /\ admittedEpoch \in [Sessions -> HighWater]
  /\ startGen \in [Sessions -> 0 .. MaxRestarts]
  /\ relayPending \in [Sessions -> 0 .. 1]
  /\ fence \in [Sessions -> FenceStates]
  /\ fenceReq \in [Sessions -> Requests \cup {"none"}]
  /\ recovered \in BOOLEAN

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

\* I5b. The guest only ever runs a request the controller gate still names. A
\* fenced request remains named until the fence releases, and a stale frame
\* (below the guest's epoch high-water) is rejected without taking the slot.
GuestRunsGateHeldRequest ==
  \A s \in Sessions : guest[s] \subseteq slots[s]

\* I5c. A stale frame never starts: any command active at the guest carries an
\* epoch at least as high as the guest's high-water mark. The guest's
\* admitEpoch is what enforces this; the StaleEpoch variant removes it.
StaleFrameNeverStarts ==
  \A s \in Sessions : guest[s] # {} => admittedEpoch[s] >= guestEpoch[s]

\* I5d. A command is only ever started under the session epoch its generation
\* claimed it in. If recovery has since bumped execEpoch, the active command
\* must have been started by an earlier controller generation (startGen <
\* epoch). The relay's epoch floor is what enforces this: after recovery it
\* refuses and withdraws every frame below execEpoch. The StaleEpoch variant
\* models the pre-#88 check against guestEpoch, which lets a frame claimed in
\* an older generation take the slot after recovery, and falsifies this.
NoStaleFrameStarts ==
  \A s \in Sessions :
    guest[s] # {} /\ admittedEpoch[s] < execEpoch[s] => startGen[s] < epoch

\* I6. No operation slot, guest command or fence survives a terminal state.
NoSlotAfterTerminal ==
  \A s \in Sessions :
    state[s] \in TerminalStates =>
      slots[s] = {} /\ guest[s] = {} /\ fence[s] = "none"

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

\* I11. READY implies the workload it promises. It no longer implies a relay
\* registration: a relay restart drops that for as long as the reconnect takes,
\* which is exactly the window RelayGraceExpired bounds.
ReadyImpliesPod ==
  \A s \in Sessions :
    state[s] \in {"READY", "ACTIVE", "SUSPENDING"} => pod[s] # "none"

\* I12. SUSPENDED implies a checkpoint, no compute, and no live guest.
SuspendedImpliesCheckpoint ==
  \A s \in Sessions :
    state[s] = "SUSPENDED" =>
      pvc[s] /\ pod[s] = "none" /\ ~relay[s] /\ ~guestConnected[s]

\* I13. Every reservation is bound to a payment key.
ReservationBoundToPayment ==
  \A s \in Sessions :
    reservations[s] \in (ComputingRStates \cup {"SUSPENDED"}) => resPayment[s] # "none"

\* I14. A refund is only ever issued for a session that delivered no service, or
\* for one whose service was cut short by relay loss. A client destroy and an
\* ordinary lease expiry after READY stay settled.
RefundOnlyWhenNoServiceOrRelayLoss ==
  \A p \in Payments :
    refund[p] # "none" =>
      \E s \in Sessions :
        settledTo[p] = s /\ state[s] \in TerminalStates
          /\ (~everReady[s] \/ final[s] = "RELAY_LOST")

\* I15. A session that was never charged has no reservation and no workload.
NoEntitlementWithoutPayment ==
  \A s \in Sessions :
    state[s] # "CREATED" /\ s \in created => payOf[s] # "none"

\* I16. A held fence names exactly the request that still holds the gate.
FenceHoldsTheGate ==
  \A s \in Sessions : fenced(s) => slots[s] = {fenceReq[s]}

\* I17. While a fence is held, the only command allowed to be in flight at the
\* guest is the fenced request itself: no new command overlaps the old one.
NoNewCommandOverlapsFence ==
  \A s \in Sessions : fenced(s) => guest[s] \subseteq {fenceReq[s]}

\* I18. A fence is never released while the guest reports the fenced request
\* active. OperationFence releases only on an idle status or a lost guest; the
\* FenceRelease variant removes that check and TLC falsifies this invariant.
NoPrematureFenceRelease ==
  \A s \in Sessions :
    fence[s] = "released" => fenceReq[s] \notin guest[s]

(* ------------------------------------------------------------------ *)
(* Liveness (checked under the fairness below)                         *)
(* ------------------------------------------------------------------ *)

\* I19. No paid session is stuck before READY: every settled payment either
\* reaches a READY session or gets an explicit refund obligation.
PaidSessionProgress ==
  \A p \in Payments :
    (intent[p] = "settled")
      ~> (refund[p] # "none"
          \/ \E s \in Sessions : settledTo[p] = s /\ everReady[s])

\* I20. A terminal session eventually returns its capacity.
TerminalReleasesCapacity ==
  \A s \in Sessions :
    (state[s] \in TerminalStates) ~> (reservations[s] = "RELEASED")

\* I21. A fenced gate eventually clears once the guest reports its slot idle or
\* the guest is gone. A connected guest that has never reported status is
\* deliberately outside the antecedent: the fence fails closed there.
FencedGateClears ==
  \A s \in Sessions :
    (fenced(s) /\ (guestStatus[s] = "idle" \/ ~guestConnected[s]))
      ~> ~fenced(s)

\* Fairness is split by subsystem so a deliberately broken variant can keep the
\* obligations of the actions it still has. Weak fairness is what turns "the
\* controller always gets another turn" into a checkable eventual property.
ProvisionFairness ==
  /\ \A s \in Sessions : WF_vars(Provision(s))
  /\ \A s \in Sessions : WF_vars(CreatePod(s))
  /\ \A s \in Sessions : WF_vars(RecordPod(s))
  /\ \A s \in Sessions : WF_vars(GuestReady(s))

SuspendFairness ==
  \A s \in Sessions : WF_vars(GuestStopped(s))

\* A guest that can reconnect does, and the controller re-registers a session
\* whose registration was lost. Without this, a held relay-loss fence would be
\* reported as a liveness violation rather than as a stutter.
ConnectionFairness ==
  /\ \A s \in Sessions : WF_vars(GuestConnect(s))
  /\ \A s \in Sessions : WF_vars(ReregisterRelay(s))

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
  /\ \A s \in Sessions, r \in Requests : WF_vars(GuestResponse(s, r))
  /\ \A s \in Sessions, r \in Requests : WF_vars(GuestDone(s, r))
  /\ \A s \in Sessions, r \in Requests : WF_vars(FinishOp(s, r))
  \* Strong fairness: the release condition alternates as a guest reconnects and
  \* drops again. The reconciler retries every tick, so a gate that is repeatedly
  \* releasable is released; weak fairness alone leaves a fair connect/disconnect
  \* cycle that starves the release.
  /\ \A s \in Sessions : SF_vars(FenceRelease(s))

RecoveryFairness == WF_vars(RecoverInterruptedOps)

RefundFairness ==
  /\ \A p \in Payments : WF_vars(MarkRefundPending(p))
  /\ \A p \in Payments : WF_vars(MarkRefunded(p))

Fairness ==
  ProvisionFairness /\ SuspendFairness /\ ConnectionFairness /\ CleanupFairness
  /\ ReleaseFairness /\ OperationFairness /\ RecoveryFairness /\ RefundFairness

Spec == Init /\ [][Next]_vars /\ Fairness

=============================================================================
