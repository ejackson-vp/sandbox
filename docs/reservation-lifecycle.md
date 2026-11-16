# Reservation lifecycle

Status: implemented in `controller/src/capacity/reservations.ts`.

## States

```text
HELD ──attach──► ALLOCATED ──suspend──► SUSPENDED ──resume──► ALLOCATED
  │                   │                       │
  │                   └──terminate────────────┴──► RELEASING ──► RELEASED
  └──expire/fail──► RELEASED      ALLOCATED with no session row ──grace──► RELEASED
```

| State | Compute | Storage | Meaning |
|---|---|---|---|
| `HELD` | reserved | reserved | paid-intent provisional hold |
| `ALLOCATED` | reserved | reserved | owned by a paid session (or waiting for its commit) |
| `SUSPENDED` | released | retained | checkpointed, no Pod |
| `RELEASING` (from `ALLOCATED`) | reserved | reserved | Pod deletion requested; wait for confirmation |
| `RELEASING` (from `SUSPENDED`) | released | retained | no Pod to wait for; wait for release confirmation |
| `RELEASED` | none | none | terminal |

The invariant `ALLOCATED` states: **the row names a session that exists.** The
write that says so happens before the settlement transaction commits, so the
invariant is enforced at the commit, not at the attach:

- `attachToSession` writes `expires_at = now + ALLOCATION_GRACE_MS` (5 minutes)
  alongside `state = 'ALLOCATED'`.
- `completeEntitlement` calls `confirmSession` inside the same transaction that
  inserts the session: it points the row at that session and clears
  `expires_at`.
- `reapExpired` releases an `ALLOCATED` row whose `expires_at` passed **and**
  whose `session_id` has no row in `sessions`.

So a create that settled has no deadline left on its allocation, and an
allocation that never became a session cannot outlive the grace. A duplicate
completion, a lost claim and a crash between attach and commit all take the
second path; before the grace existed, the row was skipped by the reaper
forever because there was no session to terminate.

`RELEASING` is deliberately conservative for a reservation that came from an
active session: Kubernetes `deletePod` returns before the Pod and its cgroup are
gone, so compute and storage are not returned until the next reconcile observes
the Pod absent (or terminal). A reservation released from `SUSPENDED` has no
Pod to wait for: it gave compute back when it checkpointed, so it stays
storage-only while `RELEASING` and never re-charges CPU/memory. The reservation
records its source implicitly through `pod_name`: suspend clears it, and
`beginRelease` refuses to adopt a stale session Pod name for a `SUSPENDED` row,
so `RELEASING` with no `pod_name` is a release that already returned compute
(issue #72).

## Table

`reservations` has:

- unique `payment_key`, `session_id` and `warm_id` where present,
- `node_id`, `pod_name`,
- baseline and peak vectors,
- `expires_at`: the deadline of a `HELD` hold, or the grace of an `ALLOCATED`
  row whose settlement commit has not confirmed it yet,
- `created_at` / `updated_at`.

`SCHEMA_VERSION` is 10. Migrations are additive and transactional: payment
identities, the ledger and refund obligations are never recreated on a version
bump, and a database from a newer build is refused. Session state remains
disposable, but it is no longer dropped implicitly.

## Transactions and idempotency

All admission paths run:

```text
BEGIN IMMEDIATE
  reload active reservations
  admitCapacity(snapshot, request)
  insert/update reservation
COMMIT
```

Consequences:

- concurrent callers cannot both observe the same free capacity and insert,
- a retry with the same payment key returns the existing hold,
- a retry with a different spec hash is rejected,
- `HELD → ALLOCATED` is one row update, not release + re-reserve.

The store has one writer. `ReservationStore` in
`capacity/reservation-store.ts` is the port; `ReservationRepository` is the SQL
adapter over Postgres. A second adapter (DynamoDB, for example) would have to
provide the same admission contract. `CapacityService` accepts a `ReservationStore` override; the snapshot builder
uses the same port. The capacity snapshot still needs to be shared or refreshed
from a single source.

## Crash recovery

| Crash point | Recovery |
|---|---|
| after `HELD` insert, before settlement | hold expires (`CAPACITY_HOLD_TTL_MS`, default 120 s) and is reaped |
| after `attachToSession`, before the settlement commits | allocation grace (`ALLOCATION_GRACE_MS`, 300 s) passes with no session row, and the reaper releases it |
| after settlement, before entitlement | payment intent recovery reuses the hold through `completeIntent` |
| after `ALLOCATED`, before Pod | the reconciler provisions from the durable reservation |
| while `SUSPENDING` | reconcile finishes the checkpoint; reservation moves to `SUSPENDED` |
| while `RESUMING` | reservation is `ALLOCATED`; readiness handshake continues |
| while `RELEASING` | reaper releases when the Pod is gone, or immediately when the row names no Pod |
| controller restart | all state is reloaded from Postgres; no in-memory counters |

`reap()` runs in housekeeping:

1. release stale `HELD` rows, and `ALLOCATED` rows whose `expires_at` passed and
   whose session row does not exist,
2. for `RELEASING`, query the Pod; confirm release when absent/terminal,
3. count reservations stuck in `RELEASING` for more than 60 s as leaks.

## Suspend and resume

Suspend:

1. session `READY/ACTIVE → SUSPENDING`,
2. reservation `ALLOCATED → SUSPENDED` after the Pod is gone,
3. compute is released, storage remains.

Resume:

1. session stays `SUSPENDED` while admission is checked,
2. `resume()` removes the suspended row from the accounting snapshot,
3. checks the node (checkpoint affinity) and free baseline,
4. if admitted, updates the same row to `ALLOCATED`,
5. only then creates the Pod and moves the session to `RESUMING`.

If admission fails, the session remains `SUSPENDED` and the workspace is
retained until its suspended-expiry deadline. It is never reported `READY`
without a reservation and Pod.

## Warm pool

Warm Pods are not stored as reservation rows. They are read from Kubernetes in
the snapshot and counted at the warm-tier baseline on their node. This avoids
a second source of truth for ephemeral pool Pods. During a claim the warm Pod
and the session hold may both be counted for a tick; that is conservative (it
can reject, not over-admit).

## Leak checks

- `RELEASED` rows are terminal and ignored.
- `HELD` has an expiry.
- `ALLOCATED` is released on termination, or, when its session never
  materialised, by the grace. A confirmed allocation has `expires_at = NULL`, so
  the grace cannot free a live session's capacity.
- `RELEASING` is constrained by Pod observation; a release from `SUSPENDED`
  names no Pod and is confirmed on the next housekeeping tick.
- The capacity demo asserts `reservations.total === 0` after destroying both
  sessions.

## Verification

The state machine above, together with the session lifecycle, the payment
intent and the single-operation slot, is checked exhaustively over a bounded
model with TLC: `make verify-model`. The invariant list and the deliberately
broken variants live in
[verification/README.md](../verification/README.md); the overview is
[verification.md](verification.md).
