# Executable model of the control-plane state machines

`shared/src/domain/session.ts` is a pure transition table with property tests,
and `controller/src/store.ts` generates its SQL guards from `SOURCE_STATES`.
Those tests sample. Payment intents, the single-operation slot and capacity
reservations add concurrency, and the invariants that matter there are
temporal: they must hold after *every* crash, retry and relay loss, not after
the schedules a generator happened to pick.

This directory holds a TLA+ spec of that control plane and a TLC configuration
that checks it exhaustively over a bounded model. It is additive verification:
no product code is imported or changed.

```text
verification/
  SandboxSession.tla     the model: lifecycle, intent, slot, reservation
  SandboxSession.cfg     main bounded run  (2 sessions, 2 payments, 1 request,
                         1 restart, 2-slot node) - all invariants + liveness
  SandboxSessionTight.cfg capacity pressure (1-slot node, 2 requests, 2 restarts)
                         - all invariants, safety only
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
a pass it did not observe. The good runs take about three minutes on a laptop
(the capacity run takes seconds); TLC's output names the invariant when one
fails.

The model is bounded by the constants in each `.cfg`: `Sessions`, `Payments`,
`Requests`, `NodeCapacity`, `MaxRestarts`, `PodIds`. Bounds are what make the
state space finite; they are not claims about production sizing.

## What is modeled

| Subsystem | Implementation | Modeled as |
|---|---|---|
| Session lifecycle | `SOURCE_STATES`, `transition()` | `state` over the 12 states, one action per event, with the same source states and the same `hasPod`/`hasRelay`/`hasPvc` guards |
| Payment intent | `claimPaymentIntent`, `completeEntitlement`, `recoverInterruptedOperations` | `intent`, `intentEpoch`, `settledTo`, `charges`; a claim is reclaimable only from an older controller epoch |
| Ledger and refunds | `payment_ledger`, `RefundService` | `charges` (one row per key), `refund` in `none -> pending -> refunded`, set only for a terminal session that was never READY |
| Operation slot | `claimOperation`, `finishOperation`, `recoverInterruptedOperations` | `slots` (controller gate) and `guest` (the guest's own gate), keyed by request id |
| Capacity reservation | `admit`, `attachToSession`, `resume`, `beginRelease`, `confirmRelease` | `reservations` over `NONE/ATTACHED/ALLOCATED/SUSPENDED/RELEASING/RELEASED`, plus `usedCompute` |
| Provisioning | `Provisioning.provision`, `deletePod`, PVC lifecycle | `pod` (recorded instance), `creating` (created by Kubernetes, not yet recorded), `pvc`, `relay` |
| Faults | control-plane fault harness | `CrashRestart` bumps `epoch`; `RelayLost` fails one session closed; `ProvisioningTimeout`; client retries are ordinary re-enabled actions |

Two modelling choices are worth calling out because they are what make the
interesting traces reachable:

- A Pod create and the session-row update that names it are separate steps, so
  `creating` can hold a Pod the row does not know about. That is the crash
  window `Provisioning.provision` closes by listing and adopting labelled Pods.
- `BeginRelease` moves `ALLOCATED` (and `SUSPENDED`) rows to `RELEASING`, and
  `usedCompute` counts only `ATTACHED` and `ALLOCATED`. See the note on
  `holdsCompute` under [Findings](#findings).

Time is not modeled. Hold expiry, lease expiry and suspended expiry are
nondeterministic environment steps, which is the strongest schedule (any
interleaving may happen) and avoids a clock abstraction the invariants do not
need.

## Invariants

Each name below is checked in both good configs unless marked otherwise.
`I16`-`I18` are temporal and are checked in `SandboxSession.cfg`; the
capacity config is safety-only because fairness makes its graph much larger.
The main config uses a single request id, so the slot invariants (`I4`, `I5`)
are exercised non-vacuously by `SandboxSessionTight.cfg` (two request ids) and
by the `SlotRace` variant.

| ID | Name | Meaning | Why it matters |
|---|---|---|---|
| — | `TypeOK` | Every variable stays inside its column domain. | Catches a modelling slip that would otherwise silently widen the state space. |
| — | `ExistingSessions` | A session outside `created` is still the `CREATED` placeholder. | A session row cannot vanish under a reservation. |
| I1 | `NoDoubleCharge` | `charges[p] <= 1` for every payment key. | A retried or replayed settlement never charges twice. |
| I2 | `SettlementAtomic` | A payment row always has its ledger/session row, bound in the same commit. | Money is never recorded without an entitlement (the `completeEntitlement` transaction). |
| I3 | `OneSessionPerPayment` | Two sessions cannot share a payment key. | A retry with a different session id cannot mint a second entitlement. |
| I4 | `SingleActiveOperation` | At most one controller slot per session. | The single-operation contract; `claimOperation` enforces it under `BEGIN IMMEDIATE`. |
| I5 | `SingleGuestOperation` | At most one command in flight at the guest. | The guest's own gate still holds after a restart abandons a request whose command is running. |
| I6 | `NoSlotAfterTerminal` | Terminal sessions have no slot or in-flight command. | A dead session cannot hold the gate. |
| I7 | `NoOrphanedWorkloadAfterTerminal` | Terminal sessions have no Pod (recorded or not), no PVC and no relay entry. | No orphaned Pod/PVC after a terminal state. |
| I8 | `AtMostOnePod` | A session owns at most one Pod instance. | The adopt-don't-recreate window cannot leave a duplicate. |
| I9 | `NoCapacityOverReservation` | Admitted rows (`ATTACHED` + `ALLOCATED`) never exceed `NodeCapacity`. | No capacity over-reservation, including the crash window before entitlement. |
| I9b | `ReleasingAfterPodGone` | `RELEASING` implies the session row names no Pod. | Holding capacity during release is conservative, not a live-Pod leak. |
| I10 | `TerminalDoesNotHoldCompute` | A terminal session's reservation is `RELEASING` or `RELEASED`. | Compute is not still sold to a destroyed session. |
| I11 | `ReadyImpliesPodAndRelay` | `READY`/`ACTIVE`/`SUSPENDING` imply a recorded Pod and a relay entry. | The `guest_ready` invariant in the transition table. |
| I12 | `SuspendedImpliesCheckpoint` | `SUSPENDED` implies a PVC, no Pod and no relay. | A suspended session can actually be resumed. |
| I13 | `ReservationBoundToPayment` | A live reservation is bound to a payment key. | Reservations cannot be orphaned from the money that paid for them. |
| I14 | `RefundOnlyWhenNoService` | A refund exists only for a terminal session that was never READY. | A delivered session is never refunded. |
| I15 | `NoEntitlementWithoutPayment` | A session row that exists has a payment key. | Settlement and entitlement stay joined. |
| I16 | `PaidSessionProgress` | Every settled payment eventually reaches a READY session or gets a refund obligation. | No paid session stuck before READY, even across crash/retry. |
| I17 | `TerminalReleasesCapacity` | A terminal session's reservation eventually reaches `RELEASED`. | Capacity comes back after the Pod is observed gone. |
| I18 | `InterruptedSlotClears` | A slot claimed in an older epoch is eventually cleared. | The restart recovery that used to leave a paid session `busy` forever. |

`I16`-`I18` are checked under weak fairness of the controller actions. Fairness
is split into `ProvisionFairness`, `CleanupFairness`, `ReleaseFairness`,
`OperationFairness` and `RefundFairness` so a broken variant can keep the
obligations of the actions it still has.

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

No counterexample against the good specification is currently known. If
`make verify-model` ever reports one, file it as an issue with the TLC trace
(`java ... tlc2.TLC -config ... -workers 1` reproduces it deterministically with
one worker) and reference this directory.

## Not modeled

- More than one controller replica, Postgres/DynamoDB, leader election.
- Real time: TTL arithmetic, clock skew, lease refresh.
- The relay's response cache and request/response framing (covered by unit
  tests in `controller/src/relay/`).
- Kubernetes scheduler behaviour, node placement, warm pool.
- Request payloads and per-command resource limits.

If one of those becomes load-bearing for an invariant, extend the model rather
than adding a second checker.

## Mapping a change back to the spec

The spec is organised to mirror the code:

| Spec section | Code |
|---|---|
| `ClaimIntent`, `ReserveCapacity`, `ChargeSession` | `control-api/payments.ts`, `store.ts` |
| `Provision` .. `GuestStopped`, `ResumeRequest` | `shared/src/domain/session.ts`, `lifecycle.ts` |
| `StartOp`, `DispatchOp`, `GuestDone`, `FinishOp`, `RecoverInterruptedOp` | `store.ts`, `relay/` |
| `RequestDestroy`, `ExpireLease`, `RelayLost`, `ProvisioningTimeout` | `reconciler.ts`, `termination.ts` |
| `KillGuest`, `DeleteWorkspace`, `PurgeRelay`, `BeginRelease`, `ConfirmRelease`, `Finalize` | `termination.ts`, `capacity/reservations.ts` |

If you change `SOURCE_STATES` or an admission guard, change the corresponding
action. `make verify-model` will reject a model whose guards no longer imply the
invariants; add the new action to `broken/` if you want to keep proving it
bites.
