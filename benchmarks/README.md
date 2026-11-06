# Benchmarks

Reproducible performance, density, reliability and cost measurements for the
x402 sandbox service. Everything runs against the **real** API, controller,
relay and sandbox pods on a kind cluster, through the real SDK. Payments are
always mock x402; no cryptocurrency is moved.

```
benchmarks/
  harness/        TypeScript harness (CLI + scenarios + measurement helpers)
  workloads/      deterministic workloads executed inside sandboxes
  scenarios/      scenario configs and the cost-model inputs
  results/        generated run directories (JSONL + summaries + CSVs)
  analysis/       analyze.py (distributions) and cost_model.py (unit economics)
```

## Quick start

```bash
make up                   # kind + Cilium + images + deploy
make benchmark-smoke      # 1 session, safe on a laptop
make benchmark-startup    # 100 warm create→ready→exec→destroy samples
make benchmark-startup-pool  # same, with 8 pre-booted sandboxes (restores defaults)
make benchmark-burst         # 10/25/50 simultaneous creates against the pool
make benchmark-soak          # 10 min steady traffic + relay/controller/pool faults
make benchmark-density    # 1,5,10,25 concurrent idle sessions
make benchmark-workloads  # hello, compute, filesystem, pip, multi-command, expiry
make benchmark-reliability
make benchmark-report     # python analysis over benchmarks/results
```

Stress loads must be explicit:

```bash
make benchmark-density-stress LEVELS=50 MAX=50
# or: npx tsx benchmarks/harness/cli.ts density --levels 50 --max 50 --yes
```

The harness refuses levels above `--max` (default 25) and above 25 without
`--yes`, and stops escalating if the Docker VM's memory usage crosses ~6.8 GiB.
Every run performs a final operator-side sweep of sandbox pods.

## Result layout

```
benchmarks/results/<run-id>/
  environment.json          host, Docker VM, node allocatable, git commit, image IDs
  startup.jsonl             one row per sample (client + server stages)
  startup.summary.json      distributions + error codes
  startup.csv
  burst.summary.json        simultaneous-create levels (+ CSV)
  soak.summary.json         steady traffic + fault injection (+ CSV)
  density.summary.json      one row per concurrency level (+ infra snapshots)
  density.csv
  workloads.summary.json    W1..W6 metrics
  reliability.summary.json  fault-injection outcomes
```

`benchmarks/analysis/output/` contains markdown tables generated from the
results, and `benchmarks/results/cost-model/` contains the economics CSVs.

## What is measured vs estimated

- **Measured**: client-side latencies (monotonic clock), API payment
  verify/settle, controller provisioning/cleanup, relay hello time, per-sandbox
  cgroup memory/CPU/PIDs, node cgroup usage, Docker stats, pod events
  (watch-stream observation timestamps), workload throughput.
- **Estimated / modeled**: any capacity projection to hardware not tested here,
  cloud prices not marked `"verified": true`, and the unit-economics model.
- The cost model file marks every price with `source` and `verified`.

## Environment constraints (this workstation)

| Resource | Value |
|---|---|
| Host | macOS arm64, 14 CPUs, 48 GiB RAM |
| Docker Desktop VM | 14 vCPUs, **7.75 GiB RAM** (shared by both kind nodes) |
| kind nodes | 1 control-plane + 1 worker, Kubernetes 1.32.2, containerd 2.0.2 |
| Kernel | 6.12.76-linuxkit (shared VM kernel) |
| KVM | **unavailable** (`/dev/kvm` absent) → Kata cannot run |
| Cilium | 1.17.2, NetworkPolicy enforced |

Both kind nodes draw from the same Docker VM, so node "allocatable" values
(14 CPU / 7.75 GiB each) are not independent capacity. Density results are
bounded by the VM, not by a 16-vCPU server. See `docs/benchmark-methodology.md`.

## Cold-image startup

kind loads images directly into containerd, so there is no registry to pull from
unless one is configured. `startup --cold --image-ref <ref>`:

1. requires a registry the worker can reach,
2. evicts the image from the worker's containerd (`crictl rmi`),
3. verifies it is gone, then creates a session (kubelet pulls),
4. restores the controller's original `GUEST_IMAGE` afterwards.

Minimal registry setup for a benchmark cluster (Linux/macOS with Docker):

```bash
docker run -d --name x402-registry -p 5001:5000 registry:2
docker network connect kind x402-registry
REG_IP=$(docker inspect -f '{{(index .NetworkSettings.Networks "kind").IPAddress}}' x402-registry)
docker tag x402-sandbox/guest:dev "$REG_IP:5000/x402-sandbox/guest:bench"
docker push "$REG_IP:5000/x402-sandbox/guest:bench"
# each node needs an insecure-registry hosts.toml (kind containerd config_path)
# and the controller must use the registry-qualified image:
make benchmark-startup-cold IMAGE_REF="$REG_IP:5000/x402-sandbox/guest:bench" SAMPLES=10
```

If the registry is not available, cold start is reported as **unavailable** and
must not be estimated. The warm distribution is unaffected.

## Kata comparison

Kata needs a Linux host with KVM and either the CoCo chart
(`kata-qemu-coco-dev`, non-confidential) or `kata-clh` on kind/minikube. This
macOS workstation has no `/dev/kvm`, so no Kata numbers are reported.

On a KVM host:

```bash
helm install coco oci://ghcr.io/confidential-containers/charts/confidential-containers \
  --version 0.18.0 -n coco-system --create-namespace
kubectl apply -f deploy/kata/runtimeclass-coco-dev.yaml
kubectl -n sandbox-system patch configmap control-config --type merge \
  -p '{"data":{"EXECUTION_MODE":"kata"}}'
kubectl -n sandbox-system rollout restart deploy/controller

make benchmark-startup SAMPLES=50
make benchmark-density LEVELS=1,5,10
make benchmark-workloads
```

Record the guest kernel (`timings`/attestation claims) to prove a separate VM
kernel, and keep CPU/memory/limits identical to the container baseline.

## Harness internals

| File | Purpose |
|---|---|
| `harness/cli.ts` | command dispatch, safety gates, cleanup |
| `harness/lib/runner.ts` | SDK session wrapper, server timings, cgroup sampling |
| `harness/lib/env.ts` | host/node/component measurements, sweep, image eviction |
| `harness/lib/watch.ts` | pod watch stream with millisecond observation stamps |
| `harness/lib/util.ts` | percentile summaries, bounded concurrency, CSV |
| `harness/scenarios/*` | smoke, startup, density, workloads, reliability |

Percentiles are nearest-rank and always reported with their sample count. p99
from fewer than ~20 samples is flagged as not meaningful.

## Results from this workstation

See [../docs/performance-report.md](../docs/performance-report.md) for the full
analysis. Headline numbers (macOS arm64, Docker Desktop 7.75 GiB VM, no KVM):

- warm start 1.80 s p50 (n=100), of which container/init startup ~1.32 s;
- warm-session exec 6–13 ms p50; 20 commands in one session vs 1.92 s per fresh
  session;
- 50/50 concurrent idle sessions READY, 8.3 MiB anon per sandbox, ~15 MiB at the
  node level, ~2.3 millicores idle;
- 25 concurrent CPU-bound sessions: 69 ops/s, +69% latency, 0 errors;
- teardown 112–342 ms after the event-driven wake optimization;
- two scale-dependent bugs found and fixed: a node-wide `RLIMIT_NPROC` (shared
  UID) and a health check that treated Kubernetes API blips as "pod gone".

Kata and cold-image startup are **not measured** here (no KVM, no registry).
