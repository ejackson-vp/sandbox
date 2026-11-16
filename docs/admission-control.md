# Admission control

> Benchmark tooling and raw results live in the [sandbox-bench](https://github.com/ejackson-vp/sandbox-bench) repository; paths below refer to that repo.

Status: two-bucket admission, a durable per-payer and global create budget, the
create kill switch and global capacity admission are implemented; the burst
matrix and constrained-capacity results are measured on the local kind rig. Guest-image admission is a Kyverno policy shipped in
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

## Concurrent request cap

The token buckets bound the *rate* of creates. They say nothing about how many
requests one client may hold open at once, which is the shape that exhausts a
process: ten thousand slow reads spend no tokens. While the API was reachable
only over the tailnet that was acceptable, one operator and one client, so the
cap was deliberately absent ([production-readiness.md](production-readiness.md)
§2). Behind a public tunnel it is required.

| Env | Default | Meaning |
|---|---:|---|
| `MAX_CONNECTIONS_PER_CLIENT` | `64` | in-flight requests per `req.ip`; `0` disables the per-client check |
| `MAX_CONNECTIONS_GLOBAL` | `2048` | in-flight requests across all clients; `0` is refused at startup |

A request takes its slot synchronously when it is dispatched and returns it on
`finish` or `close`, so a success, a handler error, a client abort and a
response a timeout tore down all release it. Sockets are not counted:
keep-alive means one socket can carry many requests, and a request already
answered must not keep a slot. The key is `req.ip`, which follows
`TRUST_PROXY_HOPS`, so behind the tunnel it is the real client rather than the
tunnel pod.

`/healthz` and `/readyz` are exempt and take no slot: a client at its cap must
not be able to make a healthy pod look unready.

A refusal is `429 { "error": "connection_limit" }`, counted as
`sandbox_connection_limit_total{scope="client"|"global"}`. The per-client check
runs first, so a client over its own cap is named as such rather than blamed on
the shared pool. A refusal is not logged per request: shedding load is the
point, and a log line each would move the flood to stderr.

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
- **An allowlisted payer gets its own namespace.** A free session (ADR 0013)
  reserves under `allow:<address>` and counts only `source = 'allowlist'` live
  sessions, so it can never consume or exhaust the paying payer's window. The
  entry's own `max_concurrent` applies on top.

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

## Create kill switch (emergency stop)

During a payment or abuse incident an operator needs to stop **new** creates in
seconds without touching sessions that are already running and already paid for.
The create kill switch does that. It is one durable row, not an environment
variable:

```bash
sandbox admin killswitch enable --reason "payments: facilitator double-settling (INC-431)" \
  --until 2026-11-16T08:00:00Z
sandbox admin killswitch status
sandbox admin killswitch disable
```

**Why a row.** An env var needs a rollout, and a rollout during an incident is
the thing you cannot afford: it restarts the API, and it stops reads for live
sessions while it happens. A row is flipped by one authenticated request, takes
effect on the next create on every API replica, and survives a restart of either
process. The controller owns it (`create_switch`, schema v21, one row pinned to
`id = 1`); the API reads it over `GET /internal/create-switch` before it does any
payment or capacity work, so there is no second copy to go stale.

**What a refusal looks like.** The create use case checks the switch first, before
the spec is priced, before a 402 challenge is minted, before any capacity hold,
intent claim or settlement. A caller is neither charged nor handed a challenge
its payment could never be used against:

```json
{ "error": "creates_disabled", "retryable": true,
  "message": "payments: facilitator double-settling (INC-431)" }
```

`message` is the operator's `--reason`, or a default that says creates are
paused and existing sessions are unaffected. The status is `503`.

**What it does not do.** It refuses `POST /v1/sessions` and nothing else. Session
status, operations (exec, transfer, file access), suspend/resume, destroy and
lease expiry all work exactly as before, through the same routes and the same
store. The refusal is in the create use case, not in a middleware, so there is no
path from a live session through it.

**A missing row means off.** Every database that upgrades through v21 has no
row, and an older build that never wrote one behaves as it always did. A **read
error means refused**: the API answers `503 admission_unavailable` (retryable)
rather than admitting sessions while the store that holds the switch is
unreachable, because a session admitted during an incident cannot be undone
without refunding it. That is a deliberate choice, and it is the reason for the
deployment order below.

**Deployment order.** The switch route arrives with the controller. Deploy the
controller before the API: a new API talking to an old controller cannot read the
switch and therefore refuses creates. An old API talking to a new controller does
not consult the switch at all, so it is open until it is replaced.

**Expiry.** `--until` is an ISO 8601 instant; omitted or `none` means "until
disabled". The expiry is evaluated on read against the reader's clock, so the
switch turns itself off with no worker, no cron and no second write. `status`
still shows the reason, the actor, when it was set and when it expired, and
`expired: true` says the row lapsed rather than being disabled. An `--until` in
the past is refused by the CLI, by the controller route and by the store: a row
that says "on" and behaves off is the one shape `status` cannot explain.

**Audit.** The row stores the operator's `--reason` (1-280 characters), an
`--actor` string that defaults to `$USER`, and the timestamp of the write. The
actor is a name, not a credential: the credential is the existing
`CONTROLLER_ADMIN_TOKEN`, and there is no second token to leak. `status` shows
all three.

| Metric | Type | Labels | Read it as |
| --- | --- | --- | --- |
| `sandbox_creates_disabled` | gauge | none | `1` while new creates are refused. Published by the API on every switch read and by the controller when an operator reads or flips it, so a flip shows up without create traffic |
| `sandbox_create_refusals_total` | counter | `error="creates_disabled"\|"admission_unavailable"` | creates refused by `error` code. Split by the code to tell "an operator stopped it" from "the switch could not be read" |

Neither family carries the reason or the actor: one is free text and the other is
a name, and a metric label is a bad place for either. The reason is in the
response body and on the row; the refusal is in the API log
(`create_refused_disabled`, `create_switch_unreadable`).

**At 2am.** If creates have to stop, run `enable` with a reason you would be
happy to read tomorrow, set `--until` so it cannot outlive the incident, check
`sandbox_creates_disabled` and the `creates_disabled` refusals to confirm the API
agrees, and remember that live sessions are still running and still need their
lease expiry to do its job.

## Allowlist volume (detection, not a ceiling)

`PAYER_ALLOWLIST_ENABLED=true` gives a proven allowlisted address a $0 session
(ADR 0013). Each entry is bounded per create by `max_tier` and `max_concurrent`,
and the free path reserves under `allow:<address>`, so a free session cannot
consume a paying payer's window. Neither cap watches volume: a wallet whose key
is shared or leaked stays inside them and only looks different in the counters.

What to watch, both on the API process that makes the decision:

| Metric | Labels | Read it as |
| --- | --- | --- |
| `sandbox_sessions_total{source="allowlist"}` | `source` | free sessions actually created |
| `sandbox_allowlist_decisions_total{result}` | `result` | outcome of every consultation: `granted`, `not_allowlisted`, `disabled`, `tier_not_allowed`, `concurrency_exhausted`, `lookup_failed` |

`not_allowlisted` is the ordinary paid path, because every create consults the
list while the feature is on, and `lookup_failed` is a controller that could not
be reached (a 503, no payment taken). Neither is a free-tier attempt. No label
carries the address or the operator label: the address is customer identity.

Two SLO rules read those names
([sandbox-slo.yaml](../deploy/monitoring/contract/rules/sandbox-slo.yaml)):

- **`SandboxAllowlistSessionRateHigh`** fires above 30 free sessions an hour,
  averaged over 15 minutes and held for 15. With the default
  `max_concurrent = 1` and the 60 s `short` tier, one wallet tops out near 60
  sequential short sessions an hour; 30 is half that ceiling and far above the
  occasional create a named agent makes. It means free capacity is being used at
  a rate no single named wallet should reach.
- **`SandboxAllowlistAttemptsToGrantsHigh`** fires when attempts that reached an
  allowlist row run above five per created free session for 10 minutes, gated on
  at least 12 attempts in the window. A behaving client makes one attempt per
  session, so most of that ratio is refusals, which is what repeatedly hitting
  `max_concurrent` from a shared or leaked key looks like. Split it by `result`
  to see which refusal dominates. A grant that later fails on budget or capacity
  also lifts the ratio, so confirm in the API log (`allowlist_refused`) before
  treating it as a leak.

Neither rule is a limit. If the traffic is not the wallet's owner, disabling the
row is the response:

```bash
sandbox admin allowlist disable 0x<address>
```

It takes effect on the next create: every request runs `authorize`, which opens a
transaction and reads the row under an address-scoped advisory lock before it
answers, so there is no cache to expire and no restart. Disabling keeps the row
and its label (a re-add clears `disabled_at`), and a refusal falls back to the
paid path rather than erroring, so the caller loses the free session and nothing
else.

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
