# 0009. Leader election for the single writer

Status: accepted

## Context

ADR 0004 makes SQLite the single writer and accepts one controller replica as a
hard ceiling. Restarting that replica, or losing its node, leaves paid sessions
with no process enforcing their lease until the pod is rescheduled: a pod that
should have been destroyed keeps running, and a create waits for the rollout.

The obvious fix, more replicas, is unsafe as written. `reconciler.start()` runs
unconditionally, so a second replica is a second scheduler over the same rows.
Two processes assigning pods and terminating sessions from one file will
duplicate effects and race transitions, and the state machine's `WHERE state =
...` guards only stop a *single* effect applying twice, not two schedulers
disagreeing about which effect to run.

## Decision

One writer still. A replica holds the role through a Kubernetes
`coordination.k8s.io/v1` Lease (`controller-leader` in `sandbox-system`), renews
it every 2s, and treats a 10s unrenewed lease as free.

- Only the leader reconciles. It runs startup recovery, the reconcile loop and
  housekeeping; a standby runs none of them.
- The leader reports ready on `/internal/readyz`; a standby reports 503 with
  `leadership: not_leader`. The API Service therefore routes to the writer.
- The store connection is the backstop. A standby sets SQLite `query_only`, so a
  write that slipped past the scheduler throws (`attempt to write a readonly
  database`) instead of diverging. One pragma covers every repository on that
  connection.
- On leaving the role, the loop stops scheduling *before* the store refuses
  writes, so a pass still in flight fails loudly rather than writing after
  another replica may already own the lease.
- Graceful shutdown releases the lease (empty holder) so a rollout hands over in
  one renewal rather than one duration.

Takeover is compare-and-swap on `metadata.resourceVersion`, and expiry is
measured on the observer's own clock from the first sighting of an unchanged
record. Clock skew between nodes therefore delays a takeover; it can never
overlap two writers.

`replicas: 1` stays in the manifest. The point is that the code no longer blocks
a second replica; how many to run is a capacity decision.

## Consequences

- Failover, not throughput. The writer is still one process, and one Lease
  renewal every 2s is the only added API traffic.
- The SQLite volume is ReadWriteOnce. Two replicas co-mount it only on a single
  node, which is what a kind cluster is and what this deployment already assumes
  (the controller is pinned to the control-plane node). Real HA needs an RWX
  volume or a store that supports multiple readers, which is the Postgres
  migration ADR 0004 already anticipates.
- A takeover costs up to one lease duration of no reconciliation, plus the
  5s readiness probe cadence before the API routes to the new leader. Leases with
  an immutable deadline are still enforced late rather than never: the new leader
  expires them on its first pass.
- A standby keeps its database connection open and read-only. It serves reads and
  probes, so a takeover needs no reconnection.

## Alternatives considered

- **No election, external failover.** A single replica plus an operator that
  watches the Deployment and deletes stuck pods. Less code, but the decision
  about who writes then lives outside the process, with a worse view of it.
- **Watch-based election** (client-go style `Lease` watcher). Lower latency to
  notice a death, at the cost of a watch stream and its reconnect handling. A 2s
  poll of one object is cheap enough that the extra machinery does not pay.
- **Two writers with Postgres.** The correct end state for write throughput, and
  a much larger change: every conditional transition currently relies on one
  connection's transaction order. Election is the cheap step that makes a standby
  safe today.
