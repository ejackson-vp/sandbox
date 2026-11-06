# Warm pool

Status: **implemented and measured in dev mode on the local kind rig.** Not
enabled by default; not available in confidential mode (fail-closed).

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

```
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

`EXECUTION_MODE=confidential` rejects `WARM_POOL_SIZE>0`: a warm guest announces
itself before it has a session to attest to, so enabling the pool would put
non-hardware evidence on a relay entry. The confidential path needs a
TEE-aware warm handshake first.

## Measured result

Same rig and scenario as the baseline (`startup`, sequential, custom
500 m / 512 MiB / 256 MiB, 60 s lease), pool size 8, 100 samples:

| Metric | Baseline (no pool) | Warm pool | Change |
|---|---:|---:|---:|
| READY p50 | 2 099 ms | **285 ms** | **7.4× faster** |
| READY p90 | 2 116 ms | 366 ms | 5.8× |
| READY p95 | 2 119 ms | 424 ms | 5.0× |
| READY p99 | 2 130 ms | 1 510 ms | 1.4× |
| first exec p50 | 10.6 ms | 8.6 ms | — |
| destroy p50 | 518 ms | 114 ms | (earlier optimization) |

- **98/100 samples were served by the pool.** Two cold fallbacks (empty pool)
  produced the 1.5 s p99; one of them was a 9.8 s outlier. The honest summary is
  fast p50/p90 with a cold-path tail when the pool is undersized for the arrival
  rate.
- Claim handshake (`apiReceivedAt → warmClaimAt`) p50 **33 ms**.
- Guest reconnect + session hello → READY p50 **214 ms**, dominated by the
  controller's 250 ms reconcile tick, not by the guest.
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

npx tsx benchmarks/harness/cli.ts startup --samples 100

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

## Not solved

- Cold start, image pull, Kata/TEE startup, and real-node density are unchanged.
- The pool must be sized to the arrival rate. Under a sustained ~1.2 creates/s
  with 8 pods, 2% of samples fell back to cold.
- The 250 ms reconcile tick still sits in the claim→READY path. A relay→controller
  wake on guest hello would remove most of it.
- One pool tier per controller. A production deployment would want per-tier
  pools or a pool sized to the dominant tier.
