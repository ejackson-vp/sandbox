# Benchmark methodology

This document explains exactly what was measured, how, and what the numbers can
and cannot support.

## 1. Test environment

| Item | Value |
|---|---|
| Host | macOS 27.2 (Darwin 27.2.0), arm64, Apple Mac16,7, 14 CPUs, 48 GiB RAM |
| Container runtime | Docker Desktop 29.6.2, VM with 14 vCPUs and 7.75 GiB RAM |
| Cluster | kind 0.27.0, Kubernetes 1.32.2, containerd 2.0.2 |
| Nodes | 1 control-plane + 1 worker (both inside the same Docker VM) |
| CNI | Cilium 1.17.2 (NetworkPolicy enforced) |
| Kernel | 6.12.76-linuxkit (shared VM kernel) |
| KVM | unavailable (`/dev/kvm` absent) |
| Service version | git commit recorded in `benchmarks/results/*/environment.json` |

**Critical constraint:** both kind nodes share one 7.75 GiB Docker VM. Each node
reports `14 CPU / 8,125,932 Ki` allocatable, but there is only one pool of
memory and CPU behind them. Density and cost-per-node figures from this rig are
therefore *lower bounds* for a real 16 vCPU / 64 GiB server; projections to that
hardware are explicitly labelled as projections.

The cluster runs the full control plane (API, controller, relay, egress proxy,
mock facilitator, Cilium, CoreDNS) plus a dedicated tainted sandbox node.

## 2. Workloads

| ID | Workload | Purpose |
|---|---|---|
| W1 | `python3 hello.py` in a warm session | minimum platform overhead |
| W2 | deterministic Python loop (`compute.py`, 2M iterations, ~120 ms on host) | compute overhead and contention |
| W3 | 20 × 4 KiB files packaged as a gzipped tar, uploaded, modified, downloaded | transfer + filesystem |
| W4 | `python3 -m venv` + `pip install six` through the egress proxy + import | realistic dependency install, egress |
| W5 | 20 commands in one session vs 10 fresh sessions | session reuse vs provisioning |
| W6 | 4-second lease, 60-second command | expiry and termination latency |

All workloads are deterministic and benign; no fork bombs, unbounded
allocations, or host-level stress.

## 3. What is measured, and with which clock

| Measurement | Source | Clock |
|---|---|---|
| Create request duration | harness | monotonic (`performance.now`) |
| Payment verify / settle | API histograms and per-session timings | server epoch (ms) |
| Entitlement persisted | API (`entitlementMs`) | server epoch |
| Controller provisioning start | `provisionStartAt` | server epoch |
| Kubernetes create-pod call | controller (`podCreateCallMs`) | server epoch |
| Pod object created / scheduled | pod watch stream observation | harness monotonic |
| Guest hello | relay (`helloAt`) | server epoch |
| READY transition | controller (`readyAt`) | server epoch |
| Client-observed ready | harness | monotonic |
| Exec / destroy | harness | monotonic |
| Pod gone after destroy | harness polling (100 ms) | monotonic |
| Per-sandbox memory/CPU/PIDs | cgroup v2 inside the guest (`memory.current`, `memory.stat`, `cpu.stat`, `pids.current`) | counters |
| Node / component usage | node and container cgroups via `docker exec` / `kubectl exec` | counters |

**Clock domains.** Monotonic client/watcher intervals are accurate. Cross-process
values (`guestHelloAt`, `readyAt`) are epoch milliseconds from processes running
on the same physical host, so skew is small but not zero; the harness bridges
them with `epochAtT0` captured at request start and labels those stages
separately. Stage boundaries that depend on controller ticks have ~one-tick
(≤250 ms, often ~40 ms) resolution.

**Kubernetes timestamps are second-granular.** `creationTimestamp`,
`PodScheduled.lastTransitionTime` and container `startedAt` were therefore not
used for sub-second stages. The pod watcher records when the harness *observes*
ADDED/Scheduled/Running events, which is bounded by watch-stream delivery (tens
of milliseconds) and is reported as "pod object created" / "scheduled".

