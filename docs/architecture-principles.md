# Architecture principles

This is the working rulebook for keeping the codebase clean as the substrate
grows (Kata, Firecracker, autoscaling). It is deliberately small.

## Functional core, imperative shell

- **Pure decisions** live in `shared/src/domain/` and `shared/src/fp.ts`: no
  clock, no I/O, no Kubernetes, no database.
- **Use cases** orchestrate ports; they are allowed to do I/O and are kept short.
- **Ports are asynchronous.** Every method on a store port returns a `Promise`,
  including the Postgres adapter. A port method is an interleaving point, so a
  decision that must be atomic belongs inside one adapter statement or
  transaction, never in a read-then-write pair in a use case.
- **Adapters** own the messy details (SQL, Kubernetes, WebSocket/relay, HTTP).
- **The scheduler** (`Reconciler.tick`) lists work and dispatches; it should not
  contain policy.

The session lifecycle is the first example: `transition(snapshot, event)` is a
total function returning `Result<{state, effects}, TransitionError>`. The shell
performs the effects; the table is the tested contract.

## Types from PL/Haskell, used sparingly

- **Make illegal states unrepresentable.** `SessionEvent`, `SessionEffect`,
  `SessionState` and `TransitionError` are closed sum types. Exhaustive switches
  fail at compile time; `assertNever` catches the rest.
- **Totality.** `transition` never throws and has a result for every
  state/event pair; property tests assert this.
- **Parse, don't validate.** `parseTargetSpec` turns untrusted HTTP/WS input
  into a `targetSpec` with no host field, so the rest of the code cannot
  accidentally reach a non-loopback destination.
- **Result at boundaries.** Expected failures (`not_suspendable`,
  `resume_unavailable`, bad specs) are values. Exceptions mean a bug.
- **No monad transformers, no fp-ts.** `Result`/`Option` with `map`/`flatMap`/
  `match` are enough. Abstractions must pay rent in readability.

## Deployment invariants

Some control-plane state is per process and cannot be shared by replicas. A
second replica is not a capacity change for any of these; it is a second copy of
the truth.

| State | Component | Why a second replica is unsafe |
|---|---|---|
| The store, one writer | controller | Two reconcilers schedule the same rows. The `WHERE state = …` guards stop one effect applying twice; they do not stop two schedulers disagreeing about which effect to run. |
| Guest registry, in memory | relay | A session is pinned to the pod holding its socket. A second registry means guests registered where the controller is not looking. |
| Rate-limit buckets, in memory | api | Limits are per replica, so N replicas multiply every limit by N. This is a known limitation of the single-replica deployment, not a guarded invariant. |

The first two are enforced three ways, deliberately:

- **Code.** ADR 0009: the controller takes a Kubernetes Lease, only the leader
  reconciles, and a standby refuses writes without the Postgres advisory lock so
  a leaked write throws instead of diverging. The relay refuses to start when its
  pod ordinal is outside `RELAY_REPLICAS`, or when the replica count is above 1
  and it has no ordinal to pin itself to, so a scaled StatefulSet fails closed
  instead of serving from a registry the controller is not addressing.
- **Manifest.** `replicas: 1` for the controller Deployment and the relay
  StatefulSet, with a rollout that cannot run two pods against one resource:
  `strategy: Recreate` (or `RollingUpdate` with `maxSurge: 0`) for the
  controller, `podManagementPolicy: OrderedReady` and no surge for the relay.
- **CI.** `scripts/check-singletons.mjs`, run by `npm run lint:structure` and
  therefore by `make verify`, fails on any of those edits. It is a manifest
  check, not a cluster check, so it catches the pull request rather than the
  rollout.

This does not make the deployment highly available. ADR 0010 is the record: the
store is Postgres with the same invariants, proved by the store contract suite
under `READ COMMITTED`, and the controller holds no database volume. Only one
writer reconciles because the Lease says so, not because a volume would refuse a
second mount. The guard exists so that nobody scales the manifest into a failure
the code cannot see.

## DDIA ideas in practice

| Principle | Implementation |
|---|---|
| Single writer | The controller is the only writer; SQL transitions stay guarded by `WHERE state = …` |
| Idempotency | Every effect has an operation id; pod/PVC/relay operations tolerate repeats |
| Outbox | Payment intents are the durable outbox; replay is tested |
| Derived state | `remainingSeconds`, `finalStateForReason`, expiry decisions are pure functions, not duplicated columns |
| Backpressure | Provisioning queue, bounded stream/window buffers, explicit limits |
| Failure as a state | Timeouts, lease expiry, missing PVC/node are explicit transitions, not exceptions in the happy path |
| Schema evolution | Migrations are isolated so Postgres/DynamoDB later is an adapter swap |
| Observability | Metrics/logs at use-case and scheduler boundaries, not inside SQL/K8s helpers |

