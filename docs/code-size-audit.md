# Code-size audit

Status: measured after the post-Milestone-4 cleanup. The point of this note is
to distinguish **behavior** from **bloat**.

## Measurement

Raw production source (excluding tests, benchmarks, scripts, `dist`, `bin`):

| Area | Code | Comment | Blank |
|---|---:|---:|---:|
| `shared/src` | 1,901 | 317 | 231 |
| `sdk/src` | 1,340 | 66 | 106 |
| `api/src` | 1,526 | 131 | 133 |
| `controller/src` | 5,729 | 424 | 437 |
| `cli/src` | 638 | 15 | 50 |
| `guest` | 2,910 | 159 | 242 |
| **Total** | **14,044** | **1,112** | **1,199** |

The “16k” figure is raw lines including comments and blank lines. Production
code is ~14k lines. Tests are separate (~4k lines), benchmarks separate (~3k).

## Duplication

`jscpd` over TypeScript and Go:

- TypeScript: **0.24% duplicated lines** (2 clones, both in `k8s.ts` pod setup).
- Go: **0% duplicated lines**.

This is not a copy-paste-bloated codebase. The earlier `k8s.ts` clones were the
only meaningful exact duplication.

## Where the lines actually are

- **Guest, 2.9k:** execution, filesystem/archive safety, HTTP/SSE/WS windows,
  service supervision, relay protocol. Security-sensitive, not boilerplate.
- **Controller, 5.7k:** Kubernetes adapter, relay, SQLite store, lifecycle,
  warm pool, capacity model/reservations, egress proxy, control API. This is
  the system's actual complexity.
- **Shared, 1.9k:** lifecycle/operations/attestation/relay/control wire types
  and payment schemes. Types are a contract, not duplication.
- **API, 1.5k:** x402 handshake, settlement, capabilities, routes/status.
- **SDK, 1.3k:** transport, attestation, lifecycle, operations, data plane.
- **CLI, 0.6k:** thin command surface.

## What was tightened

- Pod setup deduplicated into `controller/src/k8s-pod.ts`.
- Node capacity mapping moved to `controller/src/k8s-nodes.ts`.
- Controller session view moved to `controller/src/session-view.ts`.
- `CompleteIntentBody` now extends the shared `EntitlementRequest` instead of
  duplicating 20 fields.
- Dead exports removed (`CapacitySummary`, `EMPTY_RESERVATION_VECTOR`,
  `EntitlementResponse`, unused schema/relay/schema-version exports).
- Module budget reduced from **600 to 550 lines**; largest module is now 526.
- `k8s.ts` reduced from 587 to 340 lines; control API from 580 to 526.

## What a materially smaller codebase would require

Line count will not drop much by moving code between files. To reduce it
substantially, remove behavior:

| Option | Approx. saving | Cost |
|---|---:|---|
| Delete the warm pool | 500–800 lines | lose the 100 ms warm-start path |
| Remove mock/testnet payment schemes | 300–400 lines | lose local payment demos/tests |
| Remove local process provisioner | ~230 lines | lose local integration mode |
| Remove CLI data-plane commands | ~200 lines | weaken CLI |
| Collapse capacity ports/abstractions | ~150 lines | worse SOLID boundary; harder multi-controller adapter |
| Remove capacity/multi-node code | ~1,000 lines | lose Milestone 4 |

Those are product decisions, not refactors.

## Verdict

The codebase is not 16k lines of copy-paste. It is ~14k lines of distinct
behavior with a 0.24% duplication rate. The real cleanup target is **file
focus**, not deleting behavior: the largest modules are now below 550 lines,
and the remaining large modules are cohesive adapters (`relay`, `store`).

If the goal is a lower raw line count, the next step should be an explicit
feature-removal decision, starting with the frozen warm pool.
