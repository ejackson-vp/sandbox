# Control-plane fault recovery

Status: control-plane fault slice implemented. In-process fault tests cover
settlement, Pod adoption, deletion failure and lifecycle races; the real
harness kills the API, controller or relay on a kind cluster and measures
time-to-convergence. Relay request/response idempotency has dedicated unit
tests. Full suite: 180 passed, 3 skipped.

## Invariants

1. A successful settlement eventually creates an entitlement or is an explicit
   financial exception; it is never silently dropped.
2. Stale/concurrent observations never reserve more capacity than the store's
   atomic admission allows.
3. A terminal session eventually stops consuming compute; Pod deletion
   uncertainty keeps capacity in `RELEASING` rather than freeing it.

## Real cluster harness

`make test-control-faults` runs `scripts/control-faults.ts`.

- `TARGET=controller` (default, 50 sessions): wait until every session has left
  `PAID` and entered provisioning, then force-delete the controller Pod.
  Sessions must reach READY, with one Pod and one allocated reservation each.
- `TARGET=api` (default 20 sessions): same boundary, but the API Pod is killed.
  The SDK retries transient transport/5xx failures during `waitForReady`.
- `TARGET=relay` (default 20 sessions): wait for every session to be READY,
  start one long-running operation per session, wait until the relay reports
  all operations in flight, then kill the relay. The correct outcome is
  fail-closed: every operation fails or becomes indeterminate, every session
  ends `FAILED`, payment records remain, and Pods/reservations drain to zero.
- `SCENARIO=lifecycle` (default 50 sessions): split the sessions across READY,
  ACTIVE and SUSPENDED, kill the controller, then require every operation gate
  to clear, non-suspended sessions to execute again, suspended sessions to stay
  suspended, and the suspended group to resume successfully. Pod and
  reservation counts must match each phase.

Each run records time from injection to convergence, terminal states, Pod count
and reservation counts, then destroys all sessions and requires an empty
workload namespace and zero reservations. `ACTION=pause` freezes the target
process with `SIGSTOP` for `PAUSE_MS` (default 3 s) and resumes it with
`SIGCONT`; `REPEAT` runs the selected scenario multiple times and prints
min/p50/p95/max convergence. `CONVERGENCE_BUDGET_MS` defaults to 30 s for
`TARGET=api` and 60 s for the controller/relay targets (120 s for the lifecycle
scenario); a run that exceeds its budget exits nonzero.

### Observed results

| Fault | Sessions | Convergence | Result |
|---|---|---|---|
| Controller killed during provisioning | 50 | 33.4 s–37.8 s across runs (17.8 s before the deterministic pre-kill wait) | 50/50 READY, 50 Pods, 50 allocated reservations, 0 failures |
| API killed during provisioning | 20 | 6.6 s / 6.8 s | 20/20 READY, 20 Pods, 20 allocated reservations, 0 harness failures |
| Relay killed with one in-flight operation per session | 3–5 | 6.7 s–27.2 s (dominated by relay rollout readiness) | all sessions `FAILED`, all operations failed or reported indeterminate, payment preserved, 0 Pods, 0 reservations |
| Controller killed with 50 live sessions: 30 READY, 10 ACTIVE, 10 SUSPENDED | 50 | 7.6 s restart; 2.2 s resume | all operation gates cleared, 40 non-suspended sessions executed after restart, 10 stayed `SUSPENDED` and then resumed; 40 Pods → 50 Pods, 40 allocated + 10 suspended → 50 allocated, 0 failures |
| Controller paused during provisioning | 5 | 3.21–3.23 s across 3 runs | 5/5 READY, 5 Pods, 5 allocated, 0 failures |
| API paused during provisioning | 5 | 3.25 s | 5/5 READY, 5 Pods, 5 allocated, 0 failures |
| Relay paused with 5 operations in flight | 5 | 4.92 s | all 5 operations succeeded, 0 terminal sessions, 5 Pods, 5 allocated |
| Controller paused with 50 live sessions | 50 | 12.3 s total; 10.2 s to post-restart state; 2.0 s resume | same 40 allocated + 10 suspended → 50 allocated result as the kill case, 0 failures |

The earlier API-kill run reported 18 `fetch failed` errors while Pods and
reservations were already correct. That was a client bug: `waitForReady`
treated a restarting API as a session failure. It now retries transport errors
and 5xx responses until its deadline.

A cluster-backed finalizer case (`keeps a Pod terminating under a finalizer
until the finalizer is removed`) holds a real sandbox Pod in `Terminating`
after destroy and expects the reservation to stay `RELEASING`; removing the
finalizer lets Kubernetes finish deletion and the Pod disappear.

