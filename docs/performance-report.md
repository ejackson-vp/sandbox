# Performance report

Status: measurements on the reference workstation (macOS arm64, Docker Desktop).
See [benchmark-methodology.md](benchmark-methodology.md) for environment,
clocks, sample sizes and threats to validity. Raw data:
`benchmarks/results/<run-id>/`; generated tables: `benchmarks/analysis/output/`.

## A. Performance summary

| Metric | Result |
|---|---|
| Cold start p50 / p95 / p99 | **not available in this environment** (no registry-backed image; see §2.3) |
| Warm start (create → client-ready) p50 / p95 / p99 | **1.80 s / 1.82 s / 2.37 s** baseline (n=100); **2.10 s** after optimizations, in a run where container startup was 0.44 s slower (see §7) |
| Warm start with warm pool (dev, pool=8) p50 / p90 / p95 / p99 | **101 ms / 110 ms / 125 ms** (n=100, 100/100 pool hits, 1 s pacing; see §2.4) |
| Warm start (server entitlement → READY) p50 / p95 | **1.61 s / 1.73 s** (n=99) |
| Existing-session exec p50 / p95 | **10.6 ms / 13.1 ms** (n=100) |
| Maximum tested concurrency | **50 sessions, 50/50 READY, 0 failures** (idle); 25 for CPU and mixed workloads |
| Idle memory per sandbox (anon, 512 MiB tier) | **8.3 MiB** anon; **~15 MiB** node-level incl. caches; 2.1–2.5 millicores idle CPU |
| Peak throughput | **82.6 ops/s** mixed workload at 25 sessions; **69.2 ops/s** CPU-bound at 25 (1.7× single-session latency) |
| Sandbox failure rate | **0/100** startup, **0/50** at 50 concurrent idle, **0** operation errors at 25 CPU/mixed (after fixes below) |
| Cleanup latency p95 | baseline **525 ms**, optimized **116 ms** destroy (client-observed); pod-gone **76 ms** (n=100) |

## 1. Environment (measured)

| Item | Value |
|---|---|
| Host | macOS 27.2, arm64 (Apple Mac16,7), 14 CPUs, 48 GiB RAM |
| Docker Desktop VM | 14 vCPUs, **7.75 GiB RAM**, engine 29.6.2 |
| kind / Kubernetes | kind 0.27.0, Kubernetes 1.32.2, containerd 2.0.2 |
| Nodes | 1 control-plane + 1 worker, both in the same Docker VM |
| CNI | Cilium 1.17.2 |
| Kernel | 6.12.76-linuxkit |
| KVM | unavailable (`/dev/kvm` absent) → no Kata comparison |
| Service version | git commit in each `environment.json` |

Only ~5 GiB of the 7.75 GiB VM is available to sandboxes after the control
plane, Cilium and the sandbox-system workloads.

## 2. Startup latency

### 2.1 Warm start (image cached, no sandbox running)

100 sequential samples: create (paid) → READY → first exec → destroy.

| Stage | n | p50 | p90 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|
| create (payment verify+settle+entitlement) | 100 | 18.1 ms | 21.4 ms | 21.8 ms | 24.1 ms | 53.3 ms |
| entitlement → provision start (controller tick) | 100 | 146 ms | 247 ms | 263 ms | 275 ms | 280 ms |
| pod object created (watch observation) | 100 | 162 ms | 262 ms | 281 ms | 291 ms | 297 ms |
| pod created → scheduled | 100 | 2.2 ms | 2.9 ms | 3.3 ms | 3.9 ms | 4.2 ms |
| scheduled → guest hello (container + init + guest) | 99 | 1.32 s | 1.40 s | 1.44 s | 2.20 s | 2.20 s |
| guest hello → READY (controller tick) | 99 | 139 ms | 223 ms | 235 ms | 249 ms | 249 ms |
| READY → client observed (SDK poll) | 99 | 153 ms | 246 ms | 259 ms | 265 ms | 265 ms |
| first exec (warm session) | 100 | 10.6 ms | 12.6 ms | 13.1 ms | 14.5 ms | 14.7 ms |
| destroy (client observed) | 100 | 518 ms | 523 ms | 525 ms | 591 ms | 780 ms |
| pod gone after destroy | 100 | 62 ms | 80 ms | 93 ms | 125 ms | 138 ms |

Failure rate: 0/100. Observations:

