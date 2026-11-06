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
shared/domain/session.ts    pure lifecycle: transitions, guards, expiry, final state
shared/fp.ts                Result, Option, assertNever
controller/session-snapshot.ts  the only persistence -> domain mapping
controller/reconciler.ts    imperative shell (next: split into app use cases)
guest/target.go             one validated loopback target + client
guest/services.go           service process manager
guest/streams.go            SSE/chunked window
guest/websockets.go         polled WebSocket window
```

Planned slices:

1. Split `sdk/client.ts` into transport/session/operations/data-plane with a
   facade.
2. Extract `ProvisionSession`, `SuspendSession`, `ResumeSession`,
   `TerminateSession` use cases; make `Reconciler` a thin scheduler.
3. Split `store.ts` into schema/migrations and domain repositories.
4. Split API routers; keep the wire protocol stable.
5. Unify SSE/WebSocket poll windows in the guest (`window.go`).

## Testing strategy

- **Property tests** (`tests/property/`) for the pure core: state-machine
  totality, terminal absorption, invariants (`READY ⇒ pod + relay`,
  `SUSPENDED ⇒ PVC + no pod`), monotone expiry, final-state mapping, spec hash
  determinism, admission buckets.
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
