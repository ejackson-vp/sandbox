# Control-plane fault recovery

Status: initial fault slice implemented in
`tests/integration/api-flow.test.ts`; full suite now 161 passed, 3 skipped.
The broader child-process fault harness is next.

## Invariants

1. A successful settlement eventually creates an entitlement or is an explicit
   financial exception; it is never silently dropped.
2. Stale/concurrent observations never reserve more capacity than the store's
   atomic admission allows.
3. A terminal session eventually stops consuming compute; Pod deletion
   uncertainty keeps capacity in `RELEASING` rather than freeing it.

## Implemented cases

| Fault | Test | Observed behavior |
|---|---|---|
| Controller crash after settlement, before entitlement | `recovers when the controller crashes after settlement but before entitlement` | first request returns 503 with no session; retry after intent staleness returns the same paid session; one session created |
| Crash after Kubernetes/Pod create, before `PROVISIONING` | `adopts a Pod created just before the controller crashed` | next reconcile adopts the existing Pod, does not create a duplicate, leaves the relay token intact, reaches READY |
| Persistent Pod-deletion failure | `keeps capacity reserved while a deleted Pod is still observed` | reservation stays `RELEASING`; after deletion is restored, orphan sweep + reaper release capacity |
| Settlement failure | existing `does not create a session when settlement fails` | no session, no reservation attached |
| Controller restart in cluster | existing security workload test | certifies no orphaned session after restart |

The Pod-adoption case required two product fixes:

- `LocalProvisioner.createPod` is now idempotent for a live Pod.
- `Provisioning.provision` lists existing Pods before creating one and adopts a
  matching session Pod instead of rotating the relay token.

## Still required for the full milestone

- A child-process fault controller that can pause/kill API, controller and relay
  at named boundaries, rather than monkey-patching one method.
- Deterministic convergence assertions instead of fixed sleeps.
- 50 sessions across every lifecycle state at controller restart.
- Duplicate/delayed payment, Kubernetes and relay responses.
- Suspend/resume/expire/destroy races.
- Persistent deletion failure with the real Kubernetes provisioner.
- Convergence-time metric: fault → all sessions correct, reservations equal
  Kubernetes, no orphan Pods/PVCs.

## Non-goals

No Postgres, Redis, leader election, multiple controller replicas, autoscaling
or distributed queueing. SQLite is deliberate for studying transactions.