1. **Payment is not the bottleneck.** Verify + settle + entitlement is ~18 ms p50
   (mock facilitator). Real settlement would add on-chain latency, which is a
   separate cost.
2. **Pod runtime startup dominates**: ~1.32 s between scheduling and the guest
   hello, i.e. 73% of the server-side ready time. This is the init container plus
   the main container plus guest process start on the Docker Desktop VM. Image is
   cached; there is no pull.
3. **Two controller ticks cost ~285 ms p50** (entitlement→provision 146 ms and
   hello→ready 139 ms), and the SDK's 250 ms readiness poll adds ~153 ms p50.
   Together ~0.44 s of avoidable latency (optimized in §7).
4. Tail: p99 2.37 s is driven by a subset of samples taking ~2.2 s in
   `scheduled → hello` (likely container/VM scheduling jitter).

### 2.2 Where the time goes (p50, warm)

```
create/payment   18 ms   ▏
wait for tick   146 ms   ███
pod object      162 ms   ███
schedule          2 ms   ▏
container+guest 1321 ms  ████████████████████████████████
hello→ready     139 ms   ███
SDK poll        153 ms   ███
first exec       11 ms   ▏
```

### 2.3 Cold image start

**Not measured.** kind imports images directly into containerd; there is no
registry to pull from unless one is configured, so evicting the image makes the
pod unschedulable (`ImagePullBackOff`) rather than producing a slow start. The
harness implements `startup --cold --image-ref` (evict from containerd, verify
absence, pull on start, restore the controller image) and
`benchmarks/README.md` documents the registry setup. On a registry-backed cluster,
run:

```bash
make benchmark-startup-cold IMAGE_REF=<registry>/x402-sandbox/guest:bench SAMPLES=10
```

No cold numbers are estimated here.

### 2.4 Warm pool (measured, dev mode)

The warm pool keeps pre-booted, unleased guest pods. A paid session claims one
over the relay instead of creating a pod, so container startup is paid in
advance rather than per session. Full design and security notes:
[warm-pool.md](warm-pool.md).

100 samples, same spec as §2.1, pool size 8, **1 s between samples** so the pool
can replenish (un-paced depletion is the burst case in §2.5):

| Stage | n | p50 | p90 | p95 | p99 |
|---|---:|---:|---:|---:|---:|
| create (payment verify+settle+entitlement) | 100 | 17.6 ms | 22.4 ms | 25.7 ms | 29.3 ms |
| claim handshake (API received → warm claimed) | 100 | 26 ms | 31 ms | 34 ms | 48 ms |
| guest hello → READY (relay wake) | 100 | **5 ms** | 7 ms | 8 ms | 10 ms |
| READY → client observed (SDK poll) | 100 | 72.3 ms | 76.4 ms | 77.0 ms | 96.9 ms |
| **create → client READY** | 100 | **100.7 ms** | **105.5 ms** | **109.8 ms** | **124.9 ms** |
| first exec | 100 | 7.7 ms | 9.4 ms | 9.9 ms | 25.2 ms |

- **100/100 samples hit the pool** at this paced rate. Without pacing the pool
  depletes and p95 becomes a cold start (see §2.5).
- A relay→controller wake on the guest hello cut `hello → READY` from 214 ms
  (250 ms tick) to **5 ms**. The claim itself is 26 ms.
- The largest remaining term is the SDK's ~72 ms readiness poll, not server work.
- Idle pool cost is ~3.4 MiB current / 1.8 MiB anon per pod (`128Mi` request,
  `512Mi` limit). The real cost is scheduler requests, not resident memory.
- With sub-second starts the default API limiter (30 burst / 1 per s) becomes the
  throughput ceiling; the benchmark raised it to 1000/500 and restored it after.

The pool is off by default and is rejected in confidential mode (a warm guest
has no session to attest to yet).

### 2.5 Burst behaviour (pool = 8)

The sequential startup numbers above are the best case. Firing N paid creates
simultaneously (all admission buckets raised to isolate capacity) shows what
the pool actually absorbs:

| Simultaneous creates | Ready | Warm hits | Cold fallbacks | READY p50 | p95 | Throughput |
|---:|---:|---:|---:|---:|---:|---:|
| 10 | 10/10 | 8 | 2 | 412 ms | 2.04 s | 4.9/s |
| 25 | 25/25 | 8 | 17 | 2.78 s | 5.85 s | 3.7/s |
| 50 | 50/50 | 8 | 42 | **18.92 s** | 24.72 s | 1.9/s |

