# Capacity design review

This is a critical review of the Milestone 4 implementation against the existing
architecture principles, common patterns, and the DDIA ideas already recorded in
[architecture-principles.md](architecture-principles.md).

## What the design gets right

### Functional core, imperative shell

`admitCapacity(snapshot, request)` is pure: no clock, network, SQLite or
Kubernetes. Property tests exercise it directly. The shell (`CapacityService`,
`ReservationRepository`, API/controller routes) owns effects. This mirrors the
existing lifecycle transition table and keeps the decision testable.

### Single writer + conditional writes

SQLite `BEGIN IMMEDIATE` treats admission as a transaction script:

1. reload active reservations,
2. decide,
3. insert/update,
4. commit.

That is the DDIA single-writer pattern for the prototype. The multi-controller
version would be a conditional write in Postgres/DynamoDB, not an in-memory
counter. Unique `payment_key` and `session_id` keys provide idempotency.

### Idempotency and derived state

- Payment holds are keyed by payment key.
- The reservation is the durable fact; session `PAID`/`PROVISIONING`/`READY`
  are interpreted alongside it rather than duplicating resource counters.
- Release is derived from Pod observation, not from the success of a delete
  request.
- The reservation state is deliberately small. `ALLOCATED` covers the
  `PROVISIONING`, `READY` and `ACTIVE` session phases; adding a reservation
  state per session state would be redundant.

### Failure as a state

`HELD`, `RELEASING` and `SUSPENDED` make uncertainty explicit:

- an unpaid hold expires,
- a deleted Pod keeps `RELEASING` capacity until observed gone,
- a suspended session releases compute but retains storage.

That is better than assuming a Kubernetes delete is complete.

### Backpressure and placement

Least-allocated placement is a simple strategy that avoids a hot first worker.
Capacity rejection happens before settlement, so the product fails closed. The
provisioning cap remains a separate queue control; admission and concurrency are
not conflated.

### Testing

- pure property tests for monotonicity, affinity, ordering and accounting,
- SQLite tests for hold transfer, expiry, release, suspend/resume and rebind,
- a **real multi-process SQLite concurrency test** (eight processes, one
  winner),
- integration tests for pre-payment rejection and the existing payment flow,
- constrained-capacity demo on kind.

## Where it is weaker than it could be

### 1. Baseline vs peak is now a policy, not a caveat

**Addressed in the follow-up.** `CAPACITY_ACCOUNTING=baseline|peak` selects the
reservation vector; `peak` rejects the same workload that `baseline` admits when
limits exceed allocatable capacity. Property tests cover both modes. A peak
overcommit ratio and per-tier policy are still future work; the default remains
baseline to keep density and benchmark comparability.

### 2. Multiple controllers are still unsupported, but the port exists

SQLite remains a single-writer assumption. `ReservationStore` is now an
explicit port, and `ReservationRepository` is its SQLite adapter. A
multi-controller deployment can supply a conditional-write adapter without
changing the capacity service. The alternate adapter, shared snapshot and
leader/lease ownership are still missing; running two controllers remains
unsupported.

### 3. Warm-pool claim accounting is approximate

Warm Pods are counted from Kubernetes actuals, which is better than an in-memory
counter. On claim, the session reservation is now pinned to the warm Pod’s
actual node, and placement mismatches are reconciled. Remaining gaps:

- the warm Pod and session hold can both be counted for a tick (conservative,
  but can reject),
- replenishment preflight is eventually consistent (one Pod creation window),
- there is no durable “warm reservation” row, so the transfer is not a single
  transaction.

A clean fix is a warm reservation row transferred to the session in one
transaction, at the cost of a second source for ephemeral pool Pods.

### 4. Multi-node behavior is validated, not load-benchmarked

**Partially addressed.** `make demo-placement` runs on the two-worker rig and
shows least-allocated placement spreading four sessions across both workers
(1000m / 512 MiB reserved on each). It is a placement demo, not a multi-node
load benchmark. Kubernetes can still schedule differently despite required node
affinity; reconciliation is a warning + pin rather than a re-decision.

### 5. Admission and hold are two controller round trips

`preflight` is advisory and `hold` is authoritative. That is correct, but it
adds latency and duplicate snapshots. A future protocol could return a signed
short-lived capacity token in the `402` response and redeem it in one call,
reducing the race window and request count. That is a protocol change, not a
small refactor.

### 6. No capacity wait queue

Rejections are immediate. Under the constrained run, five sessions boot while
the rest receive `503`. A bounded queue could improve success rate, but it must
have a deadline and must not hold a reservation indefinitely. This was left out
because it was not needed to validate the model.

### 7. Fault injection is still narrower than the milestone asks

Covered automatically now:

- expired holds,
- release confirmation,
- crash rebind,
- suspend/resume capacity race,
- terminal/suspended reservation drift,
- real SQLite multi-process contention.

Not covered as automated fault injection:

- controller kill exactly between hold creation and settlement,
- persistent Pod deletion failure,
- node disappearance during a pending reservation,
- payment settlement followed by capacity loss in a live cluster.

These are documented recovery paths, not all proven by a dedicated test.

### 8. Metrics/benchmark completeness

Implemented metrics cover admission decisions, duration, reservations and queue
depth/wait. The benchmark report still lacks direct controller CPU/memory,
queue-wait distributions, and a 100-create run. Admission latency is inferred
from create latency because the controller histogram is not scraped by the
harness. That is a measurement gap, not a model gap.

## Pattern notes

| Pattern | Use | Assessment |
|---|---|---|
| Functional core / imperative shell | pure admission vs service | good fit |
| Repository | `ReservationRepository` | appropriate; SQL is isolated |
| Strategy | least-allocated placement | simple and testable; alternatives documented |
| State machine | reservation states | small and necessary |
| Transaction script | `BEGIN IMMEDIATE` admission | correct for single writer |
| Outbox | payment intents | reused from earlier milestone |
| Optimistic UI / retries | 503 + retryable | acceptable, but a wait queue would be friendlier |

## DDIA lens

- **Reliability:** reservations survive process crashes; holds expire; releases
  are confirmed by observation.
- **Scalability:** baseline reservations bound scheduler density; peak
  overcommit is explicit. Single-writer SQLite is the scaling limit.
- **Maintainability:** pure model + small adapters; the capacity service was
  split into a snapshot builder and an admission service after review.
- **Skew/hot spots:** least-allocated placement reduces hot-node concentration,
  but all measurements are one worker, so this is not empirically validated.
- **Derived data:** availability is recomputed from node capacity minus
  reservations; no duplicated “free capacity” column exists.

## Verdict

**Not as good as it could be, but good enough for the milestone.** The
correctness core is solid: a pure model, durable atomic reservations, a
pre-settlement hold, and a genuine multi-process concurrency test. The remaining
weaknesses are explicit: baseline-vs-peak policy, multi-controller support,
warm-pool transactionality, multi-node benchmarking, and fault-injection breadth.

The highest-value next refactor is not more abstraction; it is a **peak
accounting policy** plus a **shared-store reservation adapter**, because those
are the two assumptions that would change the correctness story at production
scale. The highest-value next experiment is the **capacity wait queue** and,
on KVM, snapshot restore.
