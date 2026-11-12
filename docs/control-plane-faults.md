# Control-plane fault recovery

Status: control-plane fault slice implemented. In-process fault tests cover
settlement, Pod adoption, deletion failure and lifecycle races; the real
harness kills the API, controller or relay on a kind cluster and measures
time-to-convergence. Relay request/response idempotency has dedicated unit
tests. Full suite: 180 passed, 3 skipped. The relay-restart create window (#17)
has an in-process integration case against the real guest plus a cluster case
that was added without a local cluster run; see
[Relay restart during a create](#relay-restart-during-a-create-17).

## Invariants

1. A successful settlement eventually creates an entitlement or is an explicit
   financial exception; it is never silently dropped.
2. Stale/concurrent observations never reserve more capacity than the store's
   atomic admission allows.
3. A terminal session eventually stops consuming compute; Pod deletion
   uncertainty keeps capacity in `RELEASING` rather than freeing it.

## Health probes

Liveness and readiness answer different questions. A process whose dependency
is down is still a live process: restarting it does not heal the dependency, and
for the single-writer controller a restart can make recovery slower. Liveness
therefore checks only that the event loop still answers. Readiness checks what
the process needs in order to serve traffic.

| Component | Liveness | Readiness | Readiness checks |
| --- | --- | --- | --- |
| API (`10-api.yaml`) | `GET /healthz` | `GET /readyz` | Controller readiness reachable |
| Controller (`11-controller.yaml`) | `GET /internal/healthz` | `GET /internal/readyz` | Store writable and migrated, relay reachable, provisioner reachable |
| Relay (`12-relay.yaml`) | `GET /healthz` | `GET /readyz` | In-memory registry serving (no external dependency) |

The relay's `/healthz` additionally returns its per-process `generation`; the
controller's registration path depends on that value, so it stays on the
liveness endpoint. The controller's `/healthz` and `/internal/readyz`, and the
relay's `/healthz` and `/readyz`, are unauthenticated: kubelet cannot present
the admin token. NetworkPolicy still limits who can reach them, and no response
contains tokens, session ids, payloads or exception text.

### Semantics

- **Store.** Readiness reads `PRAGMA user_version` and requires it to equal the
  build's `SCHEMA_VERSION`, then runs a no-op `UPDATE` inside a transaction and
  rolls it back. A read-only connection accepts `BEGIN IMMEDIATE` but rejects
  the write, so the probe detects a read-only file and a locked database, not
  just an open handle. The probe lowers `busy_timeout` to 200 ms so Kubernetes
  owns the timeout budget instead of a stuck write.
- **Relay.** A bounded `GET /healthz` (1.5 s) on the relay. A failed probe means
  the controller cannot register or forward operations, which is exactly when a
  paid create would stall in `PAID`.
- **Provisioner.** One-pod list against the sandbox namespace, proving the
  Kubernetes API is reachable and the controller identity can still read what it
  writes. In local process mode it checks that the guest binary exists. A
  provisioner without a `healthCheck` is omitted rather than treated as failed.
- **API.** The API holds no durable state and must reach the controller for
  every create, so its only readiness dependency is the controller. The API
  does not forward the controller's component detail; `/readyz` is reachable
  through the ingress and reports only `controller: ok | not_ready |
  unreachable`.

### Caching and failure

Dependency results are cached for about 2 s, including negative results, and
concurrent probes share one in-flight check. Kubernetes readiness probes run
every 5 s with `failureThreshold: 3`, so a dependency outage removes the pod
from Service endpoints within roughly the probe period without turning each
probe into a store write or Kubernetes API call. Liveness probes are on a
longer period (15 s) and never touch a dependency, so a store lock or relay
blip cannot restart a healthy process.

A failed readiness check returns HTTP 503 with a bounded component map:

```json
{
  "ok": false,
  "checkedAt": 1731000000000,
  "cached": false,
  "components": {
    "store": { "ok": false, "reason": "read_only" },
    "relay": { "ok": true },
    "provisioner": { "ok": true }
  }
}
```

Reason codes are a closed set (`closed`, `unavailable`,
`migrations_incomplete`, `read_only`, `locked`, `write_failed`, `unreachable`,
`not_ready`). Dependency exception messages are never returned.

Readiness is an admission signal, not a recovery mechanism: the reconciler
still owns retries, refunds and session convergence for the faults below.

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
- `TARGET=relay SCENARIO=create-restart` (5 sessions): restart the relay as
  soon as the paid creates return, so the rollout overlaps provisioning. Every
  create must reach READY against the replacement relay, no session may be
  terminal, and no session may end `pod_terminated`.
- `SCENARIO=lifecycle` (default 50 sessions): split the sessions across READY,
  ACTIVE and SUSPENDED, start one long operation per ACTIVE session, wait until
  the relay reports the guests' own active-operation count, kill the controller,
  then require every interrupted request to report `outcome_unknown`, every
  ACTIVE session to stay busy, and a new operation to be refused without
  reaching the guest. After cancelling the old commands,
  every operation gate must clear, non-suspended sessions must execute again,
  suspended sessions must stay suspended, and the suspended group must resume
  successfully. Pod and reservation counts must match each phase.

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
| Relay restarted while paid creates are provisioning | 5 | 4.5 s–9.5 s across three runs | 5/5 READY, 5 Pods, 5 allocated reservations, no terminal sessions |
| Controller killed with 50 live sessions: 30 READY, 10 ACTIVE, 10 SUSPENDED | 50 | 7.6 s restart; 2.2 s resume | all operation gates cleared, 40 non-suspended sessions executed after restart, 10 stayed `SUSPENDED` and then resumed; 40 Pods → 50 Pods, 40 allocated + 10 suspended → 50 allocated, 0 failures |
| Controller paused during provisioning | 5 | 3.21–3.23 s across 3 runs | 5/5 READY, 5 Pods, 5 allocated, 0 failures |
| API paused during provisioning | 5 | 3.25 s | 5/5 READY, 5 Pods, 5 allocated, 0 failures |
| Relay paused with 5 operations in flight | 5 | 4.92 s | all 5 operations succeeded, 0 terminal sessions, 5 Pods, 5 allocated |
| Controller paused with 50 live sessions | 50 | 12.3 s total; 10.2 s to post-restart state; 2.0 s resume | same 40 allocated + 10 suspended → 50 allocated result as the kill case, 0 failures |

The earlier API-kill run reported 18 `fetch failed` errors while Pods and
reservations were already correct. That was a client bug: `waitForReady`
treated a restarting API as a session failure. It now retries transport errors
and 5xx responses until its deadline.

The lifecycle row above was measured before the operation-fence assertions
existed. `scripts/control-faults.ts` now additionally requires
`outcome_unknown` for the interrupted request, a closed gate and refused new
operation while the guest is busy, and a higher execution epoch for the next
operation. That updated profile requires a real cluster and was not run while
implementing the fence; the in-process integration test
(`tests/integration/operation-fencing.test.ts`) exercises the same contract
against the real guest and a surviving relay.

A cluster-backed finalizer case (`keeps a Pod terminating under a finalizer
until the finalizer is removed`) holds a real sandbox Pod in `Terminating`
after destroy and expects the reservation to stay `RELEASING`; removing the
finalizer lets Kubernetes finish deletion and the Pod disappear.

## Relay restart during a create (#17)

The relay registry is in memory and the Deployment replaces the pod with
`maxSurge: 0`, so a registration accepted by the old pod is gone with it. The
window that failed during the 0.1.16 rollout was:

1. the controller registers a paid session on the old relay;
2. the old relay is replaced before the guest dials, so the replacement never
   learns the registration;
3. the guest exhausts its dial window before the controller re-registers.

A paid create that overlaps a restart must reach READY. If the replacement
never becomes ready, the create must fail before READY with a refundable reason
(`provisioning_timeout`), never a charged `pod_terminated`.

### Enforced behaviour

- **Admission gate.** A `PAID` session is not provisioned until
  `GET /healthz` on the relay succeeds. It stays `PAID` with no Pod and no
  capacity claim, and the next reconcile pass retries. After
  `PROVISIONING_TIMEOUT_MS` without a ready relay it is terminated with
  `provisioning_timeout` and refunded. This is what makes the previous
  operational mitigation ("wait for the relay") an enforced one.
- **Generation-checked registration.** Each relay process generates a random
  `generation` at start, exposes it on `/healthz`, and returns it from
  `POST /internal/register`. `register` also accepts the generation the
  controller probed; a mismatch is `409 relay_generation_changed`. The
  controller probes, registers with that precondition, probes again, and
  retries with backoff if the generation changed. A registration that landed
  on a terminating relay is therefore discarded instead of being treated as
  success.
- **Endpoint re-resolution and Pod reprovision.** The relay endpoint is a ready
  Pod IP, not a stable ClusterIP (a Kata guest cannot use the ClusterIP). The
  controller does not cache it, re-resolves it after registration, and, if the
  relay generation changes after the Pod was created but before the guest
  connects, deletes that Pod and creates it again against the current endpoint.
  A create that would otherwise sit on a dead IP now converges in a few
  seconds instead of timing out.
- **Fresh admin connections.** Relay admin calls send `Connection: close`.
  A Kubernetes Service DNATs an existing keep-alive socket to the old Pod even
  after its endpoint is removed, so without this the controller can keep
  reading `state` and re-registering on the relay that is being replaced while
  the guest's new dial reaches the replacement. Fresh connections always reach
  the current endpoint set.
- **Deterministic handshake.** `awaitReady` brackets the guest hello with two
  generation probes. If they differ, the hello came from a relay that is being
  replaced and the session is not marked READY (which would charge for a guest
  that is about to exit); the next pass re-registers on the replacement.
- **Startup wake.** A relay that starts serving calls the controller's
  `/internal/wake`, so `PROVISIONING` sessions re-register in the next pass
  instead of waiting for the poll interval.
- **Guest dial window.** The session guest retries the relay for 150s
  (`RELAY_DIAL_TIMEOUT_SECONDS`), comfortably longer than the 90s
  `PROVISIONING_TIMEOUT_MS`. If the relay never returns, the controller gives
  up and refunds first; the guest cannot turn a control-plane outage into a
  terminal Pod observed as `pod_terminated`.
- **Rollout hygiene.** The relay Deployment sets
  `terminationGracePeriodSeconds: 10` (instead of the 30s default) and
  `minReadySeconds: 2`. Guest links are dropped by the relay shutdown path
  anyway; a shorter grace shrinks the interval in which a stale admin
  connection can still be answered by the old Pod.

A pre-READY Pod exit (for example a guest that latched onto the old relay and
exited when the link dropped) is still `pod_terminated`/`FAILED`, but the
refund backstop applies because `readyAt` is null. The invariant is "no charged
session ends with `pod_terminated`", not "the string never appears".

### Local verification

`tests/integration/relay-restart.test.ts` uses the real guest and two real
relays behind a TCP router that pins established connections to the old
upstream (the kube-proxy behaviour). It covers:

- restart during provisioning: the replacement relay takes over, the session
  reaches READY, and a real exec succeeds through the replacement;
- a relay that never returns: the session ends `FAILED` with
  `provisioning_timeout`, `readyAt` is null, and the settled mock ledger is
  `REFUNDED`;
- both cases assert the ledger is not `SETTLED` when `failure_code` is
  `pod_terminated`.

`tests/unit/relay-registration.test.ts` covers the generation precondition,
retry on a generation change, replacement of a stale connected entry, the
registration deadline, and the readiness gate. `tests/unit/relay.test.ts`
covers the relay's `/healthz` generation and the `409 relay_generation_changed`
response.

### Cluster case

`make test-control-faults TARGET=relay SCENARIO=create-restart` (matrix case
`relay-create-restart`) restarts the relay immediately after the paid creates
return and requires every session to reach READY with no terminal session and
no `pod_terminated`. It uses the real Deployment and Service, so it exercises
the rollout and the stale-connection path that the local router only
simulates. **This case was added but not run while implementing #17**; it needs
the self-hosted cluster runner described below.

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
| `relay-create-restart` | relay | restart while paid creates are provisioning | 5 | 120 s |
| `lifecycle-restart` | controller | kill with READY/ACTIVE/SUSPENDED sessions | 50 | 120 s |
| `controller-pause` | controller | `SIGSTOP`/`SIGCONT` during provisioning | 5 | 60 s |
| `api-pause` | api | `SIGSTOP`/`SIGCONT` during provisioning | 5 | 30 s |
| `relay-pause` | relay | `SIGSTOP`/`SIGCONT` with operations in flight | 5 | 60 s |

`full` is all eight; `smoke` is `api-kill`, `controller-pause` and
`relay-pause`. Relay is a StatefulSet, so the harness resolves the workload
kind before waiting for rollout; a hardcoded `deploy/relay` made both relay
cases die before any scenario logic, which is what the 0.1.20 artifact shows.

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
| In-flight operation at controller crash | `fences an operation interrupted by a controller crash`, `keeps the gate closed until the guest finishes, then admits the next operation`, `recovery withdraws a stale frame the guest has not observed` | request becomes `outcome_unknown`; the gate stays closed until the guest reports its slot idle; no new operation is forwarded while fenced; the relay refuses and withdraws a frame below the recovery epoch; the next operation runs under a higher execution epoch |
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

A controller crash during an operation used to leave `active_request_id` set in
SQLite, so the paid session stayed `busy` forever; a later fix cleared the gate
but forgot which request was running, so the next operation could be forwarded
into the guest's busy slot and the old outcome became `result_expired`.
Recovery now fences the old generation instead of forgetting it:

1. Startup marks every pending request `outcome_unknown` and bumps the session's
   execution epoch (`sessions.exec_epoch`) in the same transaction. The
   single-operation gate stays closed.
2. Every relay request frame carries that epoch, and `OperationFence` publishes
   the bumped epoch to the relay before it may release the gate. The relay
   refuses a frame below the session epoch with `stale_epoch` and withdraws one
   it already forwarded by resetting the guest link (unread bytes are
   discarded). The guest keeps its own high-water mark as defence in depth, so
   a request forwarded by the previous controller generation can never start
   after recovery. A reset is a real link loss: the supervisor exits, the Pod is
   terminal (`restartPolicy: Never`), and the session ends `FAILED` with
   `failure:guest_exited` rather than lingering `READY` with no guest.
3. The guest reports its active request id and epoch on hello, when it takes the
   single slot, and when it releases it. `OperationFence` releases the gate only
   when the relay reports the guest idle, or when no guest is connected (the
   supervisor exits when its relay link drops). A connected guest that has never
   reported status keeps the gate closed: failing closed is the contract.
4. `GET /requests/{id}` returns `409 outcome_unknown` for a fenced request; an
   id the controller never saw is still `404 request_not_found`. If the relay
   had already cached the guest's signed result, that real result is returned
   instead of the placeholder.

The state transitions are driven by the guest's own status report, so the chaos
case does not depend on sleeping long enough: it asserts the gate is still
closed, queries the old request for `outcome_unknown`, confirms a new operation
is refused without reaching the guest, then cancels the old command and observes
the gate clear before the next operation runs.

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