## Module map

```text
shared/src/protocol/            wire contract: lifecycle, session, operations,
                                attestation, relay, control (re-exported by protocol.ts)
shared/src/domain/session.ts    pure lifecycle: transitions, guards, expiry, final state
shared/src/fp.ts                Result, Option, assertNever

sdk/src/client.ts               public facade only
sdk/src/runtime.ts              transport, auth, attestation, persistence, operation loop
sdk/src/session.ts              create/attach/suspend/resume/destroy
sdk/src/operations.ts           exec + filesystem operations
sdk/src/data-plane.ts           services, HTTP, SSE/chunked, WebSocket

api/src/server.ts               composition, middleware, pricing/health/images
api/src/use-cases/create-session.ts x402 handshake, verify, settle, entitlement
api/src/routes/create-session.ts HTTP mapping for the create-session use case
api/src/routes/sessions.ts      status, operations, data plane, lifecycle
api/src/schemas.ts              request schemas + plaintext guard
api/src/status.ts               controller view -> public wire status

controller/src/reconciler.ts    scheduler: tick, dispatch, state switch
controller/src/reconciler/      bounded dispatch, lease/health policy, clock reports
controller/src/provisioning.ts  cold/warm provisioning: admission, create, resume
controller/src/provisioning/    endpoints + claims, admission prerequisites, pod create, readiness handshake
controller/src/warm-pool.ts     warm-pool policy and lifecycle
controller/src/lifecycle.ts     suspend/resume, idle/expiry policy, PVC cleanup
controller/src/termination.ts   terminate/finalise/reap
controller/src/snapshotter.ts   checkpoint port; no-op locally, Firecracker/Kata later
controller/src/store/           models + schema, SQL repositories; Store is the SQL adapter facade over async ports
controller/src/k8s-types.ts     provisioner contract and pod specs
controller/src/k8s-null.ts      no-op provisioner for unit tests
controller/src/capacity/        pure admission, placement, snapshot builder, reservation port + SQL adapter

guest/main.go                   entrypoint + session/warm lifecycle
guest/config.go                 env/bootstrap configuration
guest/supervisor.go             frame loop, dispatch, encrypted replies
guest/log.go                    structured guest logs
guest/target.go                 one validated loopback target + client
guest/services.go               service process manager
guest/streams.go                SSE/chunked window
guest/websockets.go             polled WebSocket window
```

## Module size budget

`npm run lint:structure` fails any counted source file over 650 lines. The scan
walks the repo from the root and skips only generated directories (`node_modules`,
`dist`, `bin`, `coverage`, `artifacts`, `.git` and friends), so `tests/`,
`verification/`, `site/`, `examples/` and the repo root are all in scope: moving
a file just outside a root cannot hide it. Counted extensions are `.ts`, `.tsx`,
`.mts`, `.cts` and `.go`, matched case-insensitively. The budget is a backstop,
not a target: most modules are 100–350 lines, and 550 is the number to aim at.
The ceiling stays at 650 until the modules above 550 are split, and it never
goes up. Split by use case or adapter, never by arbitrary line count. Today the
gap is six modules: `cli/src/commands.ts` (605), `tests/unit/effects.test.ts`
(597), `guest/supervisor.go` (594), `controller/src/relay/registry.ts` (587),
`tests/integration/relay-reconnect.test.ts` (581) and `scripts/control-faults.ts`
(574). The two controller modules that used to lead that list, `provisioning.ts`
and `reconciler.ts`, are split; the guard prints the current list, and the
ceiling drops to 550 when it prints nothing.

`scripts/check-structure.mjs` carries an explicit `BASELINE` map of the files
that are over budget today, each pinned to its exact line count. It is empty:
the last two entries, `tests/integration/api-flow.test.ts` (1,228) and
`tests/unit/cli-commands.test.ts` (1,001), were split by use case. The guard
fails in four cases:

- a file over budget that is not in `BASELINE`, because a new file gets a
  smaller module, not an entry;
- a baselined file that grew, because the pinned count may only go down and the
  file has to be split;
- a baselined file that shrank, because the count is lowered in the same change
  and the entry is deleted once the file fits;
- an entry that is at or under budget, or whose file is gone.

Every failure prints the remaining baseline, and the message names the rule that
was broken.

The script cannot see the map's previous value. Growing a file and raising its
number in the same commit reads as a clean baseline, so that direction is
enforced by review of the `BASELINE` diff, not by the check. Treat a diff that
adds an entry or raises a number as a failed review.

Completed slices:

