------------------------------ MODULE NoRelease ------------------------------
(*
 * Deliberately broken variant: the reaper never confirms a release. Capacity
 * stays reserved in RELEASING after the Pod is gone, so a terminal session
 * holds compute forever.
 *
 * ReleaseFairness is dropped with the action: keeping it would make every run
 * that skips the confirmation unfair, and TLC would have no counterexample.
 *
 * Isolated in verification/broken/; the good spec is ../SandboxSession.tla.
 *)
EXTENDS SandboxSession

BrokenCleanupActions ==
  \E s \in Sessions :
    KillGuest(s) \/ DeleteWorkspace(s) \/ PurgeRelay(s) \/ BeginRelease(s)

BrokenLifecycleActions ==
  ProvisionActions \/ PodActions \/ SuspendActions \/ TerminateActions
  \/ BrokenCleanupActions \/ FinalizeActions \/ CrashRestart

BrokenNext == PaymentActions \/ BrokenLifecycleActions \/ OperationActions \/ Stutter

BrokenFairness ==
  ProvisionFairness /\ CleanupFairness /\ OperationFairness /\ RefundFairness

BrokenSpec == Init /\ [][BrokenNext]_vars /\ BrokenFairness

=============================================================================
