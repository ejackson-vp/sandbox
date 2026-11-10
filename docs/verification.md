# Verification

Status: the lifecycle, payment-intent, operation-slot, execution-epoch fence
and reservation state machines have an executable TLA+ model, checked with TLC
over a bounded model.

Example and property tests in `tests/` sample interleavings. The model in
[`verification/`](../verification/README.md) enumerates them for a bounded
number of sessions, requests and crashes, which is the only way to check
statements such as "no paid session is stuck before READY", "no capacity is
over-reserved", "a stale frame never starts" or "a fenced gate is never
released while the old command runs" across every crash/retry schedule.

```bash
make verify-model
```

The target runs two good configurations and eight deliberately broken ones. The
good spec must hold every invariant; each broken variant must be rejected by the
invariant its injected bug falsifies. TLC is pinned (tla2tools v1.7.4, SHA-256
verified), so the run is reproducible offline once the jar is cached.

## What it covers

| Subsystem | Invariants |
|---|---|
| Session lifecycle | READY implies a Pod and relay, SUSPENDED implies a checkpoint, terminal sessions hold no slot |
| Payment intent and ledger | no double charge, atomic settlement, one session per payment key, refund only without service |
| Operation slot | one controller slot and one-in-guest command per session |
| Execution-epoch fence | a stale epoch never starts, a fenced gate keeps the old request and never overlaps a new one, and it clears only after the guest reports idle (or disconnects) |
| Reservation | no capacity over-reservation, terminal sessions release capacity, `RELEASING` only after the Pod is gone |

The fence is the #19 restart-recovery protocol: `recoverInterruptedOperations`
marks the interrupted request `outcome_unknown` and bumps `sessions.exec_epoch`
without clearing the gate; `OperationFence` releases it only from the guest's
own idle/disconnected status, and the guest rejects a frame below its epoch
high-water with `stale_epoch`.

The full list, with the meaning and code location of each invariant, is in
[`verification/README.md`](../verification/README.md).

## Bounds

The model is finite because each config fixes `Sessions`, `Payments`,
`Requests`, `NodeCapacity`, `MaxRestarts` and `PodIds`:

- `SandboxSession.cfg` uses one session, one payment, one request and one
  restart. It checks every invariant and the temporal properties; the small
  bound keeps TLC's liveness pass tractable.
- `SandboxSessionTight.cfg` uses two sessions, two payments, two requests, a
  one-slot node and two restarts. It checks every safety invariant under
  capacity pressure; fairness is omitted because it makes that graph much
  larger.

The bounds are what make the state space finite; they are not claims about
production sizing. The `FenceRelease` and `StaleEpoch` variants use their own
one-session configs so the counterexample is minimal.

## What it does not cover

Multiple controller replicas, real time (TTL arithmetic), the relay response
cache, Kubernetes scheduling and the warm pool. Those are either covered by
tests in `tests/` or documented as non-goals in
[control-plane-faults.md](control-plane-faults.md).

One property is deliberately weaker than "the guest never runs an old frame":
`admitEpoch` compares a frame with the guest's high-water mark, not with
`sessions.exec_epoch`. A frame from the previous generation that the guest has
not yet observed can still start after recovery; the controller gate stays
fenced and the old command must finish before a new one is admitted, so no
commands overlap. This window is recorded in
[`verification/README.md`](../verification/README.md#findings).

## Nightly run

The `model` job in
[`.github/workflows/nightly-faults.yml`](../.github/workflows/nightly-faults.yml)
runs `make verify-model` every night at 04:17 UTC on `ubuntu-latest`. It does
not depend on the cluster fault runner, so a missing or unhealthy self-hosted
runner cannot hide a model regression. The pinned TLC jar is restored from the
Actions cache and still verified by `verification/run-tlc.sh`; on failure the
TLC output is uploaded as `nightly-model-<run id>`.

Run the same check locally with:

```bash
make verify-model
```

A red nightly run means the bounded model found a counterexample or a broken
variant started passing. Treat it as a protocol regression, not a flaky test.

## Related

- [Lifecycle](lifecycle.md) and [sessions](sessions.md): the user-visible states.
- [Payment ledger](payment-ledger.md): the refund policy the model checks.
- [Reservation lifecycle](reservation-lifecycle.md): the states the model follows.
- [Control-plane fault recovery](control-plane-faults.md): the cluster-level
  fault harness, which this model complements rather than replaces.
