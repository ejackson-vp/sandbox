# Admission control

> Benchmark tooling and raw results live in the [sandbox-bench](https://github.com/ejackson-vp/sandbox-bench) repository; paths below refer to that repo.

Status: two-bucket admission, a durable per-payer and global create budget, and
global capacity admission are implemented; the burst matrix and
constrained-capacity results are measured on the local kind rig. Guest-image admission is a Kyverno policy shipped in
[deploy/kubernetes/kyverno](../deploy/kubernetes/kyverno/README.md), verified by
a documented cluster check rather than by CI.

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

## Durable per-payer and global budget

The two token buckets live in the API process. A restart refills every bucket,
and the per-payer key comes from a client-chosen field (F-09), so neither is a
bound on a determined client. The controller therefore keeps a **durable fixed
window** per payer and one **global** window in Postgres (`payer_budgets`, schema
v14), checked before any capacity hold, intent claim or settlement:

| Budget | Default | Key | Bounds |
|---|---:|---|---|
| per-payer creates | 60/window | proven wallet address | one payer's create rate across restarts |
| per-payer spend | 50 USDC/window | proven wallet address | settled value per payer |
| per-payer concurrency | 4 | proven wallet address | parallel live sessions |
| global creates | 2000/window | constant `global` | total create attempts, whatever the `from` field says |
| global concurrency | 200 | constant `global` | total live sessions |

| Env | Default | Meaning |
|---|---:|---|
| `BUDGET_WINDOW_MS` | `3600000` | fixed window length (60 s to 24 h) |
| `PAYER_CREATES_PER_WINDOW` | `60` | creates per payer per window |
| `PAYER_SPEND_PER_WINDOW` | `50000000` | atomic units (USDC 6dp), exact decimal string |
| `PAYER_CONCURRENT_SESSIONS` | `4` | 0 disables the check |
| `GLOBAL_CREATES_PER_WINDOW` | `2000` | creates across all payers |
| `GLOBAL_CONCURRENT_SESSIONS` | `200` | 0 disables the check |

Three properties matter more than the numbers:

- **The key is proven, not claimed.** The check runs after the client commitment
  is verified against `authorization.from`, so the budget is keyed on a wallet
  the caller demonstrated control of. An unproven create never reaches it.
- **Creates are counted at admission; spend only when money moves.** A
  reservation counts an attempt. Spend is written in the same database transaction
  as the payment and ledger rows (`completeEntitlement`), against the payer the
  facilitator verified. A failed settlement therefore cannot lock a payer out,
  and a settled payment cannot be invisible to the budget.
- **Concurrency is counted from live rows**, not a counter, so a crash cannot
  leak a slot.

A rejection is `429` with the budget that refused, the seconds until the window
resets and what is left:

```json
{
  "error": "budget_exhausted",
  "scope": "payer_create",
  "retryAfterSeconds": 900,
  "windowResetsAt": "2026-11-11T16:03:31.000Z",
  "remaining": { "payerCreates": 0, "payerSpend": "50000000", "payerConcurrent": 4,
                 "globalCreates": 1200, "globalConcurrent": 190 }
}
```

`scope` is one of `payer_create`, `payer_spend`, `payer_concurrent`,
`global_create`, `global_concurrent`. A `null` concurrency value means that
dimension is unlimited (its limit is `0`). No payment is taken for a rejected create:
the check runs before the intent is claimed and before settlement. If the budget
store cannot be reached the API answers `503 admission_unavailable` (retryable)
rather than admitting unaccounted work.

This is a fixed window, not a sliding one: a client can spend the whole window in
one burst at a boundary. The in-memory bucket is what smooths that, which is why
it stays in front. Metrics: `sandbox_budget_rejections_total{scope}` in the
controller, `sandbox_rate_limited_total{scope="payer_budget"|"global_budget"}` in
the API.

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

## Reconcile concurrency

The reconciler used to `await` each session in a pass one at a time, so one slow
Kubernetes or relay call was the head of the line for every other session.
Each phase now runs through a bounded worker pool:

| Env | Default | Meaning |
|---|---:|---|
| `RECONCILE_CONCURRENCY` | `8` | sessions reconciled in parallel per phase (1 = sequential) |
| `RECONCILE_BUDGET` | `1000` | max sessions selected for dispatch in one readiness pass |

A session already in flight is skipped by a later pass and retried on the next
tick, so lease expiry and termination never run twice for one id. Terminal-pod
cleanup is a separate phase that runs after readiness; it never shares the
readiness queue or its ordering assumptions.

## Due-time scheduling

A pass no longer sweeps every live session. Each session carries a
`next_due_ms`; the tick reads at most `RECONCILE_BUDGET` due rows in due order
from the `sessions_due` partial index, and re-arms a processed session before
the next pass can select it again. The re-due cadence per state lives in
`controller/src/reconcile-cadence.ts` (PROVISIONING/RESUMING 250 ms, READY and
ACTIVE 1 s, SUSPENDING 500 ms, SUSPENDED 15 s, TERMINATING 250 ms). Lease
expiry is still decided by the controller clock; the READY cadence only bounds
how long before the next pass notices it, with pod deletion as the backstop.
`RECONCILE_INTERVAL_MS` remains the timer cadence, and a pass that overruns it
sets `sandbox_reconcile_saturated`; due sessions left over are exported as
`sandbox_reconcile_due_backlog` rather than triggering an immediate re-entry.

Two bounded-label metrics make bursts visible before they become tail latency:

- `sandbox_reconcile_queue_depth{phase="readiness"|"cleanup"}` — sessions
  waiting for a worker.
- `sandbox_reconcile_queue_wait_seconds{phase=...}` — time between being listed
  and being picked up by a worker.
- `sandbox_reconcile_in_flight{phase=...}` — sessions currently running.

No session ids or per-session labels are exported.

## Reproduction

```bash
# in the sandbox-bench repo. Capacity run: raise both buckets, pool 8,
# levels 10/25/50.
POOL_SIZE=8 LEVELS=10,25,50 ./scripts/benchmark-warm-pool-burst.sh

# with default admission (no override), the same burst shows the 429 shape
npx tsx benchmarks/harness/cli.ts burst --levels 50 --max 50 --yes
```

## Capacity admission

Capacity accounting is `baseline` by default; set `CAPACITY_ACCOUNTING=peak`
to reserve limits instead. Before a `402` the API asks the controller for a
capacity preflight. After the
payment header is validated, but **before settlement**, it creates an
authoritative hold keyed by payment key and spec hash. A capacity rejection is
`503 capacity_unavailable` with `retryable` and requested baseline resources;
no payment is settled.

## Guest image admission

Two independent controls decide which guest image a session runs:

1. **The controller** only runs a runtime profile from its own catalog, and pulls
   `repo@sha256:<64 hex>` whenever a digest is configured. With
   `KUBERNETES_ENABLED=true` a non-pinned digest is a startup error
   (`controller/src/runtime-profiles.ts`), so a moved tag cannot change what runs
   inside the VM.
2. **The API server**, via Kyverno, rejects a guest pod whose image is not
   `<repository>@sha256:<64 characters>` in an allowed repository, or whose
   digest is not one of the released digests. The shape rule uses `?` wildcards
   rather than a hex regex because Kyverno's deny conditions have no regex
   operator; the allowlist is what pins the exact digest. Manifests and install
   steps live in [deploy/kubernetes/kyverno](../deploy/kubernetes/kyverno/README.md).

The second control exists because the first one depends on the controller being
honest. It is inert unless an operator installs Kyverno, and it is not part of
`deploy/kubernetes/kustomization.yaml`.

Scope is the namespace label `x402.io/image-policy`, which
`deploy/kubernetes/00-namespaces.yaml` sets to `enforce` on `sandbox-workloads`:

| Label value | repository + `@sha256:` shape | released digest allowlist |
| --- | --- | --- |
| `enforce` | enforced | enforced |
| `dev-unpinned` | enforced | skipped |
| absent | policy does not match | policy does not match |

`dev-unpinned` is the documented local-kind exception: `deploy/kind/apply.sh`
loads a locally built image and pins the digest read out of containerd, which is
machine-specific and therefore cannot appear in a committed allowlist.
`deploy/kind/apply.sh` sets the label only when the Kyverno CRD exists. A
production cluster must never carry it, and deleting the label (rather than
setting it) turns both rules off, so it ships with the namespace.

The allowlist in rule 2 duplicates `GUEST_IMAGE_DIGEST` and each
`RUNTIME_PROFILES.<profile>.digest` from `deploy/kubernetes/03-config.yaml`.
Both must change in the same commit; a missing entry rejects the pod, which is
the intended failure direction. Verifying the policy needs Kyverno and a live
API server (`kubectl apply --dry-run=server`), so it is a documented manual step
and not a CI job. `tests/unit/provisioning-profile-image.test.ts` covers the
controller-side refusal.

## Not implemented

- **Policy enforcement in CI.** The Kyverno policy is a manifest plus a manual
  check; no PR CI job installs Kyverno or runs `kyverno test`.
- **Signing/attestation verification at admission.** The policy pins a digest.
  It does not verify the Sigstore bundle that `docs/release-process.md` produces,
  so a digest that was built by the wrong pipeline would still be admitted.

- **Capacity wait queue.** A retryable rejection is immediate; clients retry
  themselves. A bounded wait queue is the next experiment.
- **Distributed in-memory buckets.** The API is a single replica and the token
  buckets are in-memory, so multiple replicas would each allow a full burst. The
  durable budget behind them is shared (it lives in the controller's database),
  so the aggregate ceiling holds; only the burst smoothing is per replica.
- **Per-tier/per-capability limits.** All sessions share one payer bucket.
- **Queueing.** Rejecting with 429 is the current behavior; a bounded queue with
  an estimated wait would be friendlier for bursty legitimate clients.