The pool absorbs exactly its size; beyond that, cold-start contention is
superlinear (50 concurrent cold starts → 18.9 s p50 on this VM). Warm claims
serialize in the single-threaded controller (claim p50 80–231 ms under burst,
vs 26 ms sequential). With the default per-payer limit (30 burst / 1/s), the
same 50-create burst would admit 30 and return 20 immediate 429s instead of an
~19 s p50 — the intended backpressure. See [admission-control.md](admission-control.md) for the two-bucket
model and the sizing implications.

### 2.6 Soak and faults (3 min, pool = 8)

A 180 s soak at 1 create/s with a relay restart, controller restart and warm-pod
kill:

| Metric | Result |
|---|---|
| Sessions | **174/174 ok**, 172 warm hits, 0 failures |
| Relay restart | recovered in **1.87 s** |
| Controller restart | recovered in **2.37 s** |
| Warm pod kill | recovered in **100 ms** |
| Final state | 8 warm pods, **0 session pods**, 9 relay entries, DB 6.77 MB |
| READY | p50 100 ms, p90 104 ms, p99 1.47 s (2 cold fallbacks) |

This is a short run, not a multi-hour leak test. The two drift indicators to
watch are the residual relay entry (9 vs 8 pool entries) and DB growth
(~10 KB/session).

## 3. Concurrency and density

All levels use the 512 MiB / 500 m tier with a 240 s lease. Sessions are created
in paced batches and all sessions are destroyed after each level.

> Density runs at 25/50 used `CREATE_RATE_BURST=1000`, `CREATE_RATE_REFILL=500`
> to isolate capacity from admission control. The default deployment remains
> 30 burst / 1 per second; its measured effect is in §8.3.

### 3.1 Idle sessions

| N | READY | anon/sandbox p50 | node memory | node CPU (quiet) | ready p50 | teardown p50 |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 8.4 MiB | 1.17 GiB | 3.8% | 2.03 s | 518 ms |
| 5 | 5 | 8.4 MiB | 1.23 GiB | 5.1% | 1.41 s | 522 ms |
| 10 | 10 | 8.3 MiB | 1.29 GiB | 6.2% | 1.49 s | 555 ms |
| 25 | 25 | 8.4 MiB | 1.54 GiB | 5.9% | 2.67 s | 231 ms |
| **50** | **50** | **8.3 MiB** | **1.89 GiB** | **8.7%** | **4.61 s** | **342 ms** |

Node CPU is the whole worker cgroup (cilium, kubelet, containerd, pods); idle
sandbox cost is ~2.1–2.5 millicores each, measured from each sandbox's own
`cpu.stat` delta over a quiet window.

Memory scales at ~15 MiB per sandbox at the node level (≈8 MiB anon + page
cache). 50 idle sandboxes add ~0.7 GiB to the node. Ready latency grows from
~2 s at 1–10 to 2.7 s at 25 and 4.6 s at 50 — mass container start, not the
control plane.

### 3.2 CPU-active sessions

A deterministic Python loop (2M iterations, ~213 ms at 1 session) in every
sandbox, all launched together:

| N | ops/s | latency p50 | slowdown vs N=1 | errors |
|---:|---:|---:|---:|---:|
| 1 | 4.7 | 213 ms | — | 0 |
| 5 | 20.9 | 217 ms | +2% | 0 |
| 10 | 40.3 | 234 ms | +10% | 0 |
| 25 | 69.2 | 361 ms | +69% | 0 |

25 × 500 m = 12.5 cores on a 14-core VM plus the control plane saturates the
node; per-command latency rises but throughput keeps scaling (4.7 → 69.2 ops/s)
and no operation fails. CPU limits are enforced (each sandbox is capped at
500 m), so one sandbox cannot starve the others beyond the shared-core effect.

### 3.3 Mixed workload

25 sessions, one operation each: 20% compute, 40% short Python exec, 20%
filesystem write+hash, 20% HTTPS through the proxy.

| N | ops/s | errors | notes |
|---:|---:|---:|---|
| 1 | 4.5 | 0 | single compute-dominated sample |
| 5 | 27.1 | 0 | exec p50 14 ms, fs 15 ms, HTTPS 185 ms |
| 10 | 40.8 | 0 | exec 18 ms, fs 19 ms, HTTPS 129 ms, compute 228 ms |
| 25 | 82.6 | 0 | 25/25 ready |

