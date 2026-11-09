# Cluster performance (Kata, two nodes)

> Benchmark tooling and raw results live in the [sandbox-bench](https://github.com/ejackson-vp/sandbox-bench) repository; paths below refer to that repo.


Measured on the live Talos homelab, not the kind/dev rig. This is the number to
quote for this deployment.

## Environment

| Item | Value |
| --- | --- |
| Nodes | 2 × 8 vCPU, ~13 GiB allocatable each |
| Runtime | Kata Containers + Cloud Hypervisor (`handler: kata`) |
| CNI | Cilium, kube-proxy replacement |
| Control image | `0.1.10` |
| Guest image | `0.1.6` (pinned by digest) |
| Warm pool | 20 pre-booted guests |
| Client | macOS, SDK over Tailscale |
| Payments | mock x402 |

## Method

`benchmarks/cluster/run.ts` uses only the public SDK. Each sample is
create → READY → first exec → destroy. Two timings are recorded:

- **client**: `createSession()` call to `waitForReady()` returning, over
  Tailscale, including payment.
- **server**: the session's `readyAt − createdAt`, i.e. the provisioner's own
  work. This excludes payment, network and SDK polling.

Warm runs pace creates 1.2 s apart so the pool can replenish.

## Results

| Metric | n | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: |
| Warm server ready (pool=20) | 30 | **179 ms** | **340 ms** | 398 ms |
| Warm client ready | 30 | 665 ms | 948 ms | 956 ms |
| Cold server ready (pool=0, image cached) | 10 | **2.69 s** | **3.33 s** | — |
| Cold client ready | 10 | 2.87 s | 3.96 s | — |
| Existing-session exec | 50 | **53 ms** | **108 ms** | 216 ms |
| Destroy | 30 | 181 ms | 253 ms | 260 ms |

Warm components: payment + create p50 **481 ms**, first exec p50 **67 ms**.
Idle memory: pool 0 → 4.40 GiB across both nodes, pool 20 → 8.03 GiB, i.e.
**~182 MiB host-side per idle guest** (VM + shim, not guest RSS).

**Burst (25 simultaneous creates):** 25/25 ready, 0 failures, 19.0 s wall.
Provisioning stayed at p50 257 ms / p95 833 ms, but each client waited ~17.6 s
because the create path serializes at **~1.3 creates/s**. The queue, not the
VM boot, is the burst bottleneck.

**Concurrent held sessions:** 60/60 with 0 failures, paced at 1.2 s, 8 s hold.
Not pushed further: requests are 25% of limits, so the admission bound is around
120 for this spec, but running that many at full CPU would oversubscribe the
nodes.

## Caveats

- **Cold means the image is already on both nodes.** A registry pull adds time.
- Idle memory is a node delta, so it includes shim and page-cache noise.
- p95 with n=10 cold is effectively the maximum.
- The 179 ms warm figure is **claim/readiness of a running VM**, not microVM
  boot. Do not compare it to cold-start numbers from providers.

## Next experiments

The 486 ms gap between server and client is the product target. The ranked list,
the burst analysis and the reasoning are in
[engineering-notes.md](engineering-notes.md). Provisional targets: **server warm
p50 100–150 ms**, **client warm p50 400–500 ms**, with the same p95 discipline.
Do not remove correctness checks for latency.
