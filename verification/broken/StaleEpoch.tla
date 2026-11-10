------------------------------ MODULE StaleEpoch ------------------------------
(*
 * Deliberately broken variant: a frame claimed in an older controller
 * generation can still take the guest slot after recovery.
 *
 * This is the pre-#88 contract. `admitEpoch` compared the frame epoch only with
 * the guest's own high-water mark (`guestEpoch`), and the relay forwarded the
 * frame without a session-epoch floor. After `recoverInterruptedOperations`
 * bumps `execEpoch`, a request claimed in generation 1 that the guest has never
 * observed (guestEpoch 0 or 1) still passes, because the guest has no notion of
 * `sessions.exec_epoch`.
 *
 * The broken action also drops DispatchOp's `~fenced` guard: the guest does not
 * see the controller's fence, so a frame forwarded before the crash can start
 * while OperationFence still holds the gate. That is exactly the window
 * NoStaleFrameStarts closes: the command started by a later generation
 * (startGen = epoch) while its epoch is below execEpoch.
 *
 * Isolated in verification/broken/; the good spec is ../SandboxSession.tla.
 *)
EXTENDS SandboxSession

BrokenDispatchOp(s, r) ==
  /\ recovered
  /\ r \in slots[s]
  /\ guest[s] = {}
  /\ relay[s]
  /\ guestConnected[s]
  /\ relayPending[s] = 0
  \* Missing: the relay's session-epoch floor (`slotEpoch >= execEpoch`), and
  \* the current controller's `~fenced` guard. Only the guest's own high-water
  \* mark is compared, so a superseded generation's frame still starts.
  /\ slotEpoch[s] >= guestEpoch[s]
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

BrokenOperationActions ==
  \/ \E s \in Sessions, r \in Requests :
       StartOp(s, r) \/ BrokenDispatchOp(s, r) \/ GuestResponse(s, r)
       \/ GuestDone(s, r) \/ FinishOp(s, r)
  \/ \E s \in Sessions : FenceRelease(s)

BrokenNext ==
  PaymentActions \/ LifecycleActions \/ ConnectionActions
  \/ BrokenOperationActions \/ RecoveryActions \/ Stutter

BrokenSpec == Init /\ [][BrokenNext]_vars

=============================================================================