The 25-session mixed run reported `ready p50` 12.4 s — an outlier after the
fourth consecutive 25–50 pod churn on one Docker VM (idle/CPU levels at the same
size were 2.5–2.7 s). It is reported as observed, not averaged away.

### 3.4 Capacity interpretation

| Bound | Sessions on this worker |
|---|---:|
| Pod count (`allocatable.pods`) | 110 |
| Scheduler requests (128 MiB / 125 m each) | 61 (memory-bound) |
| Worst-case memory limits (512 MiB each) | 12 |
| Measured successful starts | 50 (all READY) |
| Measured stable operation | 25 CPU/mixed, 50 idle |

Kubernetes schedules on **requests** (1/4 of limits), so 50–61 idle sessions fit
even though their combined limits exceed node memory. That is deliberate
overcommit: it is safe for the measured workloads (8 MiB actual) but not a
guarantee for memory-heavy customers. The cost model uses the conservative
limit-bound capacity.

## 4. Resource overhead

### 4.1 Per sandbox (512 MiB / 500 m tier)

| Metric | Requested | Limit | Measured idle |
|---|---:|---:|---:|
| CPU | 125 m | 500 m | **2.1–2.5 millicores** |
| Memory (anon) | 128 MiB | 512 MiB | **8.3 MiB** |
| Memory (file cache) | — | — | 4 KiB–0.6 MiB |
| Processes (pids) | — | 1024 (pod cgroup) | **9–10** |
| Node-level memory incl. caches | — | — | **~14.7 MiB** |
| Ephemeral storage | 16 MiB request | 288 MiB (pod) | a few KiB |

The gap between requests (128 MiB) and actual usage (8 MiB) is 15×; the gap
between limits (512 MiB) and usage is 60×. This is why idle density is bound by
scheduler requests, not by real memory.

### 4.2 Shared control plane

Cgroup `memory.current` per component at 10 idle sessions:

| Component | Memory |
|---|---:|
| API | ~43 MiB |
| Controller | 92–106 MiB (grows ~11 MiB from 1→10 sessions, SQLite + maps) |
| Relay | ~64 MiB |
| Egress proxy | ~61 MiB |
| Mock facilitator | ~40 MiB |
| **Total** | **~300 MiB** |

This is ~4% of the 7.75 GiB VM and does not scale with session count at the
measured levels. The relay held 25–50 sessions with zero pending requests.

### 4.3 CPU during idle density

Whole-worker CPU (including Cilium, kubelet, containerd): 3.8% at 1 session,
6.2% at 10, 8.7% at 50 (of 14 vCPUs). Subtracting the ~3.5% baseline, 50 idle
sandboxes cost well under half a core in total.

### 4.4 Projection to a 16 vCPU / 64 GiB worker

Not measured on such hardware; from the cost model (requests-based, 20%
headroom):

- short tier (500 m / 512 MiB, request 125 m / 128 MiB): **102 sessions**
  (CPU-request-bound);
- standard tier (1 vCPU / 1 GiB): **51**;
- extended (2 vCPU / 2 GiB): **25**;
- long (2 vCPU / 4 GiB): **12**.

These are projections from measured per-session usage and the scheduler's
request math, not a node benchmark.

## 5. Representative workloads

Run in one warm 10-minute session (except W2b/W5-fresh/W6); n is per row.

| Workload | Result |
|---|---|
| W1 hello (`python3 hello.py`, n=20) | p50 **12.7 ms**, p95 18.8 ms, 0 failures |
| W2 compute (2M-iteration loop, n=8) | p50 **273 ms** (210–270 ms across runs), p95 288 ms |
| W2b compute, 5 concurrent sessions (n=5) | p50 **220 ms**, p95 244 ms |
| W3 filesystem (20 files → tar, modify, download) | upload **9.0 ms** (540 B compressed), download **8.1 ms** (621 B), modify 8.6 ms |
| W4 pip install `six` through the proxy (n=3) | p50 **2.94 s** end-to-end (venv + download + import) |
| W5 20 commands in one session | p50 **6.2 ms** per exec |
| W5 same command in 10 fresh sessions | p50 **1.92 s** ready+exec per command |
| W6 lease expiry during a 60 s command | command cancelled; pod gone **2.16 s** after lease end; state EXPIRED; cleanup 253 ms |

