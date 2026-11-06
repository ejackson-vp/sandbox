# Capacity model

Status: implemented for Milestone 4. Pure model in
`controller/src/capacity/{types,placement,admission}.ts`; snapshot and durable
accounting in `service.ts` and `reservations.ts`.

## Units and inputs

All quantities are integers:

- CPU: millicores (`1000` = one core)
- memory: bytes
- storage: bytes
- time: epoch milliseconds

The model never queries Kubernetes, SQLite or the clock. The service builds a
`CapacitySnapshot` and calls `admitCapacity(snapshot, request)`.

```
CapacitySnapshot
  nodes[]           allocatable, platform overhead, labels, taints, readiness
  reservations[]    active HELD/ALLOCATED/SUSPENDED/RELEASING rows
  now

SandboxResourceRequest
  baseline          guaranteed scheduling request
  peak              burst ceiling (tracked, not separately admitted)
  requiredNodeId    checkpoint/local-path affinity, if any
  tolerations       taint keys the workload tolerates
```

## Baseline vs peak

Admission has an explicit accounting mode, set by
`CAPACITY_ACCOUNTING=baseline|peak`:

| Mode | Request vector | Reservation vector | Semantics |
|---|---|---|---|
| `baseline` (default) | baseline | baseline | Guarantees Kubernetes scheduler requests; limits remain burst ceilings. |
| `peak` | peak | peak | Reserves the full limit; no limit overcommit. Density drops sharply. |

Measured runtime utilization is never used as schedulable capacity. The default
is `baseline` because it matches Kubernetes scheduling and preserves the
measured density; `peak` is the strict mode for workloads where the limit is
the real commitment. The reservation table always stores both vectors, so the
mode can change without a schema migration.

## Configuration

| Env | Default | Meaning |
|---|---:|---|
| `CAPACITY_ENABLED` | `true` | master switch |
| `CAPACITY_ACCOUNTING` | `baseline` | `baseline` or `peak` reservation vector |
| `CAPACITY_HOLD_TTL_MS` | `120000` | provisional payment hold lifetime |
| `CAPACITY_PLATFORM_OVERHEAD_CPU_MILLICORES` | `250` | withheld per node |
| `CAPACITY_PLATFORM_OVERHEAD_MEMORY_MIB` | `256` | withheld per node |
| `CAPACITY_PLATFORM_OVERHEAD_STORAGE_MIB` | `1024` | withheld per node |
| `CAPACITY_NODE_CPU_MILLICORES` | `0` | optional test/demo ceiling |
| `CAPACITY_NODE_MEMORY_MIB` | `0` | optional test/demo ceiling |

## Node accounting

For a node:

```
available = allocatable - platformOverhead - reserved
```

`platformOverhead` is withheld for kubelet/CNI/controller/relay work. It is
configured per deployment, not inferred from live usage.

Reservation contribution:

| State | CPU/memory | Storage |
|---|---|---|
| `HELD` | reserved | reserved |
| `ALLOCATED` | reserved | reserved |
| `RELEASING` | reserved (conservative until Pod gone) | reserved |
| `SUSPENDED` | **released** | **retained** |
| `RELEASED` | ignored | ignored |

Expired `HELD` rows are ignored by the model and reaped by housekeeping.

## Eligibility and placement

A node is eligible when:

- `Ready` and not cordoned,
- labelled `x402.io/sandbox-pool=true`,
- every `NoSchedule`/`NoExecute` taint key is tolerated
  (default: `x402.io/sandbox`).

Placement is **least allocated**:

1. filter eligible nodes,
2. compute post-placement maximum utilization across CPU, memory and storage,
3. choose the lowest score, tie-break by node id.

This spreads sessions and avoids a hot first worker. First-fit would pack more
tightly, and best-fit would reduce fragmentation, but both make one-node
concentration more likely under burst. The tradeoff is documented in
[scheduling-tradeoffs.md](scheduling-tradeoffs.md).

The chosen node is a **planning intent**. Kubernetes remains the scheduler. Cold
pods are pinned to the chosen node with required node affinity; a mismatch or a
scheduling failure is handled by the existing provisioning timeout and
reconciliation.

## Storage and suspended sessions

Storage is included in the reservation and remains charged while suspended.
For local-path PVCs this is also the node-affinity anchor: a resume request sets
`requiredNodeId` to the checkpoint's node. If that node has no free compute, the
resume is rejected and the session stays `SUSPENDED`.

## Warm pool

Warm pods are counted from the actual Kubernetes list, not from a parallel
in-memory counter. Each live warm pod contributes the warm-tier baseline on its
node. Replenishment performs a preflight before creating a pod, so the warm
pool cannot starve paid work; the one-pass window is conservative because the
Pod continues to count once it appears.

## Invariants

Property tests assert:

- totals are never negative,
- reservation order does not change a decision,
- adding a compute reservation never increases available capacity,
- increasing a request cannot turn a rejection into an admission,
- admitted baseline never exceeds allocatable minus overhead,
- suspended reservations release compute but retain storage,
- node affinity is always respected.
