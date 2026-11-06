# Bottleneck analysis

Ranked by measured impact on customer experience or cost. Evidence:
`benchmarks/results/` (run names in parentheses).

## 1. Container runtime + init container startup — ~1.3–1.8 s of a ~1.8–2.1 s warm start

| Stage (warm, n=100) | p50 |
|---|---:|
| entitlement → pod object created (after optimization) | 33 ms |
| pod created → scheduled | 2 ms |
| **scheduled → guest hello** | **1.32 s** (baseline run) / **1.76 s** (later run) |
| guest hello → READY | 139 ms |
| READY → client observed (after optimization) | 103 ms |

The image is already in containerd; there is no pull. The cost is the init
container, main container start, and guest process start on the Docker Desktop
VM. Its run-to-run variance (1.32 vs 1.76 s, tight within each run) tracks
image-layer page-cache state, not application code. **This dominates the
lifecycle and cannot be fixed in the control plane.** It must be re-measured on
native Linux (and with Kata) before deciding whether a warm pool is worth it.

## 2. Mass-start contention — ready latency grows 2.3× from 1 to 50 sessions

| Concurrent idle sessions | ready p50 |
|---:|---:|
| 1 | 2.03 s |
| 10 | 1.49 s |
| 25 | 2.67 s |
| 50 | 4.61 s |

At 50 simultaneous starts, the worker is executing ~50 container starts plus
control-plane work on 14 shared vCPUs. Throughput is fine (all 50 became ready,
0 failures) but tail latency grows. CPU-active load shows the same effect:
per-command latency 213 ms at 1 session → 361 ms at 25 (+69%) while throughput
scales 4.7 → 69.2 ops/s.

A 25-session mixed run after repeated 25–50 pod churn reported a 12.4 s ready
p50 (all sessions eventually ready, 0 errors). That outlier is attributed to
node-level resource reclamation after ~100 pod lifecycles on one Docker VM, not
reproduced in the idle/CPU levels at the same size. It marks the limit of this
environment, not a clean measurement.

## 3. Admission control — default create limiter caps sustained creation at ~1/s

Default: 30-request burst, 1/s refill per API replica, keyed by source IP as seen
through the NodePort SNAT.

- Unpaced level 25: **10–15 of 25** sessions created (`rate_limited`), because
  prior levels had consumed the shared bucket.
- After raising the limiter for the capacity tests: 25/25 and 50/50, create p50
  ~11–35 ms.

This is a **policy** bottleneck, not capacity: agents creating fleets will be
throttled long before the cluster is full. Production needs per-payer quotas and
a higher/adaptive limit; the current single global bucket is also unfair between
concurrent buyers behind the same NAT.

## 4. Serialized controller polling — remaining ~139 ms, plus a 25-session outlier

The event-driven wake removed the entitlement→provision tick (146 ms → ~20 ms)
and most of teardown (518 ms → 112 ms). Two poll costs remain:

- **hello→READY** is still detected on the next reconcile tick: 139 ms p50,
  249 ms p99. The relay knows immediately; the controller does not. Fixing it
  requires a relay→controller event (or a fast path for PROVISIONING sessions).
- The reconcile loop performs a relay HTTP call and a Kubernetes read **per
  provisioning session, serially**. At 25–50 sessions a pass takes long enough
  to delay readiness detection; this is the most likely contributor to the
  12.4 s mixed-run outlier. At hundreds of sessions this needs a work queue and
  informers.

The API's read limiter (600 burst / 40 per second) also interacts with client
readiness polling at 25+ sessions; the SDK retries 429s so it degrades rather
than fails.

## 5. Cold-image distribution — unmeasured, expected to dominate first start

No registry is configured in the default deployment. On a registry-backed
cluster, the first pod after image eviction pays the pull + unpack of the guest
image (hundreds of MB). This must be measured, not estimated; the harness and
procedure are ready (`startup --cold --image-ref`).

## 6. Per-sandbox PID limit bug — found and fixed

`RLIMIT_NPROC=256` was set per sandbox, but the limit is per-*UID* and all
sandboxes share UID 65532. At 25 concurrent sessions `fork()` failed
(`spawn_failed`); at 50 the Go runtime could not create threads and guests
exited, which surfaced as relay disconnects. Replaced with the pod cgroup's
`pids.max` (per-sandbox `pod-max-pids=1024`). After the fix: 25/25 and 50/50
sessions ready, no operation failures.

This is a good example of a scale-dependent bug that unit and single-session
tests cannot see.

## 7. Teardown — now ~112–342 ms, down from 518 ms

With the event-driven wake, `DELETE` triggers immediate termination: client
observes DESTROYED in 112 ms p50 (startup run) and 231–342 ms at 25–50 sessions;
the pod itself is gone ~68 ms after the delete. Remaining cost is Kubernetes
deletion, not polling.

## 8. Shared control plane — small and flat

API ~43 MiB, controller 92–106 MiB, relay ~64 MiB, proxy ~61 MiB, facilitator
~40 MiB (~300 MiB total). Relay pending requests were 0 at 25–50 sessions.
SQLite showed no lock contention. Exec round trip (encrypt → relay → execute →
encrypt) is 6–13 ms for `echo`; encryption is not a bottleneck.

## 9. Not observed

No OOM kills, evictions, image pull errors, orphaned pods after cleanup, or
payment/entitlement inconsistencies in the measured runs.