Observations:

- **Session reuse is ~300× cheaper in latency** than provisioning for each
  command (6 ms vs 1.9 s). This is the core value of the session model.
- W3's archive compresses to 540 bytes, so the MiB/s figures are meaningless;
  the measurement validates the path and latency for small files, not streaming
  throughput. A throughput test needs incompressible data and is listed as
  follow-up work.
- Dependency installation works through the unchanged egress policy: the venv
  and proxy configuration are enough; no network rule was relaxed.
- Expiry is enforced by the guest watchdog first (command cancelled) and the pod
  is gone ~2.2 s later (controller grace + delete).

## 6. Reliability under load

Bounded fault injection on the dedicated cluster (`final-reliability` plus a
clean restart probe run afterwards).

| Scenario | Result |
|---|---|
| 20 concurrent creates | 20/20 succeeded, 0 errors |
| 100 repeated execs in one session | 0 failures; p50 first 20 = 6.4 ms, last 20 = 5.7 ms (no drift) |
| Expiry during a 60 s command | command cancelled; pod gone ~1.9 s after the 4 s lease; state EXPIRED |
| Cancellation | `cancelled=true`; session usable afterwards |
| Client disconnect | result recovered by request id |
| Pod killed while READY | detected and finalized as `FAILED` (2 probes × 2 s strikes) |
| Orphaned sandbox pods after all scenarios | **0** |
| Controller restart (clean, no load) | **6.95 s** to ready; exec works afterwards; 0 errors |
| Controller restart under sustained exec load | **120 s+** in this run, 377 failed execs before recovery; see note |
| Relay restart | **6.97 s** to ready; in-flight sessions fail (guest connection lost) and are finalized `FAILED`; new sessions work |
| API restart with 10 in-flight creates | **2.64 s** to ready; all 10 in-flight creates completed client-side; new creates work |

Note on the controller restart: the clean probe recovered in 7 s, but the
in-suite restart (5 sessions issuing execs continuously, immediately after
~100 pod lifecycles) exceeded the 120 s harness timeout. That is a real tail
risk on this Docker Desktop environment (single-writer SQLite on a RWO
local-path volume + forced pod deletion + VM I/O contention). A production
controller must be HA and restart-safe; the current one is not.

Payment/entitlement consistency: no double charges, lost entitlements, or
replayed sessions were observed in any run. The outbox recovery test remains in
the functional suite.

## 7. Optimizations (measured before/after)

Three low-risk changes, each verified by re-running the same benchmark:

### 7.1 Event-driven provisioning and teardown

The controller reconciles on a 250 ms timer. The API now nudges it immediately
after an entitlement is created and after a destroy request
(`POST /internal/wake`), and the reconciler coalesces wake-ups while a pass is
running.

| Stage (p50, n=100) | Baseline | Optimized | Change |
|---|---:|---:|---:|
| entitlement → pod object created | 161.5 ms | **32.6 ms** | −79% |
| destroy (client observed) | 518 ms | **112.5 ms** | −78% |
| pod gone after delete | 62 ms | 68 ms | unchanged (Kubernetes deletion) |

### 7.2 Adaptive readiness polling (SDK)

`waitForReady` polled every 250 ms. It now polls every 75 ms for the first eight
attempts and then backs off to 200 ms (with 429-tolerant retries).

| Stage (p50, n=100) | Baseline | Optimized |
|---|---:|---:|
| server READY → client observed | 153.3 ms | **103.4 ms** |

### 7.3 Dead-guest detection (and a regression the benchmark caught)

The reconciler only checked pod health while `PROVISIONING`. A guest that exited
after READY (relay restart, OOM, crash) left the session READY until the lease
ended.

First implementation: probe pod phase every 2 s and terminate when the pod is
missing or terminal. At 25 concurrent sessions this **mass-terminated 20 paid
sessions**: the probe treated a transient Kubernetes API error as "pod gone"
(`getPod().catch(() => null)`), and the controller logged
`failure:guest_exited` for sessions whose pods were healthy. No OOM or eviction
events existed; the pods were later deleted by cleanup.

Fix: a failed probe never counts. Only a successful read that reports the pod
missing/terminal increments a strike, and two consecutive strikes (≈4 s) are
required. Probe errors are logged and ignored. Re-measurement at 25 and 50
concurrent sessions is in §3. The `pod_killed_while_ready` reliability scenario
now reports FAILED within ~4–6 s.

