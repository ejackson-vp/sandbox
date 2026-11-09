# Warm pool

> Benchmark tooling and raw results live in the [sandbox-bench](https://github.com/ejackson-vp/sandbox-bench) repository; paths below refer to that repo.


Status: **implemented and measured on the local kind rig.** Not enabled by
default.

> **Position:** this pool is a development stand-in for snapshot restore, not a
> scaling strategy. It is deliberately simpler than FES: fixed size, claim-once,
> no reuse, no autoscaler, no Redis pool state. Do not add warm-VM reuse or
> autoscaling. On a KVM host the fast path should be a Firecracker snapshot
> restore per session; at that point this module should be deleted, not
> extended.

## Why

Warm start was dominated by container startup: in the 100-sample baseline,
`scheduled → guest hello` was **1.32–1.76 s** of a **2.10 s** p50 ready time.
The image was already cached, so this was kubelet/containerd/init/guest process
start, not a pull. Nothing in the control plane can remove it; the only way to
avoid paying it per session is to pay it in advance.

A warm pool keeps a small number of **pre-booted, unleased** guest pods. A paid
session claims one instead of creating a pod, so the customer waits for a claim
handshake rather than a container start.

## Lifecycle

```text
controller                          relay                         warm guest
    │                                  │                              │
    ├─ create warm pod (no session) ───┼─────────────────────────────▶│ boot
    │                                  │◀── pool hello (pool id) ─────┤
    │                                  │                              │ wait
    │  (paid session arrives)          │                              │
    ├─ register real session ──────────▶│                              │
    ├─ POST /internal/<pool>/claim ────▶│──── claim {session, keys} ──▶│
    │                                  │                              │ close pool conn
    │                                  │◀── reconnect as session ─────┤ fresh keypair
    │                                  │◀── session hello + evidence ─┤
    ├─ observe hello, set READY ───────┤                              │ serve
    ├─ relabel pod pool=sandbox ───────┤                              │
    └─ replenish pool                  │                              │
```

The pod template never contains `SESSION_ID`, `CLIENT_PUBLIC_KEY`,
`CLIENT_NONCE`, or the session guest token. Those arrive in the claim after the
customer has paid. The guest generates a **new keypair and new evidence** after
the claim; the pool connection is discarded.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `WARM_POOL_SIZE` | `0` | Number of idle pods to keep. `0` disables the pool. |
| `WARM_POOL_TIER` | `short` | Tier whose cgroup/disk limits size the pods. |
| `WARM_POOL_TTL_MS` | `300000` | Maximum age of an idle pod before recycling. |
| `WARM_CLAIM_TIMEOUT_MS` | `8000` | If a claimed pod does not attach, fail the session. |

A session may claim a warm pod only if its `cpuMillis`, `memoryMiB`, and
`diskMiB` are **at or below** the pool tier. Output/file/command/process limits
are re-sent in the claim and enforced by the guest. Sessions that do not fit
(custom large tiers, or an empty pool) take the normal cold path.

A warm guest announces itself before it has a session, so its evidence is bound
at claim time rather than at boot. That is acceptable here because the evidence
is not hardware-backed in the first place: the pool does not weaken a guarantee
that does not exist.

## Measured result

Same rig and scenario as the baseline (`startup`, custom 500 m / 512 MiB /
256 MiB, 60 s lease), pool size 8, 100 samples, **1 s between samples** so the
pool can replenish:

| Metric | Baseline (no pool) | Warm pool | Change |
|---|---:|---:|---:|
| READY p50 | 2 099 ms | **100.7 ms** | **20.8× faster** |
| READY p90 | 2 116 ms | 105.5 ms | 20.1× |
| READY p95 | 2 119 ms | 109.8 ms | 19.3× |
| READY p99 | 2 130 ms | 124.9 ms | 17.1× |
| first exec p50 | 10.6 ms | 7.7 ms | — |
| destroy p50 | 518 ms | 112 ms | (earlier optimization) |

- **100/100 samples were served by the pool** at this paced rate. Un-paced
  runs deplete the pool and turn the tail into cold starts — that is the burst
  case below, and the reason admission control matters.
- Claim handshake (`apiReceivedAt → warmClaimAt`) p50 **26 ms**.
- A relay→controller wake on the guest hello cut `hello → READY` from 214 ms
  (250 ms reconcile tick) to **5 ms**.
- The largest remaining term is the SDK's ~72 ms readiness poll, not server work.
- Idle cost per warm pod: **~3.4 MiB current / 1.8 MiB anon**, `128Mi` request,
  `512Mi` limit. Eight pods used ~27 MiB actual memory; the pool's real cost is
  scheduler *requests*, not resident memory.
- With sub-second starts, the default API create limiter (30 burst / 1 per s)
  becomes the throughput ceiling before the pool does. The benchmark used
  `CREATE_RATE_BURST=1000`, `CREATE_RATE_REFILL=500`; the default deployment was
  restored afterwards.

Run it:

```bash
# enable a pool (restores to the ConfigMap default on the next rollout if removed)
kubectl -n sandbox-system set env deploy/controller WARM_POOL_SIZE=8 WARM_POOL_TIER=short
kubectl -n sandbox-system set env deploy/api CREATE_RATE_BURST=1000 CREATE_RATE_REFILL=500

npx tsx benchmarks/harness/cli.ts startup --samples 100 --pace 1000

# restore defaults
kubectl -n sandbox-system set env deploy/controller WARM_POOL_SIZE- WARM_POOL_TIER-
kubectl -n sandbox-system set env deploy/api CREATE_RATE_BURST- CREATE_RATE_REFILL-
```

## Security properties

- **No customer identity before payment.** The warm pod's env is pool-only; the
  claim is the first time a session id, client key, nonce, or session token
  enters the pod.
- **No reuse.** A claimed pod is never returned to the pool; it is destroyed at
  session end. There is no reset path to get wrong and no cross-session data.
- **Fresh keys per session.** The guest generates a new keypair after the claim
  and sends fresh evidence bound to the session id, client key, and nonce.
- **Pool evidence is labelled.** The pool hello is `evidenceType: "warm-pool"`
  and is only used as a readiness signal; the session is judged on its own hello.
- **Minimal RBAC change.** The controller gains `patch` on pods (to relabel a
  claimed pod); it still cannot exec, read secrets, or touch other resources.
- **Claim path.** Only the controller can call the relay's admin claim endpoint;
  sandbox pods cannot reach it.

Known limitation: the claim (including the session guest token) crosses the
relay as a control frame. The relay is a trusted control-plane component that
already handles encrypted envelopes; it cannot decrypt customer payloads. A
future hardening is to seal the claim to a guest public key announced in the
pool hello.

## Burst and soak

A pool absorbs exactly its size; it is not a queue. With pool=8, 10/25/50
simultaneous paid creates produced 8/8/8 warm hits and READY p50
412 ms / 2.78 s / **18.92 s** (42 cold fallbacks at 50). No failures, no
orphans. With the default per-payer admission limit (30 burst / 1/s), the same
50-create burst would admit the first 30 and return 20 immediate 429s instead —
the intended backpressure.
See [admission-control.md](admission-control.md) and
[performance-report.md §2.5](performance-report.md#25-burst-behaviour-pool--8).

The soak scenario runs steady create/exec/destroy traffic and injects
relay/controller restarts and warm-pod kills. A 180 s run at 1/s with a fault
every 45 s (pool 8) produced:

| Metric | Result |
|---|---|
| Sessions | **174/174 ok**, 172 warm hits, 0 failures |
| Relay restart | recovered in **1.87 s** (8/8 warm pods after) |
| Controller restart | recovered in **2.37 s** (8/8 warm pods after) |
| Warm pod kill | recovered in **100 ms** |
| Final state | 8 warm pods, **0 session pods**, 9 relay entries, DB 6.77 MB |
| READY | p50 100 ms, p90 104 ms, p99 1.47 s (2 cold fallbacks) |

The 9 relay entries vs 8 pool entries (one residual session entry) and the DB
growth (~10 KB/session) are the drift indicators to watch in a multi-hour run.
Run it with:

```bash
make benchmark-soak                 # 10 min, 0.5/s, fault every 90s
DURATION=14400 make benchmark-soak  # 4 h
```

## Security regression

`tests/security/warm-pool.test.ts` asserts, when the pool is enabled:

- a warm pod has `WARM_MODE`, `POOL_ID`, and no `SESSION_ID`,
  `CLIENT_PUBLIC_KEY`, `CLIENT_NONCE`, `LEASE_SECONDS`, or `GUEST_TOKEN` in the
  guest container;
- a sandbox can reach the relay but the claim route returns 401 without the
  admin token;
- two sessions get different guest keys, and each attestation binds its own
  session id (never the `warm_*` pool id).

Run it against a pool:

```bash
kubectl -n sandbox-system set env deploy/controller WARM_POOL_SIZE=2
kubectl -n sandbox-system rollout status deploy/controller
npx vitest run tests/security/warm-pool.test.ts
kubectl -n sandbox-system set env deploy/controller WARM_POOL_SIZE-
```

## Not solved

- Cold start, image pull, Kata/TEE startup, and real-node density are unchanged.
- The pool must be sized to the arrival rate. Under a sustained ~1.2 creates/s
  with 8 pods, 2% of samples fell back to cold.
- The 250 ms reconcile tick still sits in the claim→READY path. A relay→controller
  wake on guest hello would remove most of it.
- One pool tier per controller. A production deployment would want per-tier
  pools or a pool sized to the dominant tier.
- Suspendable sessions bypass the pool entirely: a checkpointed session needs
  its per-session PVC, and pod volumes are immutable at claim time. First READY
  and resume are therefore cold (~5.8 s / ~1.9 s in one local run). See
  [lifecycle.md](lifecycle.md).
