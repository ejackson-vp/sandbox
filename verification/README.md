# Executable model of the control-plane state machines

`shared/src/domain/session.ts` is a pure transition table with property tests,
and `controller/src/store.ts` generates its SQL guards from `SOURCE_STATES`.
Those tests sample. Payment intents, the single-operation slot, the
execution-epoch recovery fence and capacity reservations add concurrency, and
the invariants that matter there are temporal: they must hold after *every*
crash, retry and relay loss, not after the schedules a generator happened to
pick.

This directory holds a TLA+ spec of that control plane and a TLC configuration
that checks it exhaustively over a bounded model. It is additive verification:
no product code is imported or changed.

```text
verification/
  SandboxSession.tla     the model: lifecycle, intent, slot, epoch fence,
                         guest status, reservation
  SandboxSession.cfg     main bounded run  (1 session, 1 payment, 1 request,
                         1 restart, 1-slot node) - all invariants + liveness
  SandboxSessionTight.cfg capacity pressure (2 sessions, 1-slot node, 2 requests,
                         2 restarts) - all invariants, safety only
  run-tlc.sh             pinned runner: good spec must pass, broken must fail
  broken/                deliberately broken variants, each with its own cfg
```

## Running it

```bash
make verify-model                    # good spec passes, every broken variant is rejected
./verification/run-tlc.sh --good-only
./verification/run-tlc.sh --broken-only
```

The runner needs Java 11+ and either network access or a cached jar:

- `verification/.cache/tla2tools-1.7.4.jar` is downloaded on first use and
  verified against
  `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`
  (TLC 2.19, `tla2tools` v1.7.4).
- Set `TLA2TOOLS_JAR=/path/to/tla2tools.jar` to use a jar you already have. Its
  checksum is still verified, so the version is pinned either way.
- `TLC_WORKERS` (default 4) and `TLA2TOOLS_CACHE` are the other knobs.

If `java` is missing the runner exits with an explicit message; it never claims
a pass it did not observe. The main liveness run is small (one session, one
request); the capacity/safety run is the larger one and takes about a minute on
a laptop. TLC's output names the invariant when one fails.

The model is bounded by the constants in each `.cfg`: `Sessions`, `Payments`,
`Requests`, `NodeCapacity`, `MaxRestarts`, `MaxRelayRestarts`, `PodIds`. Bounds
are what make the state space finite; they are not claims about production
sizing.

## What is modeled

