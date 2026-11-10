# Verification

Status: the lifecycle, payment-intent, operation-slot and reservation state
machines have an executable TLA+ model, checked with TLC over a bounded model.

Example and property tests in `tests/` sample interleavings. The model in
[`verification/`](../verification/README.md) enumerates them for a bounded
number of sessions, requests and crashes, which is the only way to check
statements such as "no paid session is stuck before READY" or "no capacity is
over-reserved" across every crash/retry schedule.

```bash
make verify-model
```

The target runs two good configurations and six deliberately broken ones. The
good spec must hold every invariant; each broken variant must be rejected by the
invariant its injected bug falsifies. TLC is pinned (tla2tools v1.7.4, SHA-256
verified), so the run is reproducible offline once the jar is cached.

## What it covers

| Subsystem | Invariants |
|---|---|
| Session lifecycle | READY implies a Pod and relay, SUSPENDED implies a checkpoint, terminal sessions hold no slot |
| Payment intent and ledger | no double charge, atomic settlement, one session per payment key, refund only without service |
| Operation slot | one controller slot and one in-guest command per session, restart recovery releases an interrupted slot |
| Reservation | no capacity over-reservation, terminal sessions release capacity, `RELEASING` only after the Pod is gone |

The full list, with the meaning and code location of each invariant, is in
[`verification/README.md`](../verification/README.md).

## What it does not cover

Multiple controller replicas, real time (TTL arithmetic), the relay response
cache, Kubernetes scheduling and the warm pool. Those are either covered by
tests in `tests/` or documented as non-goals in
[control-plane-faults.md](control-plane-faults.md).

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
