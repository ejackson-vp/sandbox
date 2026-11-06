# Milestone 4 results: capacity-aware admission and scheduling

Status: implemented and measured on the local kind rig. A critical design
review is in [capacity-design-review.md](capacity-design-review.md). Measurements are for
ordinary Pods on macOS + Docker Desktop + kind + Cilium. They are **not** VM or
TEE isolation measurements.

## What was built

- Pure integer capacity model: baseline reservations, peak tracking, node
  eligibility, taints, least-allocated placement, suspended-storage accounting.
- `ReservationStore` port with a SQLite adapter, so the controller is not
  hard-wired to a concrete repository.
- Durable SQLite reservations with `HELD`, `ALLOCATED`, `SUSPENDED`,
  `RELEASING`, `RELEASED`, atomic `BEGIN IMMEDIATE` admission and unique
  payment/session keys.
- API preflight before `402`, authoritative capacity hold before settlement,
  and atomic hold → session transfer.
- Resume re-acquires compute on the checkpoint node; failure leaves the session
  `SUSPENDED` with its workspace.
- Warm pods are counted from Kubernetes and replenishment preflights capacity.
- Provisioning queue instrumentation: queue depth and wait histogram.
- `make demo-capacity`, `make benchmark-capacity`, and `sandbox admin capacity`.
- Structural guard still passes; no module over 600 lines.

## Environment

| Item | Value |
|---|---|
| Host | macOS arm64, 14 CPUs, 48 GiB |
| Docker Desktop VM | 14 vCPU, 7.75 GiB |
| Kubernetes | kind 1.32.2, Cilium 1.17.2 |
| Sandbox node | one worker, `x402.io/sandbox-pool=true` |
| KVM | unavailable |
| Payment | mock x402 facilitator |
| Warm pool | 8 `short` pods for the sufficient-capacity runs; 0 for constrained runs |

## Burst results: capacity disabled vs enabled

Same image, same warm pool size, same workload. `CAPACITY_ENABLED=false` is the
baseline; `true` is the new admission path. Both include the preflight/hold
calls, so the comparison isolates the capacity decision rather than the
pre-existing payment path.

| Level | Baseline READY p50 | Capacity READY p50 | Baseline p95 | Capacity p95 | Capacity rejected | Warm hits |
|---:|---:|---:|---:|---:|---:|---:|
| 5 | 557 ms | 647 ms | 561 ms | 650 ms | 0 | 5 |
| 10 | 874 ms | 755 ms | 1.89 s | 2.24 s | 0 | 8 |
| 25 | 2.80 s | 3.18 s | 5.76 s | 6.23 s | 0 | 8 |
| 50 | 15.83 s | 16.07 s | 23.89 s | 23.51 s | 0 | 8 |

Admission did **not** improve latency when capacity was sufficient. That is the
expected result: the bottleneck is cold container startup, not the controller.
Create p50 (includes preflight/hold/payment) was 373/571/1,026/1,728 ms in the
baseline and 378/480/991/1,795 ms with capacity; the differences are within
run-to-run noise at these burst sizes.

### Constrained capacity

Node memory was capped at **700 MiB**, capacity overhead 0, warm pool 0. The
benchmark spec uses 128 MiB baseline memory, so five sessions fit and the sixth
must be rejected.

| Level | Admitted/ready | Rejected `capacity_unavailable` | READY p50 | READY p95 |
|---:|---:|---:|---:|---:|
| 5 | 5/5 | 0 | 1.81 s | 1.81 s |
| 10 | 5/10 | 5 | 1.60 s | 1.60 s |
| 25 | 5/25 | 20 | 1.50 s | 1.71 s |

Rejected requests are reported separately and do not contribute to admitted
latency. The system did not pretend to be faster by rejecting work: the
admitted-session distribution is shown on its own, and the rejection count is
explicit.

No Pods or reservations remained after cleanup (`sandboxPodsAfter=0`).

## Multi-node placement

