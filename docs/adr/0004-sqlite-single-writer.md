# 0004. SQLite as the single writer, with an outbox

Status: superseded by [0010](0010-controller-ha-storage.md) (2026-11-12).

> The outbox and the conditional `WHERE state = ...` guards survive this record;
> the storage choice does not. The controller now opens Postgres and SQLite has
> been removed, so read every "SQLite" below as the state of the system up to
> 2026-11-12. [0010](0010-controller-ha-storage.md) is the standing decision.

## Context

Payment settlement and session creation must not diverge: a client that pays
must get a session, and a client that does not pay must not. The service also
needs crash recovery, idempotent retries, and a lease deadline that survives a
controller restart. The deployment target is a small cluster, not a managed
database.

## Decision

One controller instance owns all state in SQLite (WAL mode). Payment intents are
the durable outbox: settling a payment writes an intent, materialising the
session consumes it, and replay is a no-op. Every state transition is guarded by
`WHERE state = ...`, so a concurrent or replayed effect cannot apply twice.

Kubernetes is treated as an effect target, not as the source of truth. On
restart the reconciler lists live pods and relay state and repairs the database.

## Consequences

- Atomic payment-to-entitlement without a distributed transaction.
- A single controller replica is a hard ceiling. That is acceptable now and is a
  deliberate limit, not an oversight. (0009 adds a standby that can take over;
  the writer is still one process.)
- SQLite on a volume is a durability dependency. Losing the volume loses session
  state; pods are then reaped as orphans.
- Schema changes are isolated behind migrations so a Postgres adapter can replace
  the store without touching use cases.

## Alternatives considered

- **Postgres.** Correct choice at higher write volume, but adds an operational
  dependency before there is a second writer to justify it.
- **Kubernetes objects as the source of truth.** Tempting because pods already
  exist, but payments are not pods, and etcd gives no transactional outbox.
- **Event sourcing.** A good fit conceptually, and partially present in the state
  machine, but the extra machinery does not pay for itself at this size.