This is the value of the exercise: the optimization itself was fine, but the
health check's failure mode only appeared under concurrency.

### 7.4 Per-sandbox PID isolation bug (found by the density benchmark)

The guest set `RLIMIT_NPROC=256` per sandbox. That limit is per-UID, and every
sandbox on the node shares UID 65532, so it acted as a node-wide cap. At 25
concurrent sandboxes, `fork()` returned `EAGAIN`: operations failed with
`spawn_failed`, and at 50 the Go runtime could not create OS threads and guests
exited (`failure:guest_exited`), which looked like relay disconnects.

Fix: remove the UID-wide rlimit; rely on the pod cgroup's `pids.max`
(`pod-max-pids=1024` per sandbox), which is the correct per-sandbox control.
Re-measured: 25/25 sessions created and ready, zero operation failures (§3).

### 7.5 Measurement caveat

The optimized startup run's container-start component was 1.76 s versus 1.32 s in
the baseline run (tight distribution, not noise), which swamped the ~0.18 s of
application-level savings in the end-to-end number. The isolated control-plane
and client polling stages above are measured on the same code paths and are not
affected by container-start variance. Container startup on this Docker Desktop VM
varies with image-layer page-cache state and is outside the application.

Net application-owned startup latency: **~438 ms → ~239 ms** p50 (wake removes
the provision tick, adaptive polling removes half the client delay); teardown
drops by ~78%.

## 8. Bottlenecks

Ranked, with the full analysis in [bottleneck-analysis.md](bottleneck-analysis.md):

1. **Container/init startup** — 1.3–1.8 s of every warm start; outside the
   application, must be measured on native Linux/Kata.
2. **Mass-start contention** — ready p50 2.0 s (1) → 2.7 s (25) → 4.6 s (50);
   CPU-active latency +69% at 25 sessions while throughput still scales.
3. **Admission control** — default create limiter (30 burst, 1/s) throttled
   unpaced level 25 to 10–15 sessions; a policy bottleneck, not capacity.
4. **Serialized readiness detection** — hello→READY still ~139 ms (tick), and
   the reconcile loop's per-session relay/Kubernetes calls explain the 12.4 s
   outlier at 25 mixed sessions after heavy churn.
5. **Cold image distribution** — unmeasured; expected to dominate the first
   start on a registry-backed cluster.

Two scale-dependent bugs were found and fixed: a node-wide `RLIMIT_NPROC`
(shared UID) and a health check that treated transient Kubernetes errors as
"pod gone". See §7.

## 9. Unit economics

See [cost-model.md](cost-model.md). Headline (modelled, 16 vCPU/64 GiB worker):

| Tier | Safe sessions/worker | Cost/session | Margin @ $0.02/min |
|---|---:|---:|---:|
| short (1 min) | 102 | $0.0015 | 92.4% |
| standard (5 min) | 51 | $0.0027 | 97.3% |
| extended (15 min) | 25 | $0.0095 | 96.8% |
| long (30 min) | 12 | $0.0353 | 94.1% |

The binding business constraint is peak-to-average demand, not per-session cost
(see the peak-concurrency table in the cost-model document).

## 10. Runtime comparison (Pods vs Kata)

**Kata unavailable.** This host has no `/dev/kvm`; Kata cannot run on macOS, and
kind nodes share the LinuxKit VM kernel with no nested virtualization. No Kata
numbers are reported or estimated.

To produce a comparable dataset on a Linux/KVM host:

1. Install the CoCo chart (`kata-qemu-coco-dev`, non-confidential) or use
   `kata-clh` for kind/minikube.
2. Switch `RuntimeClass` and `EXECUTION_MODE=kata` (see `deploy/kata/`).
3. Run `make benchmark-startup SAMPLES=50`, `benchmark-density LEVELS=1,5,10`,
   `benchmark-workloads` with identical CPU/memory limits and image.
4. Record the guest kernel from the attestation claims to prove a separate VM
   kernel, and compare startup, idle memory, throughput and teardown against the
   container baseline in this report.

## 11. Production readiness

What would prevent safely serving arbitrary untrusted customer workloads today:

1. **Shared-kernel execution.** Development mode is ordinary pods on the host
   kernel. There is no VM boundary and no hardware attestation. Kata exists as a
   configuration (`deploy/kata/`) but has not been validated on KVM hardware.
