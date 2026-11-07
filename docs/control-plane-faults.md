# Control-plane fault recovery

Status: control-plane fault slice implemented. In-process fault tests cover
settlement, Pod adoption, deletion failure and lifecycle races; the real
harness kills the API, controller or relay on a kind cluster and measures
time-to-convergence. Relay request/response idempotency has dedicated unit
tests. Full suite: 172 passed, 3 skipped.

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

Each run records time from injection to convergence, terminal states, Pod count
and reservation counts, then destroys all sessions and requires an empty
workload namespace and zero reservations.

### Observed results

| Fault | Sessions | Convergence | Result |
|---|---|---|---|
| Controller killed during provisioning | 50 | 33.4 s–37.8 s across runs (17.8 s before the deterministic pre-kill wait) | 50/50 READY, 50 Pods, 50 allocated reservations, 0 failures |
| API killed during provisioning | 20 | 6.6 s / 6.8 s | 20/20 READY, 20 Pods, 20 allocated reservations, 0 harness failures |
| Relay killed with one in-flight operation per session | 3–5 | 6.7 s–27.2 s (dominated by relay rollout readiness) | all sessions `FAILED`, all operations failed or reported indeterminate, payment preserved, 0 Pods, 0 reservations |

The earlier API-kill run reported 18 `fetch failed` errors while Pods and
reservations were already correct. That was a client bug: `waitForReady`
treated a restarting API as a session failure. It now retries transport errors
and 5xx responses until its deadline.

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

The Pod-adoption case required two earlier product fixes:

- `LocalProvisioner.createPod` is idempotent for a live Pod.
- `Provisioning.provision` lists existing Pods before creating one and adopts a
  matching session Pod instead of rotating the relay token.

## Still required

- A process-level pause/resume fault controller at named boundaries (the
  current harness only kills processes).
- 50 sessions across every lifecycle state at controller restart.
- Duplicate/delayed Kubernetes API responses against the real provisioner.
- Persistent Pod-deletion failure with the real Kubernetes provisioner.
- A convergence-time SLO/regression gate rather than documented measurements.

## Non-goals

No Postgres, Redis, leader election, multiple controller replicas, autoscaling
or distributed queueing. SQLite is deliberate for studying transactions.