- SDK split behind a stable `SandboxClient` facade.
- Reconciler split into warm-pool, provisioning, lifecycle, termination and a
  scheduler; persistence split into models/schema. The scheduler's dispatch,
  lease/health policy and clock reporting now live in `controller/src/reconciler/`,
  so `reconciler.ts` is tick, phase order and the state switch.
- Controller use cases on the shared effect interpreter: suspend/resume,
  termination, readiness and both create transitions execute the effect list
  their transition returns. The create path (`register_relay`,
  `ensure_workspace_pvc`, `start_pod`) delegates to the provisioning use case
  through a port, so no effect is built by hand outside the table. The
  provisioning use case is two modules: the create half in `provisioning.ts`,
  the readiness handshake in `provisioning/readiness.ts`.
- API split into create/session routers, schemas, status mapping and composition.
- Wire protocol split by concept. `@x402s/shared` has no root entry: consumers
  import a subpath (`./protocol`, `./runtimes`, `./money`, `./crypto`,
  `./payment`, `./runtime`, `./env`, `./ip`) so a wire-type consumer no longer
  loads libsodium or the metrics listeners. `./protocol` is the single home of
  the pure core: the wire types, `domain/session.ts` and `fp.ts`.
  `npm run lint:structure` asserts the layer direction (pure → crypto → payment
  → runtime, and runtime never reaches crypto), that every module is reachable
  from an entry, that no symbol is reachable from two entries, and that no root
  barrel has grown back. `npm run coupling` reports Ca, Ce, instability and
  distance from the main sequence, plus cycles, so the numbers are reproducible.
- Guest split into entrypoint, config, supervisor and log modules.
- Explicit `SUSPENDING`/`RESUMING` states with idempotent crash recovery.
- `Snapshotter` checkpoint port with a no-op local adapter, wired into
  suspend/resume/termination.
- Capacity admission: integer baseline reservations, least-allocated placement,
  transaction-level reservation holds, pre-settlement capacity holds, suspend/resume
  re-acquisition, and a constrained-capacity demo.

Next slices:

1. Split the remaining control API payment-route handlers from session routes.
2. Unify SSE/WebSocket poll windows in the guest (`window.go`).
3. Extend the `shared/src` layer guard to the other workspaces and enable
   `exactOptionalPropertyTypes` (a dependency-cruiser config would replace the
   hand-rolled check in `scripts/check-structure.mjs`).
4. Split the six modules that still sit above 550 lines, then lower
   `MAX_LINES` to 550: `cli/src/commands.ts` (605), `tests/unit/effects.test.ts`
   (597), `guest/supervisor.go` (594), `controller/src/relay/registry.ts` (587),
   `tests/integration/relay-reconnect.test.ts` (581) and
   `scripts/control-faults.ts` (574). The two controller modules that used to
   lead this list, `provisioning.ts` and `reconciler.ts`, are done.

## Testing strategy

- **Property tests** (`tests/property/`) for the pure core: state-machine
  totality, terminal absorption, invariants (`READY ⇒ pod + relay`,
  `SUSPENDED ⇒ PVC + no pod`), monotone expiry, final-state mapping, spec hash
  determinism, admission buckets.
- **Guard consistency** (`tests/unit/session-guards.test.ts`) asserts
  `SOURCE_STATES` matches `transition()` for every state/event pair; the store's
  SQL guards are built from that map, so a table change cannot silently diverge
  from the database.
- **Go table tests** for pure validators (`guest/target_test.go`).
- **E2E** (local process + kind) for effects: lifecycle, services, HTTP/SSE/WS,
  payment flow, faults, portability.
- **Avoid** mocking K8s or the database in unit tests. If behavior needs a boundary, test
  it end-to-end or make the policy pure and property-test that.
- Every refactor slice must keep the existing suite green and run a benchmark
  smoke; no big-bang rewrites.

## Lessons from FES

Borrow the boundaries, not the god files:

- `protocols.py` (VMExecutor) → our `Provisioner`/`Relay` ports.
- `pool_state` / `placement` / `autoscaler` split, with pure `compute_desired`
  and `distribute_targets` → our warm-pool/queue policy should be pure too.
- Reaper/drain/lifecycle separate from the pool.
- Do **not** copy warm-VM reuse with persistent globals, plaintext secrets in
  Redis/vsock, unauthenticated execution endpoints, privileged daemons, or
  default-allow egress.

## Non-goals

- Event sourcing everything. The lifecycle is a small state machine, not an
  event-sourced aggregate.
- Generic `Repository<T>` or DI containers. Constructor injection and
  domain-specific repositories are enough.
- Abstraction for its own sake. A module must be used and tested, or it goes.