## 4. Percentiles and sample sizes

- Nearest-rank percentiles, matching `benchmarks/harness/lib/util.ts`.
- Every distribution reports its sample count.
- p99 is only meaningful with a few hundred samples; the analysis marks runs
  with fewer than 20 samples as insufficient for p99.
- Startup warm target: 100 sequential samples (sequential so that concurrent
  provisioning does not change the measurement).
- Cold target: 10 samples (image pull is expensive and requires a registry).

## 5. Density methodology

For each level N:

1. Clean up all sandbox pods and wait for zero.
2. Record node and per-component cgroup counters plus `/metrics`.
3. Create N sessions in paced batches of 5 (150 ms apart) to stay below the
   API's create rate limit; the limit itself is reported as a finding.
4. Wait for all sessions to be READY (240 s cap).
5. Settle 3 s, measure node CPU over a quiet 3 s window, then sample each
   sandbox's cgroup (concurrency 10) and the shared components.
6. Run the phase workload (idle / CPU / mixed) with bounded concurrency.
7. Destroy all sessions, measure teardown, verify zero pods remain.

Capacity is reported two ways:

- **schedulable by requests** — what the scheduler would admit
  (cpu/4, mem/4 per sandbox);
- **safe by limits** — no memory overcommit (mem limit per sandbox).

Idle actual usage (`memory.current`, `anon`) is reported separately, because
requests and limits are reservation policy, not consumption.

## 6. Reliability methodology

Bounded fault injection only, against this dedicated cluster:

- 20 concurrent creates; 100 repeated execs;
- expiry during a 60 s command;
- delete the controller pod under active exec load, measure recovery;
- delete the relay pod during an active session;
- delete the API pod with in-flight creates;
- cancel a running command; abort a client request and recover by request id;
- kill a sandbox pod while READY;
- final orphan-pod count.

Every scenario records success, error category and observed recovery time. The
harness sweeps leftover sandbox pods at the end of every run.

## 7. Cost model methodology

- EC2 prices are read from the AWS public price list (published 2026-11-05);
  the model marks them `verified: true` and records the instance type and region.
- Egress, storage, control-plane, load balancer, observability and payment fees
  are **assumptions**, marked `verified: false` with a source note. They are
  editable inputs.
- Capacity per worker uses the exact requests the controller sets, plus a
  conservative limit-bounded capacity. Headroom defaults to 20%.
- The model reports cost per reserved sandbox-minute (capacity is blocked for
  the lease, whether or not the customer uses it), cost per session, margin at
  $0.01/$0.02/$0.05 per minute, and break-even utilization at a given peak
  concurrency.
- Missing from the model: engineering, support, taxes, chargebacks, payment
  failure/loss, and idle capacity during demand troughs beyond the headroom
  factor. These are business inputs, not measured costs.

## 8. Threats to validity

- **Shared Docker VM**: CPU steal and memory pressure from macOS affect all
  measurements; absolute latencies are specific to this workstation.
- **Single node, single controller, single relay**: no HA effects measured.
- **kind networking** adds a container hop; a real node with native Cilium may
  be faster for pod networking.
- **No Kata**: VM isolation performance is unknown here.
- **Mock payments**: payment latency is the mock facilitator's; it excludes
  on-chain settlement.
- **Image cache**: warm-start results depend on the image already being in
  containerd on the worker.
- **API rate limits** shape the create phase of large density levels; results
  report actual created/ready counts rather than assuming all requests succeed.

## 9. Reproducing

```bash
make down && make up
make benchmark-smoke
make benchmark-startup
make benchmark-density MODE=idle LEVELS=1,5,10,25
make benchmark-density MODE=cpu  LEVELS=1,5,10
make benchmark-workloads
make benchmark-reliability
make benchmark-report
python3 benchmarks/analysis/cost_model.py
```

Results land in `benchmarks/results/<run-id>/`; analysis in
`benchmarks/analysis/output/`; cost output in `benchmarks/results/cost-model/`.
