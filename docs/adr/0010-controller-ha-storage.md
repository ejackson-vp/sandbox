# 0010. Controller HA needs a multi-reader store, not shared storage

Status: proposed (recommended in #147, awaiting review)

## Context

ADR 0009 makes a second controller replica safe: one holds a Kubernetes Lease
and reconciles, the standby holds no role and its SQLite connection is
`query_only`. Measured on kind, takeover took 0.25s when the leader released the
lease and 10.10s when the holder went stale and its lease had to expire. A
session created before the leader was deleted still executed after it.

None of that is deployable on a real cluster. The controller's SQLite file is on
a `ReadWriteOnce` PVC and the pod is pinned to the control-plane node, so a
second replica scheduled anywhere else waits forever on a volume it cannot
mount. The election is correct; the storage is the ceiling. HA is demonstrated,
not shipped.

Three ways out were on the table (#147): an RWX volume, a store with more than
one reader, or accepting single-node HA and saying so.

## Decision

**Target a multi-reader store: Postgres behind the `Store` port, with the Lease
kept as the reconcile owner.** That is the shape of #25, sequenced as
asynchronous ports on SQLite, then the adapter, then contract tests against both.

The 0.25s/10.10s numbers are the budget this has to stay inside, and they are a
lease budget, not a storage budget. They also show the lease is not the
expensive part: 10.10s of stale-holder wait already buys a correct takeover, so
adding a second writer is the only remaining step. What the numbers do not show
is how long a replacement pod waits for its volume, which on the clouds this
runs on is 30s to 2min for detach and re-attach. On RWO storage the failover
time is that number, not 10.10s, and no amount of lease tuning changes it.

Until the Postgres adapter lands, **the shipped state is single-node HA,
documented as such** (`docs/architecture-principles.md`, and the manifest guard
in #22 that fails CI if `replicas` or the rollout strategy drifts). Nobody
should read the lease implementation as a durability claim it cannot keep.

Consequences specific to the choice:

- The Lease stays. Two reconcilers over the same rows is unsafe whatever the
  store does; the store cannot tell "which effect to run", only "this effect
  already ran". ADR 0009's argument holds unchanged.
- The store-level backstop changes shape. `PRAGMA query_only` has no Postgres
  equivalent per connection that a standby can rely on, so the Postgres adapter
  takes a `pg_advisory_lock` on the writer connection and refuses writes without
  it. The lease keeps taking over in 10.10s; the lock is what makes a lease bug
  loud instead of divergent.
- Single-connection transaction order stops being free. Every conditional
  transition today leans on one SQLite connection serialising `BEGIN IMMEDIATE`
  and the `WHERE state = ...` guard. Under Postgres those guards must be
  `UPDATE ... WHERE state IN (...) RETURNING` under `READ COMMITTED`, and the
  adversarial interleavings need tests against both adapters (#25).
- **The port itself has to become asynchronous.** `node:sqlite` is synchronous,
  so every store method returns its value, and the use cases branch on those
  values inline (`if (!store.setReady(...)) return;`). No Postgres client can be
  called from a synchronous method, so #25 is not an adapter swap behind
  today's ports: the ports become `Promise`-returning first, and that cascades
  through the effect interpreter, provisioning, lifecycle, termination and the
  control API. Sequencing it as (1) async ports on SQLite, (2) Postgres adapter,
  (3) contract tests against both, keeps every step reviewable and keeps SQLite
  as the `make dev-local` path throughout.
- Backups change from "copy the file" to "dump the database", so the encrypted
  backup path gains a pg_dump branch. That is a smaller job than it sounds
  because `BackupService` already takes a key and a directory.

## Rejected: RWX volume with SQLite still single-writer

Cheapest change on paper, and wrong for a reason that is not latency. SQLite in
WAL mode needs the `-shm` file to be a shared memory mapping and needs POSIX
byte-range locks that work across clients. NFS and its managed cousins (EFS,
Filestore, CephFS) do not provide either reliably; the documented advice is that
WAL on network filesystems corrupts. Falling back to `journal_mode=DELETE` makes
every write wait for a network fsync and serialises readers against the writer,
which puts a network round trip inside the 250ms reconcile cadence and inside
the readiness path. A volume that costs two orders of magnitude more than the
lease it is meant to make redundant, and has a corruption mode, is not an
upgrade.

## Rejected: keep single-node HA and stop there

Honest, and it is what ships until #25 lands, but it is not an answer to a
control-plane outage: losing the node loses the only writer, and paid sessions
wait for the pod to be rescheduled onto that same node. With `strategy:
Recreate` that is a full rollout, not a failover.

## Alternatives not taken

- **libSQL / rqlite.** Same shape as Postgres and a smaller client, but a
  smaller operational surface means fewer people can run it, and Postgres is
  already the one the ledger work assumes.
- **Move election into Postgres** (advisory lock as the only leader mechanism)
  and delete the Kubernetes Lease. One mechanism instead of two, but it throws
  away a measured 0.25s path and makes the controller unable to fail over while
  the database is down. Not worth it for this release.