| Subsystem | Implementation | Modeled as |
|---|---|---|
| Session lifecycle | `SOURCE_STATES`, `transition()` | `state` over the 12 states, one action per event, with the same source states and the same `hasPod`/`hasRelay`/`hasPvc` guards |
| Payment intent | `claimPaymentIntent`, `completeEntitlement`, `recoverInterruptedOperations` | `intent`, `intentEpoch`, `settledTo`, `charges`; a claim is reclaimable only from an older controller epoch |
| Ledger and refunds | `payment_ledger`, `RefundService` | `charges` (one row per key), `refund` in `none -> pending -> refunded`, set only for a terminal session that was never READY |
| Operation slot | `claimOperation`, `finishOperation` | `slots` (controller gate) and `guest` (the guest's own gate), keyed by request id; `slotEpoch` is the epoch the gate was claimed in |
| Execution-epoch fence | `recoverInterruptedOperations`, `recoverSessionOperation`, `listFencedSessions`, `clearFencedGate`, `OperationFence.reconcile`, `relay/registry.ts` `raiseEpoch`/`request`, `guest/supervisor.go` `admitEpoch`/`publishStatus` | `execEpoch`, `fence`, `fenceReq`, `guestStatus`, `guestEpoch`, `admittedEpoch`, `startGen`, `relayPending`: recovery (controller restart or relay restart) bumps the epoch and holds the gate; only `FenceRelease` clears it, on the reconnected guest's idle status or on a session with no registration left; the relay refuses and withdraws frames below `execEpoch`, and the guest rejects a frame below its own high-water |
| Capacity reservation | `admit`, `attachToSession`, `resume`, `beginRelease`, `confirmRelease` | `reservations` over `NONE/ATTACHED/ALLOCATED/SUSPENDED/RELEASING/RELEASED`, plus `usedCompute` |
| Provisioning | `Provisioning.provision`, `deletePod`, PVC lifecycle | `pod` (recorded instance), `creating` (created by Kubernetes, not yet recorded), `pvc`, `relay`, `guestConnected` |
| Relay restart | `RelayRecovery.reconcile`, `RelayClient.registerCurrent`, `guest` reconnect loop | `RelayRestart` drops the registration and the guest link and fences an in-flight operation (epoch bump, held gate); `ReregisterRelay` restores the registration; `GuestConnect` keeps the supervisor's high-water mark; `RelayGraceExpired` is the bounded-grace outcome (`failure:relay_lost`) |
| Faults | control-plane fault harness | `CrashRestart` bumps `epoch` and forces startup recovery; `GuestDisconnect` drops the relay link without failing the session; `ProvisioningTimeout`; client retries are ordinary re-enabled actions |

Three modelling choices are worth calling out because they are what make the
interesting traces reachable:

- A Pod create and the session-row update that names it are separate steps, so
  `creating` can hold a Pod the row does not know about. That is the crash
  window `Provisioning.provision` closes by listing and adopting labelled Pods.
- `BeginRelease` moves `ALLOCATED` (and `SUSPENDED`) rows to `RELEASING`, and
  `usedCompute` counts only `ATTACHED` and `ALLOCATED`. See the note on
  `holdsCompute` under [Findings](#findings).
- A relay restart is a registration loss plus a link drop, and it is separate
  from the session lifecycle: `RelayRestart` keeps `state`, `pod`, `pvc` and the
  reservation, so the survivor trace is reachable. `RelayGraceExpired` is the
  only action that ends a session because of the relay, and it is
  nondeterministic because the grace is time, which the model does not have.
- A "stale frame" is a frame whose epoch is below the session's `exec_epoch`.
  Recovery publishes that epoch to the relay before the fence can clear, so the
  relay refuses the frame and withdraws one it already forwarded (the
  implementation resets the guest link, discarding unread bytes). `DispatchOp`
  therefore requires `slotEpoch >= execEpoch`. The guest's own high-water
  check (`guestEpoch`) remains as defence in depth for a frame a restarted
  guest reads before any recovery epoch. See [Findings](#findings) for the
  residual, which is a frame the guest has already read.

Time is not modeled. Hold expiry, lease expiry and suspended expiry are
nondeterministic environment steps, which is the strongest schedule (any
interleaving may happen) and avoids a clock abstraction the invariants do not
need.

## Invariants

Each name below is checked in both good configs unless marked otherwise.
`I19`-`I21` are temporal and are checked in `SandboxSession.cfg`; the
capacity config is safety-only because fairness makes its graph much larger.
The main config uses a single request id and one session, so the slot and fence
invariants are exercised non-vacuously by `SandboxSessionTight.cfg` (two
sessions, two request ids, two restarts) and by the `SlotRace`, `FenceRelease`
and `StaleEpoch` variants.

| ID | Name | Meaning | Why it matters |
|---|---|---|---|
| — | `TypeOK` | Every variable stays inside its column domain. | Catches a modelling slip that would otherwise silently widen the state space. |
| — | `ExistingSessions` | A session outside `created` is still the `CREATED` placeholder. | A session row cannot vanish under a reservation. |
| I1 | `NoDoubleCharge` | `charges[p] <= 1` for every payment key. | A retried or replayed settlement never charges twice. |
| I2 | `SettlementAtomic` | A payment row always has its ledger/session row, bound in the same commit. | Money is never recorded without an entitlement (the `completeEntitlement` transaction). |
| I3 | `OneSessionPerPayment` | Two sessions cannot share a payment key. | A retry with a different session id cannot mint a second entitlement. |
| I4 | `SingleActiveOperation` | At most one controller slot per session. | The single-operation contract; `claimOperation` enforces it under `BEGIN IMMEDIATE`. |
| I5 | `SingleGuestOperation` | At most one command in flight at the guest. | The guest's own gate still holds after a restart abandons a request whose command is running. |
| I5b | `GuestRunsGateHeldRequest` | Any command at the guest is a request the controller gate still names. | A stale or rejected frame cannot take the guest slot without a gate; a fenced request remains named until the fence releases. |
| I5c | `StaleFrameNeverStarts` | An active guest command carries an epoch at least as high as the guest's high-water mark. | `admitEpoch` rejects a frame from an older generation below the guest's high-water. This is defence in depth behind the relay floor. |
| I5d | `NoStaleFrameStarts` | An active command whose epoch is below `execEpoch` was started by an earlier controller generation (`startGen < epoch`). | The relay's epoch floor: a frame claimed before recovery can never take the guest slot after it. `StaleEpoch` models the pre-#88 high-water check and falsifies this. |
| I6 | `NoSlotAfterTerminal` | Terminal sessions have no slot, in-flight command or held fence. | A dead session cannot hold the gate. |
| I7 | `NoOrphanedWorkloadAfterTerminal` | Terminal sessions have no Pod (recorded or not), no PVC and no relay entry. | No orphaned Pod/PVC after a terminal state. |
| I8 | `AtMostOnePod` | A session owns at most one Pod instance. | The adopt-don't-recreate window cannot leave a duplicate. |
| I9 | `NoCapacityOverReservation` | Admitted rows (`ATTACHED` + `ALLOCATED`) never exceed `NodeCapacity`. | No capacity over-reservation, including the crash window before entitlement. |
| I9b | `ReleasingAfterPodGone` | `RELEASING` implies the session row names no Pod. | Holding capacity during release is conservative, not a live-Pod leak. |
| I10 | `TerminalDoesNotHoldCompute` | A terminal session's reservation is `RELEASING` or `RELEASED`. | Compute is not still sold to a destroyed session. |
| I11 | `ReadyImpliesPod` | `READY`/`ACTIVE`/`SUSPENDING` imply a recorded Pod. | The `guest_ready` invariant in the transition table. A relay registration is deliberately excluded: a relay restart drops it for as long as the reconnect takes, and `RelayGraceExpired` bounds that window. |
| I12 | `SuspendedImpliesCheckpoint` | `SUSPENDED` implies a PVC, no Pod, no relay and no connected guest. | A suspended session can actually be resumed. |
| I13 | `ReservationBoundToPayment` | A live reservation is bound to a payment key. | Reservations cannot be orphaned from the money that paid for them. |
| I14 | `RefundOnlyWhenNoService` | A refund exists only for a terminal session that was never READY. | A delivered session is never refunded. |
| I15 | `NoEntitlementWithoutPayment` | A session row that exists has a payment key. | Settlement and entitlement stay joined. |
| I16 | `FenceHoldsTheGate` | A held fence names exactly the request that still holds the gate. | Recovery cannot quietly replace the fenced request. |
| I17 | `NoNewCommandOverlapsFence` | While a fence is held, the only command in flight at the guest is the fenced request. | A new command can never overlap the old one, even across recovery. |
| I18 | `NoPrematureFenceRelease` | A released fence's request is not active at the guest. | `OperationFence` never clears the gate while the old command still runs; this is what `FenceRelease` falsifies. |
| I19 | `PaidSessionProgress` | Every settled payment eventually reaches a READY session or gets a refund obligation. | No paid session stuck before READY, even across crash/retry. |
| I20 | `TerminalReleasesCapacity` | A terminal session's reservation eventually reaches `RELEASED`. | Capacity comes back after the Pod is observed gone. |
| I21 | `FencedGateClears` | A held fence eventually clears once the guest reports idle or the session has no registration left. | The gate does not stay closed forever after the guest is done. A registered session with no guest waits for the reconnect (ADR 0011); a connected guest that never reported status is deliberately outside this obligation. |

`I19`-`I21` are checked under fairness of the controller actions. `FenceRelease`
uses strong fairness (`SF_vars`) because its precondition alternates as a guest
reconnects and drops again; weak fairness leaves a fair connect/disconnect cycle
that starves the release. `GuestConnect` and `ReregisterRelay` are weak-fair, so
a guest that can come back does. Fairness is split into `ProvisionFairness`,
`SuspendFairness`, `ConnectionFairness`, `CleanupFairness`, `ReleaseFairness`,
`OperationFairness`, `RecoveryFairness` and `RefundFairness` so a broken variant
can keep the obligations of the actions it still has.

## Broken variants

Each variant lives in `broken/`, extends the good spec and replaces exactly one
action group. Its config declares only the invariant (or the one temporal
property) that the injected bug falsifies, so a rejection is unambiguous.
TLC prints the invariant name; for a liveness property it prints only
"Temporal properties were violated", which is why the variant configs declare a
single property.

| Module | Injected bug | Rejected by | Trace |
|---|---|---|---|
| `SlotRace` | `claimOperation`'s check and write are two steps, so two requesters both take the slot. | `SingleActiveOperation` | 10 states |
| `DoubleCharge` | Payment row and entitlement are written in separate transactions and the payment insert has no unique key. | `NoDoubleCharge` | 5 states |
| `CapacityRace` | Admission counts only `ALLOCATED` and ignores the `ATTACHED` crash window. | `NoCapacityOverReservation` | 5 states |
| `OrphanPod` | `Finalize` runs without observing Pod/PVC/relay cleanup. | `NoOrphanedWorkloadAfterTerminal` | 7 states |
| `FenceRelease` | `OperationFence` clears a recovery fence without the guest's idle status or an empty relay pending set. | `NoPrematureFenceRelease` | 13 states |
| `StaleEpoch` | The relay forwards — and the guest starts — a frame claimed in an older controller generation, comparing only against the guest's high-water mark (the pre-#88 contract). | `NoStaleFrameStarts` | 12 states |
| `NoRefund` | The refund path is removed (and its fairness with it). | `PaidSessionProgress` | liveness |
| `NoRelease` | The reaper never confirms a release (and its fairness with it). | `TerminalReleasesCapacity` | liveness |

`run-tlc.sh --broken-only` fails if a variant starts passing (the model no
longer admits the bug) or if it is rejected by an unexpected invariant.

## Findings

- **`RELEASING` is counted as compute even when it never held any.**
  `holdsCompute("RELEASING")` in `controller/src/capacity/types.ts` is true, and
  `beginRelease` moves a `SUSPENDED` row to `RELEASING`. Destroying a suspended
  session therefore adds that session's baseline CPU and memory to the node's
  accounted reservations until the next reconcile confirms the release. The
  model treats this as an accounting over-count, not as over-admission, and
  `NoCapacityOverReservation` counts `ATTACHED`/`ALLOCATED` instead. The effect
  is fail-closed (it can reject an admission, never grant one) and self-heals on
  the next tick; it is recorded here because it is invisible to the existing
  tests.
- **Liveness needs a stuttering action to be checked at sinks.** A terminal
  state has no successor, and TLC reports a liveness violation only along a
  cycle. Without `Stutter` the checker silently accepted "a paid session is
  stuck before READY" whenever the session was already terminal. `Stutter` is
  an idle tick; it is not fair, so it cannot be used to dodge a weak-fairness
  obligation.
- **The intent fast path and the unique key are independent.** The good spec
  keeps both (`claimPaymentIntent` returns `settled` before it can reclaim, and
  `completeEntitlement` relies on the unique payment key). `DoubleCharge`
  removes both because removing either one alone leaves the model correct -
  which is the point: the invariant is doing real work only when both are gone.
- **A frame below the session epoch is withdrawn at the relay, not by the
  guest.** Before #88, `admitEpoch` compared a frame only with the guest's own
  high-water mark (`s.epoch`), never with `sessions.exec_epoch`. After a
  recovery bumped the epoch from 1 to 2, a frame from the previous generation
  that the guest had never observed (high-water 0 or 1) was still admitted. The
  controller gate stayed fenced, so no new command overlapped it, but the old
  command could start after recovery and duplicate side effects the client was
  retrying as `outcome_unknown`.
  The contract now has the relay enforce the session epoch: `OperationFence`
  publishes `exec_epoch` to `POST /internal/:sessionId/epoch` before it may
  clear the gate; the relay refuses a `request` below that floor with
  `stale_epoch`, and withdraws a frame that was already forwarded but never
  answered. Dropping it from the pending set does not unsend it, so if the
  guest has not itself reported an epoch at or above the floor and has no
  command running, the relay resets the guest connection (TCP reset, so unread
  bytes are discarded rather than delivered after a close frame). That is the
  "a command cannot survive its relay link" contract: the link loss kills it.
  The reset no longer ends the guest process: the supervisor reconnects with the
  same identity (ADR 0011), so the session keeps its lease and the withdrawn
  frame never starts. `tests/integration/stale-frame-reset-outcome.test.ts`
  drives the real reconciler and asserts that path end to end.
  Residual: a frame the guest has already read (the read returned before the
  reset reached it) is an observed frame. It may start, and the fence waits for
  it exactly like the pre-#88 path; it cannot overlap a new command. Closing
  that last microsecond would need a start-time round trip per command (the
  guest asks the relay "is this still current?" before taking the slot), which
  is a larger protocol change than this issue needs.
- **The model compares the same epoch the implementation enforces.**
  `DispatchOp` requires `slotEpoch >= execEpoch` (the relay floor), not
  `slotEpoch >= guestEpoch`. `startGen` records the controller generation that
  started the active command, so `NoStaleFrameStarts` can distinguish "the old
  command was already running when recovery fenced it" (`startGen < epoch`)
  from "an old frame started after recovery" (`startGen = epoch`), which is the
  bug the `StaleEpoch` variant injects.
- **The guest's response must reach the relay before its idle status.** The
  first version of the fence model let `GuestDone` (idle status) happen before
  `GuestResponse` (relay pending cleared). TLC found a liveness counterexample:
  the gate was fenced forever because `relayPending` could no longer be
  cleared once the guest slot was empty. `guest/supervisor.go` sends the reply
  before the deferred status publish, so the model now requires
  `relayPending = 0` in `GuestDone`. The fix is the ordering, not an extra
  release path.
- **A relay restart is a registration loss, not a session failure.** The model
  keeps `state`, `pod`, `pvc` and the reservation across `RelayRestart`, bumps
  the epoch for an in-flight operation and holds its gate, then lets
  `ReregisterRelay` and `GuestConnect` restore service. The bounded-grace
  outcome is `RelayGraceExpired` (`failure:relay_lost`), which is
  nondeterministic because the grace is time. This is the property the old
  `RelayLost` action removed: it failed the session on a relay loss, which is
  exactly the bug ADR 0011 fixes.
- **The fence release condition needs strong fairness to be checkable.** A guest
  that reconnects and drops again makes `FenceRelease` alternately enabled and
  disabled, so weak fairness admits a fair cycle that never releases the gate.
  `SF_vars(FenceRelease(s))` says the reconciler, which retries every tick,
  releases a gate that is repeatedly releasable. This is an assumption about the
  controller, not about the guest: guest flapping is still unbounded.
- **Suspension is a fair quiescence step.** A fenced session may be
  `SuspendRequest`ed (the transition table allows it from `ACTIVE`). Without
  fairness on `GuestStopped`, TLC found a cycle stuck in `SUSPENDING` with a
  held fence. `SuspendFairness` makes the guest-stopped observation happen; it
  abandons the fence with the guest (`fence = "none"`) rather than pretending
  `OperationFence` released it.

No counterexample against the good specification is currently known. If
`make verify-model` ever reports one, file it as an issue with the TLC trace
(`java ... tlc2.TLC -config ... -workers 1` reproduces it deterministically with
one worker) and reference this directory.

## Not modeled

- More than one controller replica, Postgres/DynamoDB, leader election.
- Real time: TTL arithmetic, clock skew, lease refresh, the relay-loss grace.
- The relay's response cache and request/response framing (covered by unit
  tests in `controller/src/relay/`).
- Kubernetes scheduler behaviour, node placement, warm pool.
- Request payloads and per-command resource limits.
- The outbound side effect of a command. The model tracks which request holds
  the slot, not whether it wrote a file. It can show that a frame is never
  re-executed, but not that a duplicate execution would be visible to the
  customer. The integration tests assert that directly (marker files).
- A command that survives its relay link. `GuestDisconnect` and `RelayRestart`
  empty the guest slot because the supervisor kills the process group; if that
  contract regresses, the model would not see it, and the "no overlap" argument
  would need a new action rather than a new invariant.

If one of those becomes load-bearing for an invariant, extend the model rather
than adding a second checker.

## Mapping a change back to the spec

The spec is organised to mirror the code:

| Spec section | Code |
|---|---|
| `ClaimIntent`, `ReserveCapacity`, `ChargeSession` | `control-api/payments.ts`, `store.ts` |
| `Provision` .. `GuestStopped`, `ResumeRequest` | `shared/src/domain/session.ts`, `lifecycle.ts` |
| `StartOp`, `DispatchOp`, `GuestResponse`, `GuestDone`, `FinishOp` | `store.ts`, `relay/` |
| `GuestConnect`, `GuestDisconnect`, `GuestReady`, `RelayRestart`, `ReregisterRelay` | `relay/registry.ts`, `relay/ws.ts`, `relay-recovery.ts`, `guest/supervisor.go` (reconnect loop) |
| `RecoverInterruptedOps`, `FenceRelease`, `RejectStaleFrame` | `store.ts` (`recoverInterruptedOperations`, `clearFencedGate`), `operation-fence.ts`, `relay/registry.ts` (`raiseEpoch`, `request`), `guest/supervisor.go` (`admitEpoch`) |
| `RequestDestroy`, `ExpireLease`, `RelayGraceExpired`, `ProvisioningTimeout` | `reconciler.ts`, `termination.ts`, `relay-recovery.ts` |
| `KillGuest`, `DeleteWorkspace`, `PurgeRelay`, `BeginRelease`, `ConfirmRelease`, `Finalize` | `termination.ts`, `capacity/reservations.ts` |

If you change `SOURCE_STATES` or an admission guard, change the corresponding
action. `make verify-model` will reject a model whose guards no longer imply the
invariants; add the new action to `broken/` if you want to keep proving it
bites.