## Scheduled runs (nightly)

`.github/workflows/nightly-faults.yml` runs this matrix plus the cluster
security suite on a self-hosted runner every day at 04:17 UTC
(`cron: "17 4 * * *"`), and on demand from **Actions → nightly faults → Run
workflow** (`full` or `smoke`, optionally fail-fast). PR CI
(`.github/workflows/ci.yml`) does not depend on it and stays cluster-free.

The workflow is opt-in: GitHub-hosted runners cannot reach a cluster, so
preflight skips with a notice until the repository variable
`SANDBOX_FAULT_RUNNER` holds a JSON array of runner labels:

```json
["self-hosted", "linux", "x64", "sandbox-faults"]
```

### Runner and secret contract

| Requirement | Why |
|---|---|
| Self-hosted runner matching `SANDBOX_FAULT_RUNNER` | Needs a real cluster |
| Docker, `kind`, `kubectl`, Cilium CLI | `SANDBOX_FAULT_CLUSTER=kind` runs `make up` |
| 8 vCPU / 16 GiB RAM / ~40 GiB disk | 50-session scenarios plus images |
| Node 24 and Go per `guest/go.mod` | Installed by `setup-node` / `setup-go` |
| `SANDBOX_FAULT_KUBECONFIG` secret | Only for `SANDBOX_FAULT_CLUSTER=existing` |

Repository variables:

| Name | Default | Meaning |
|---|---|---|
| `SANDBOX_FAULT_RUNNER` | unset | Runner labels; unset skips the workflow |
| `SANDBOX_FAULT_CLUSTER` | `auto` | `kind`, `existing`, or `auto` (secret set → `existing`) |
| `SANDBOX_FAULT_API_URL` | `http://localhost:8080` | API the harness drives; loopback gets a port-forward |
| `SANDBOX_FAULT_MATRIX` | `full` | `full`, `smoke`, or comma-separated case names |
| `SANDBOX_FAULT_KIND_CLUSTER` | `x402-sandbox` | kind cluster name recreated by `make up` |

`existing` mode targets a long-lived cluster (homelab or tailnet). The secret
holds a kubeconfig whose context is already selected; the workflow writes it
with mode 600 under `$RUNNER_TEMP`, never prints it, pins `KUBECTL_CONTEXT`
from it, and never creates or deletes that cluster. Use a scoped credential
that can only reach the sandbox namespaces, not an admin kubeconfig.

### Matrix cases

| Case | Target | Fault | Sessions | Budget |
|---|---|---|---|---|
| `controller-kill` | controller | kill during provisioning | 50 | 60 s |
| `api-kill` | api | kill during provisioning | 20 | 30 s |
| `relay-kill` | relay | kill with operations in flight | 5 | 60 s |
| `lifecycle-restart` | controller | kill with READY/ACTIVE/SUSPENDED sessions | 50 | 120 s |
| `controller-pause` | controller | `SIGSTOP`/`SIGCONT` during provisioning | 5 | 60 s |
| `api-pause` | api | `SIGSTOP`/`SIGCONT` during provisioning | 5 | 30 s |
| `relay-pause` | relay | `SIGSTOP`/`SIGCONT` with operations in flight | 5 | 60 s |

`full` is all seven; `smoke` is `api-kill`, `controller-pause` and
`relay-pause`. The relay-restart-mid-create case joins the matrix once #17
lands.

### Artifacts and reading a red run

```text
artifacts/faults/
  summary.json   # every case: passed, exitCode, convergedMs, budget, failureReasons, harness report
  summary.md     # the same table, also appended to the job summary
  <case>.json    # one machine-readable result per scenario
  <case>.log     # full harness stdout/stderr for that scenario
artifacts/security/
  junit.xml      # cluster security suite, one test case per assertion
  vitest.log
```

The job fails when a scenario exits nonzero (budget breach or state
assertion), when no JSON result is printed, or when the security suite fails.
The final `report` step re-emits each failure as a GitHub annotation and
rebuilds `summary.md` from the artifacts, so triage does not require the
cluster:

1. Open the run summary — the case table shows convergence against its budget.
2. Read `summary.json` for `cases[].failureReasons`, `convergedMs` and the raw
   report (`podCount`, `reservations`, `terminal`, `failures`, `execErrors`).
3. Read `<case>.log` for the harness output that produced the assertion.
4. Read `security/junit.xml` for the failing test names.

### Local reproduction