2. **Single points of failure.** One controller (SQLite on one PVC), one relay
   with in-memory state, one API replica. Relay/controller restarts interrupt
   paid sessions (measured in §6).
3. **Admission control.** The default create limiter (30 burst, 1/s) throttles
   agent fleets long before capacity is exhausted. Production needs
   per-payer quotas and a higher, adaptive limit.
4. **Cold start and image distribution.** Not measured; no registry path in the
   default deployment. Multi-node rollout needs a pinned image digest, an image
   cache/mirror, and measured cold-start behavior.
5. **Settlement and refunds.** Mock facilitator only. No refund path for failed
   provisioning; real facilitator settlement reconciliation is unimplemented.
6. **Abuse and content policy.** Arbitrary code execution needs a policy,
   takedown process, egress abuse detection and per-payer spend controls.
7. **Observability.** Metrics exist (bounded labels) but there are no SLOs,
   dashboards or alerts; logs are per-pod only.
8. **Scale untested.** Measurements stop at 50 concurrent sandboxes on one
   Docker VM; Kubernetes API traffic, relay fan-out at hundreds of sessions, and
   multi-node scheduling are unmeasured.

## 12. Recommendation

**The architecture is a credible foundation, with one unproven prerequisite
(virtualized isolation) and one business constraint (peak provisioning).**

Supported by the measurements:

- The hot path is cheap and predictable: payment+entitlement 18 ms, warm-session
  execution 10.6 ms p50, encryption/relay overhead in the low milliseconds.
- Per-sandbox overhead is small: ~8.4 MiB anonymous memory idle, ~2.5 millicores
  idle CPU, ~14 MiB node-level including caches; the control plane adds ~300 MiB.
- Isolation behaves: 10 concurrent CPU-bound sessions slow a deterministic
  workload by only ~10%, with no failures; mixed workloads at 10 concurrent show
  no errors.
- Provisioning is ~1.5–1.8 s warm and dominated by container startup (~1.3–1.8 s),
  not by the payment or control plane. Two application-level delays (reconcile
  tick and client polling) were removable and are now gone (~0.44 s → ~0.24 s of
  application-owned latency); teardown fell from 518 ms to 112 ms.
- Pre-booting removes container startup from the per-session path: a measured
  warm pool (8 pods, dev mode) cut create→READY p50 from 2.10 s to **285 ms**
  (p90 366 ms, p95 424 ms, 98/100 pool hits). The remaining ~214 ms is the
  reconcile tick; the tail is empty-pool fallback, so sizing to arrival rate is
  the operational lever. Idle cost is ~3.4 MiB actual per pod.
- Unit economics at the modelled 16 vCPU/64 GiB worker are strongly positive per
  session ($0.0015–$0.035) at $0.01–$0.05/min, *if* capacity is utilized.

Unknown / not supported:

- No evidence for VM-level isolation, cold-start cost, or density on real
  multi-node hardware. kind on macOS cannot answer any of these.
- No evidence at hundreds of sessions: the controller is serial, the relay is a
  single process, and Kubernetes API traffic grows linearly with sessions.
- No evidence that demand will be smooth enough to keep peak provisioning
  utilization above the break-even point (2–10% for the standard tier at
  $0.02/min in the model).

Highest-impact next investment: **validate on a Linux/KVM host with Kata and a
registry-backed image pipeline, and measure cold start + density there.** That
single experiment resolves the two largest unknowns (isolation viability and
whether startup is image-bound). Container startup was the dominant warm-start
cost here, and the warm pool fixed it locally (p50 2.10 s → 285 ms); the same
test on a KVM host tells you whether Kata/TEE startup leaves the pool worthwhile
and how many idle pods a real node can afford. In parallel, add per-payer
admission control and make the relay/controller restart-safe before charging
real money.

## 13. Reproduction

```bash
make down && make up
make benchmark-smoke
make benchmark-startup                 # 100 warm samples
make benchmark-startup-pool            # same, with 8 pre-booted sandboxes
make benchmark-burst                   # 10/25/50 simultaneous creates
make benchmark-soak                    # steady traffic + control-plane faults
make benchmark-density MODE=idle LEVELS=1,5,10,25
make benchmark-density MODE=cpu LEVELS=1,5,10
make benchmark-density MODE=mixed LEVELS=1,5,10
make benchmark-workloads
make benchmark-reliability
make benchmark-report
python3 benchmarks/analysis/cost_model.py
```
