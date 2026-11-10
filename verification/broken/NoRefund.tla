------------------------------ MODULE NoRefund ------------------------------
(*
 * Deliberately broken variant: the refund repair path is gone. A paid session
 * that terminates before READY is finalized and the payment is silently
 * retained, which is the "paid session stuck before READY" case the liveness
 * property PaidSessionProgress exists to catch.
 *
 * RefundFairness is dropped with the actions: keeping it would make every
 * run that skips the refund unfair, and TLC would have no counterexample.
 *
 * Isolated in verification/broken/; the good spec is ../SandboxSession.tla.
 *)
EXTENDS SandboxSession

BrokenNext ==
  IntentActions \/ ReservationActions \/ SettlementActions
  \/ LifecycleActions \/ OperationActions \/ Stutter

BrokenFairness ==
  ProvisionFairness /\ CleanupFairness /\ ReleaseFairness /\ OperationFairness

BrokenSpec == Init /\ [][BrokenNext]_vars /\ BrokenFairness

=============================================================================
