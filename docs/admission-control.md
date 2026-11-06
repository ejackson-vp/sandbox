# Admission control

Status: two-bucket admission is implemented; the burst matrix is measured on
the local kind rig. A global capacity guard is not implemented yet.

## Why two buckets

Before the warm pool, the API's 30-burst / 1-per-second limiter was rarely the
binding constraint: a warm start took ~2 s, so a single client could not create
faster than that anyway. With warm starts at ~285 ms, the limiter becomes the
throughput ceiling — and it was keyed by **source IP**, which is the wrong shape
for a paid multi-tenant API:

- many users behind one NAT share a budget,
- one payer can exhaust the budget for everyone else,
- the limit says nothing about which payer is responsible.

The API now has:

| Bucket | Default | Key | Purpose |
|---|---:|---|---|
| per-IP | 120 burst, 10/s | `req.ip` | coarse anti-abuse before the payment is decoded |
| per-payer | 30 burst, 1/s | EIP-3009 `authorization.from` (fallback: IP) | product fairness for a paid API |

Both are checked **before the payment intent is claimed or settled**, so a
throttled payer is never charged. A rejected create returns:

```json
{ "error": "rate_limited", "scope": "payer" }
```

with a `Retry-After` header in seconds.

The payer key comes from the *unverified* authorization. That is acceptable for
rate limiting: it is not a trust decision. An attacker who spoofs `from` only
moves their own bucket, and the per-IP bucket still bounds total abuse. The
verified payer is recorded on the settled payment as before.

## Config

| Env | Default | Meaning |
|---|---:|---|
| `CREATE_RATE_BURST` | `30` | per-payer bucket capacity |
| `CREATE_RATE_REFILL` | `1` | per-payer tokens/second |
| `CREATE_IP_RATE_BURST` | `120` | per-IP bucket capacity |
| `CREATE_IP_RATE_REFILL` | `10` | per-IP tokens/second |

The bench scripts raise both buckets for capacity runs and restore the
ConfigMap defaults afterwards.

## Measured burst (pool = 8, all buckets raised)

All sessions were paid mock sessions against the real API/controller/relay. The
pool was warm at 8 before each level.

| Simultaneous creates | Ready | Warm hits | Cold fallbacks | READY p50 | p95 | Wall throughput |
|---:|---:|---:|---:|---:|---:|---:|
| 10 | 10/10 | 8 | 2 | 412 ms | 2.04 s | 4.9/s |
| 25 | 25/25 | 8 | 17 | 2.78 s | 5.85 s | 3.7/s |
| 50 | 50/50 | 8 | 42 | **18.92 s** | 24.72 s | 1.9/s |

No failures and no orphan pods, but the shape is clear:

- **The pool absorbs exactly its size.** Beyond 8 simultaneous claims, sessions
  fall back to cold starts.
- **Cold-start contention is superlinear.** 50 simultaneous cold starts on the
  14-vCPU Docker VM produce an 18.9 s p50, not 50 × 2 s / parallelism.
- **Warm claims also serialize.** The controller processes paid sessions one at
  a time in a tick; warm claim p50 rose from 26 ms sequential to 80–231 ms at
  10–50 simultaneous creates.
- **Replenishment is not free.** The pool refilled to 8 after each level, but
  replenishment takes ~1.6 s per pod and is bounded to 2 creations per tick.

Interpretation: with a pool of N, a burst of N is fast; a burst much larger than
N is a cold-start stampede. The product choices are (a) size the pool to the
expected burst, (b) admit-shape above the pool (queue or 429), or (c) both.
With the default per-payer limit (30 burst), a 50-create burst would admit the
first 30 and return 20 immediate 429s (token-bucket shape) instead of an ~19 s
p50 — the intended backpressure, and better than accepting work the pool cannot
serve quickly.

## Provisioning concurrency

Even with a warm pool, a burst larger than the pool produces cold starts. A
second, coarser control is **how many cold provisions may be in flight**:

| Env | Default | Meaning |
|---|---:|---|
| `MAX_CONCURRENT_PROVISIONING` | `0` | 0 = unlimited; otherwise PAID sessions wait until a PROVISIONING slot frees |
| `PROVISION_QUEUE_TIMEOUT_MS` | `120000` | fail a PAID session that waits too long (0 disables) |

Excess sessions stay `PAID` and are retried on the next reconcile tick. The
trade is deliberate: queueing adds tail latency but stops the kubelet from being
stampeded, and it gives the warm pool time to refill.

Measured 50-create burst (pool 8, all admission buckets raised):

| Limit | READY p50 | p95 | Warm hits | Cold | Throughput |
|---:|---:|---:|---:|---:|---:|
| unlimited | 18.92 s | 24.72 s | 8 | 42 | 1.9/s |
| 4 | **11.69 s** | 22.82 s | **28** | 22 | 1.7/s |

At 25 simultaneous creates the trade is less favourable: p50 2.63 s (vs 2.78 s)
but p95 9.41 s (vs 5.85 s), because queued sessions wait for a slot. Tune the
limit to the pool replenishment rate and the worker's cold-start parallelism;
4–8 is a sensible starting range, not a universal constant.

## Reproduction

```bash
# capacity: raise both buckets, pool 8, levels 10/25/50
make benchmark-burst

# with default admission (no override), the same burst shows the 429 shape
npx tsx benchmarks/harness/cli.ts burst --levels 50 --max 50 --yes
```

## Not implemented

- **Global capacity guard.** The limiter shapes admission, not total sessions.
  A payer can still fill the node; a `MAX_ACTIVE_SESSIONS` check at entitlement
  creation would be the next layer.
- **Distributed buckets.** The API is a single replica and the buckets are
  in-memory. Multiple replicas would each allow a full bucket; a shared store or
  consistent hashing is required before scaling the API out.
- **Per-tier/per-capability limits.** All sessions share one payer bucket.
- **Queueing.** Rejecting with 429 is the current behavior; a bounded queue with
  an estimated wait would be friendlier for bursty legitimate clients.
