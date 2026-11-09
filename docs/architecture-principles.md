# Architecture principles

This is the working rulebook for keeping the codebase clean as the substrate
grows (Kata, Firecracker, autoscaling). It is deliberately small.

## Functional core, imperative shell

- **Pure decisions** live in `shared/src/domain/` and `shared/src/fp.ts`: no
  clock, no I/O, no Kubernetes, no SQLite.
- **Use cases** orchestrate ports; they are allowed to do I/O and are kept short.
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

```
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
api/src/routes/create-session.ts x402 handshake, verify, settle, entitlement
api/src/routes/sessions.ts      status, operations, data plane, lifecycle
api/src/schemas.ts              request schemas + plaintext guard
api/src/status.ts               controller view -> public wire status

controller/src/reconciler.ts    scheduler: tick, health, lease, dispatch
controller/src/provisioning.ts  cold/warm provisioning + readiness handshake
controller/src/warm-pool.ts     warm-pool policy and lifecycle
controller/src/lifecycle.ts     suspend/resume, idle/expiry policy, PVC cleanup
controller/src/termination.ts   terminate/finalise/reap
controller/src/snapshotter.ts   checkpoint port; no-op locally, Firecracker/Kata later
controller/src/store/           models + schema; Store is the SQL adapter facade
controller/src/k8s-types.ts     provisioner contract and pod specs
controller/src/k8s-null.ts      no-op provisioner for unit tests
controller/src/capacity/        pure admission, placement, snapshot builder, reservation port + SQLite adapter

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

`npm run lint:structure` fails any `.ts`/`.go` module over 550 lines. The
budget is a backstop, not a target: most modules are 100–350 lines. If a module
grows past the budget, split it by use case or adapter, not by arbitrary line
count.

Completed slices:

- SDK split behind a stable `SandboxClient` facade.
- Reconciler split into warm-pool, provisioning, lifecycle, termination and a
  scheduler; persistence split into models/schema.
- API split into create/session routers, schemas, status mapping and composition.
- Wire protocol split by concept while keeping `@x402s/shared` exports stable.
- Guest split into entrypoint, config, supervisor and log modules.
- Explicit `SUSPENDING`/`RESUMING` states with idempotent crash recovery.
- `Snapshotter` checkpoint port with a no-op local adapter, wired into
  suspend/resume/termination.
- Capacity admission: integer baseline reservations, least-allocated placement,
  SQLite `BEGIN IMMEDIATE` holds, pre-settlement capacity holds, suspend/resume
  re-acquisition, and a constrained-capacity demo.

Next slices:

1. Move controller use cases onto a shared effect interpreter so suspend/resume
   and provisioning cannot drift from the pure transition table. The store's SQL
   guards already derive from `SOURCE_STATES`, and a test asserts the map matches
   the table; what remains is the effect execution path.
2. Split the remaining control API payment-route handlers from session routes.
3. Unify SSE/WebSocket poll windows in the guest (`window.go`).
4. Add dependency-cruiser layer rules and enable `exactOptionalPropertyTypes`.

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
- **Avoid** mocking K8s/SQLite in unit tests. If behavior needs a boundary, test
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
