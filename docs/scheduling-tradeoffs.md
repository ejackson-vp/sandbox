# Scheduling tradeoffs

## Placement strategy: least allocated

The controller filters eligible nodes and chooses the one with the lowest
post-placement maximum utilization across CPU, memory and storage. Ties break
by node id.

Why:

- spreads sessions across workers instead of filling the first one,
- leaves headroom on every node for resume and warm-pool replenishment,
- deterministic and cheap to reason about.

Costs:

- less bin-packing than first-fit; more nodes may be active at low density,
- local-path checkpoint sessions are pinned anyway, so their placement is not
  free,
- the score is a planning heuristic, not a Kubernetes scheduling guarantee.

Alternatives rejected for this milestone:

| Strategy | Why not now |
|---|---|
| First-fit | Simple and dense, but concentrates burst on one worker and makes a single node hot. |
| Best-fit | Reduces fragmentation, but can leave many nearly-full nodes and complicate resume. |
| Random | Cheap, but non-deterministic decisions are harder to test and debug. |
| Kubernetes `least-allocated` plugin | Kubernetes already schedules; the controller needs its own admission model for holds and payment. |

## Kubernetes is still the scheduler

The controller chooses a node as **capacity intent** and pins cold Pods with
required node affinity. Kubernetes can still reject or delay the Pod. The
system therefore:

- admits only baseline resources,
- keeps the reservation while the Pod is Pending,
- fails the session on provisioning timeout,
- releases the reservation conservatively after Pod deletion.

The model does not claim to be a scheduler replacement. It prevents the
controller from accepting work that its own accounting says cannot fit and
gives the client a deterministic answer before payment.

## Baseline vs peak

Baseline is guaranteed. Peak is tracked but not reserved. This is Kubernetes
semantics and preserves density, but it means a cluster can be oversubscribed
against limits. The alternative — reserve peak — would reduce density sharply
(about 12 sessions on the current worker instead of ~50 idle) and was not
chosen for the first version.

The tradeoff is visible in the capacity summary: `reserved` and `available` use
baseline, while reservation rows retain peak for future policy.

## Suspended sessions and local-path PVCs

Local-path storage is node-bound. A suspend releases compute but retains
storage and the node hint. Resume:

- requires the original node,
- re-acquires baseline CPU/memory,
- may fail with `capacity_unavailable` while another session owns the compute,
- preserves the workspace until the suspended-expiry deadline.

This is correct for local-path but not portable. RWX network storage would
remove the node requirement; it would still need a compute reservation.

## Warm pool

The warm pool is off by default and intentionally not part of the scheduler.
Warm Pods are counted at their actual node, replenishment preflights capacity,
and the pool is frozen as a dev-only stand-in for snapshot restore. It is not
an autoscaler and should not become one in this milestone.

## Multiple workers

The model already represents multiple logical nodes, taints, labels and
storage affinity. A two-worker kind rig is available for scheduling tests.
What is still missing for real multi-node operation:

- controller HA and a shared database,
- node autoscaling,
- a node-level agent for snapshot/KVM runtimes,
- cross-node storage for checkpoint portability.

## HA controller

SQLite `BEGIN IMMEDIATE` is the single-writer guarantee. Multiple controllers
would need:

- a shared transactional store with conditional writes,
- a single capacity snapshot source or a versioned snapshot,
- leader election or idempotent reservation keys to avoid double work,
- shared lease ownership for Pods.

Until then, running two controllers against one SQLite file is not supported.

## Kata/Firecracker

The reservation model is runtime-agnostic. A microVM changes:

- actual node capacity (vCPU/memory overhead),
- snapshot/restore latency and checkpoint semantics,
- the `Snapshotter` implementation,
- the Pod/VM lifecycle adapter.

It does not change the admission invariant: a session must hold baseline
capacity before it is reported READY.