A two-worker kind run validated least-allocated placement:

- 4 custom sessions (500m / 256 MiB baseline),
- eligible workers: `x402-sandbox-worker`, `x402-sandbox-worker2`,
- reservations after READY: 1000m / 512 MiB on **each** worker (2 sessions per worker),
- `make demo-placement` passed and all sessions were destroyed.

This is a placement demo, not a multi-node load benchmark. The two-worker rig is
created with `make up-2w` and the standard benchmark rig must be restored with
`make down up` afterwards.

A directional two-worker burst was then run with a **2500 MiB logical cap per
node** (5 GiB total), because both kind workers share one 7.75 GiB Docker VM:

| Level | 1 worker READY p50 / p95 | 2 workers READY p50 / p95 | 2-worker throughput |
|---:|---:|---:|---:|
| 10 | 755 ms / 2.24 s | 1.04 s / 2.88 s | 3.5/s |
| 25 | 3.18 s / 6.23 s | **3.08 s / 4.27 s** | **5.9/s** |

At 25 creates, the two-worker p95 improved and throughput rose from ~3.6/s to
~5.9/s; p50 was essentially unchanged. This is not a clean scaling result:
the logical memory cap differs and both workers share the same Docker VM CPU
and disk. It shows placement and parallelism help the tail, not that memory is
additive.

## Provisioning concurrency

Fresh 50-create burst, pool=8, capacity enabled:

| Policy | READY p50 | READY p95 | Warm hits | Cold | Throughput |
|---|---:|---:|---:|---:|---:|
| unlimited | 16.07 s | 23.51 s | 8 | 42 | 2.0/s |
| cap 4 | **10.37 s** | 27.54 s | **28** | 22 | 1.8/s |

Cap 4 trades a better median for a worse tail: queued sessions wait for a
provisioning slot, which lets the warm pool refill. It is a tuning knob, not a
free win. The queue wait histogram and depth are exposed as
`sandbox_provisioning_wait_seconds` and `sandbox_provisioning_queue_depth`.

## Observability

Implemented metrics:

- `sandbox_admission_total{result,reason}`
- `sandbox_admission_duration_seconds`
- `sandbox_admission_rejections_total{reason,retryable}`
- `sandbox_capacity_reserved_cpu_millicores`
- `sandbox_capacity_reserved_memory_bytes`
- `sandbox_capacity_available_cpu_millicores`
- `sandbox_capacity_available_memory_bytes`
- `sandbox_provisioning_queue_depth`
- `sandbox_provisioning_wait_seconds`
- `sandbox_reservation_recovery_total{kind}`
- `sandbox_reservation_leaks_detected_total`

Labels are bounded (result, reason, kind, retryable). No session ids, commands,
filenames, capabilities or payloads are exposed. `sandbox admin capacity` reads
the admin-only summary; it requires the internal controller token.

## Correctness evidence

| Question | Evidence |
|---|---|
| Can two sessions claim the same capacity? | Ten competing admissions for one CPU reservation produced exactly one admission; the rest were rejected. Admission runs in `BEGIN IMMEDIATE` with unique `payment_key`/`session_id`. |
| Are reservations recovered after a crash? | `HELD` has a TTL; `RELEASING` is only released after Pod observation; reconcile repairs session/reservation drift. Unit tests cover expiry, release, and suspended → allocated transitions. |
| Can a suspended session resume without capacity? | No. The demo fills the freed capacity with B, then A's resume returns `capacity_unavailable`; A stays `SUSPENDED` and its workspace stays. |
| Can settlement create an unrecoverable inconsistency? | The hold is created before settlement. If settlement succeeds and completion later fails, the session is not created and the client gets a retryable `capacity_unavailable`; the payment intent remains durable. There is no refund mechanism in this prototype. If settlement itself is uncertain, the hold is left to expire rather than released. |

## Economics

At 50 baseline sessions (128 MiB baseline, 512 MiB limit), accounting mode
`baseline` (the default):