```bash
make up                                    # kind + Cilium + images + deploy
npm ci && npm run build && make guest
node scripts/fault-matrix.mjs              # full matrix → artifacts/faults
FAULT_MATRIX=smoke node scripts/fault-matrix.mjs
FAULT_MATRIX=relay-kill node scripts/fault-matrix.mjs
node scripts/fault-matrix.mjs report       # re-render from existing artifacts
make security-test                         # cluster security suite
make test-control-faults TARGET=relay      # one case, unchanged
```

`scripts/fault-matrix.mjs` only sequences the existing harness: for each case
it runs `make test-control-faults` with
`TARGET`/`SCENARIO`/`ACTION`/`SESSIONS`/`CONVERGENCE_BUDGET_MS` in the
environment, captures the JSON block `scripts/control-faults.ts` already
prints, and writes the artifacts. It also starts a port-forward to `svc/api`
when `API_URL` is loopback, so no manual forwarding is needed.

## In-process fault cases

| Fault | Test | Observed behavior |
|---|---|---|
| Controller crash after settlement, before entitlement | `recovers when the controller crashes after settlement but before entitlement` | first request returns 503 with no session; retry after intent staleness returns the same paid session; one session created |
| Crash after Kubernetes/Pod create, before `PROVISIONING` | `adopts a Pod created just before the controller crashed` | next reconcile adopts the existing Pod, does not create a duplicate, leaves the relay token intact, reaches READY |
| Persistent Pod-deletion failure | `keeps capacity reserved while a deleted Pod is still observed` | reservation stays `RELEASING`; after deletion is restored, orphan sweep + reaper release capacity |
| Duplicate/concurrent payment | `creates exactly one session …`, `cannot create multiple sessions under concurrent retries` | one session; replays return the same capability |
| Destroy while `SUSPENDED` | `destroys a suspended session instead of orphaning it` | session reaches `DESTROYED`, workspace PVC cleared, no Pod left |
| Concurrent suspend | `serialises concurrent suspend requests without leaving a pod` | exactly one suspend wins, the other returns `not_suspendable`, no Pod left |
| Destroy during `SUSPENDING` | `lets destroy win while a suspend is between SUSPENDING and SUSPENDED` | destroy wins; final state `DESTROYED`, no Pod left |
| Destroy during `RESUMING` | `lets destroy win while a resume is between SUSPENDED and RESUMING` | destroy wins; final state `DESTROYED`, no Pod left |
| Duplicate destroy | `accepts duplicate destroys and still reaches a single terminal state` | one terminal `DESTROYED` row, no Pod left |
| In-flight operation at controller crash | `clears an interrupted operation slot after a controller restart` | request is marked `abandoned`, the session gate is cleared, and a new operation succeeds after restart |
| Replayed relay request | `does not re-execute a completed request and keeps the first response` | retry sees the cached outcome; the guest receives one request; a delayed duplicate response cannot replace the first |
| Retry of an in-flight relay request | `treats a retry of an in-flight request as pending without re-forwarding` | guest receives one frame |
| Late success after a guest error | `keeps a guest error terminal for late and duplicate responses` | late/duplicate responses cannot turn the recorded error into success |

The lifecycle-race cases exposed a product bug: `destroyRequested` was only
checked for `READY`/`ACTIVE`, so a destroy requested while `SUSPENDED` or
`SUSPENDING` left the session and its workspace behind. The reconciler now
applies a client destroy from every non-terminal state.

The persistent-deletion case exposed a capacity bug: the reaper confirmed a
release when `getPod` returned `Succeeded`/`Failed`, even though the Pod object
still existed. Release now requires the Pod object to be gone, and the orphan
sweeper reports deletion failures instead of logging that an undeleted Pod was
reaped.

A controller crash during an operation left `active_request_id` set in SQLite,
so the paid session stayed `busy` forever. Startup now marks pending requests
`abandoned` and clears the gate. The old outcome remains available if the relay
cached the result; otherwise it is explicitly `result_expired`. The guest's own
single-operation slot still prevents overlapping work if the old command is
still running.

The Pod-adoption case required two earlier product fixes:

- `LocalProvisioner.createPod` is idempotent for a live Pod.
- `Provisioning.provision` lists existing Pods before creating one and adopts a
  matching session Pod instead of rotating the relay token.

## Still required

- Controller restart with sessions in transient SUSPENDING/RESUMING/
  TERMINATING states.
- Duplicate/delayed Kubernetes API responses against the real provisioner.

## Non-goals

No Postgres, Redis, leader election, multiple controller replicas, autoscaling
or distributed queueing. SQLite is deliberate for studying transactions.
