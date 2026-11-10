------------------------------ MODULE OrphanPod ------------------------------
(*
 * Deliberately broken variant: termination finalizes the session without
 * waiting for the Pod, PVC and relay cleanup to be observed. The session
 * reaches DESTROYED while it still owns a Pod and a workspace.
 *
 * The good spec gates Finalize on those observations, matching the order in
 * controller/src/termination.ts. Isolated in verification/broken/.
 *)
EXTENDS SandboxSession

BrokenFinalize(s) ==
  /\ state[s] = "TERMINATING"
  \* Missing: podsAlive(s) = {} /\ ~pvc[s] /\ ~relay[s], and the slot/guest
  \* observations. finalizeTermination() itself only checks TERMINATING.
  /\ state' = [state EXCEPT ![s] = final[s]]
  /\ UNCHANGED <<created, payOf, everReady, intent, intentEpoch, settledTo, charges,
                 refund, reservations, resPayment, pod, creating, pvc, relay,
                 slots, guest, slotEpoch, final, epoch>>

BrokenFinalizeActions == \E s \in Sessions : BrokenFinalize(s)

BrokenLifecycleActions ==
  ProvisionActions \/ PodActions \/ SuspendActions \/ TerminateActions
  \/ CleanupActions \/ BrokenFinalizeActions \/ CrashRestart

BrokenNext == PaymentActions \/ BrokenLifecycleActions \/ OperationActions

BrokenSpec == Init /\ [][BrokenNext]_vars

=============================================================================