- reserved memory: 6.4 GiB of ~7.75 GiB allocatable (~83%),
- reserved CPU: 6.25 cores of 13.75 (~45%),
- peak memory limits: 25 GiB (~3.2× allocatable),
- peak CPU limits: 25 cores (~1.8× allocatable).

The model reserves baseline, so density is set by scheduler requests. Measured
idle usage is much lower (~0.7 GiB for 50 sessions), which is exactly why the
model does not use observed utilization as free capacity. Constrained 700 MiB
gave five sessions at ~91% baseline reservation.

## Answers

### Correctness

- Competing sessions cannot claim the same capacity under one controller:
  SQLite transactions and unique keys prevent it.
- Reservations survive crashes in SQLite; holds expire, releasing rows wait for
  Pod confirmation, and reconcile repairs terminal/suspended drift.
- A suspended session cannot resume without a fresh compute reservation and
  remains `SUSPENDED` on rejection.
- Payment settlement can still produce a retryable “paid but capacity lost”
  state if completion fails after settlement. This is explicit, not silent, and
  is a limitation of the prototype’s no-refund model.

### Performance

- Capacity admission is not a throughput win when capacity is sufficient; the
  cold-start path dominates.
- Under deliberate constraint, admission turns a capacity stampede into a
  deterministic early rejection with no failed Pods.
- The 50-create burst remains the hard case: p50 ~16 s with pool=8 because only
  eight claims are warm and the rest cold-start.
- Bounded provisioning is the useful control for that tail: cap 4 cut p50 from
  16.07 s to 10.37 s and nearly quadrupled warm hits, at the cost of a worse
  p95 (27.54 s vs 23.51 s).

### Architecture

- The model is multi-node-aware (labels, taints, affinity, storage) but measured
  on one worker.
- SQLite is single-writer. Multiple controllers need a shared conditional-write
  store and a shared capacity snapshot.
- HA needs leader/lease ownership for Pods and reservations.
- Kata/Firecracker change the Snapshotter and host agent, not the admission
  invariant: READY requires a reservation and a live guest.

### Recommendation

The measured bottleneck is cold container startup, not admission. The next
valuable experiment is therefore a **bounded capacity wait queue** for
retryable rejections (serve the 5/10 burst that arrives while five Pods are
booting) and, when KVM is available, a Firecracker snapshot launch comparison.
Do not add an autoscaler or distributed scheduler before those measurements.

## Verification

- `npm run build` — clean
- `npm run lint:structure` — clean
- Full suite — 152 passed, 3 skipped (including an eight-process SQLite concurrency test)
- Security suite on kind — 12 passed, 3 skipped
- `make demo-capacity` — passed end to end on the final deployment
- `sandbox admin capacity` — returns capacity only with the internal token;
  unauthenticated requests return 401
- No Pods and no reservations remained after demo/benchmark cleanup

Raw runs:

- baseline burst: `benchmarks/results/2026-11-06T19-27-38-810Z-adf0370/`
- capacity-enabled burst: `benchmarks/results/2026-11-06T19-29-44-074Z-adf0370/`
- constrained burst: `benchmarks/results/2026-11-06T19-33-17-304Z-adf0370/`
- provisioning cap 4: `benchmarks/results/2026-11-06T19-33-46-587Z-adf0370/`
- two-worker directional burst: `benchmarks/results/2026-11-06T20-42-05-414Z-e17441a/`

## Limitations

- One worker in the measured runs; multi-node placement is property-tested, not
  cluster-benchmarked.
- Warm-pool replenishment is eventually consistent; actual warm Pods are
  counted, but the one-pass preflight window can briefly over-admit a warm pod.
- Warm claims can place the session reservation on a different node than the
  warm Pod; multi-node warm-pool accounting needs a transfer on claim.
- No refunds; settlement/capacity failure is retryable but not financially
  reversed.
- Kind Pods are not secure isolation for malicious customers.
