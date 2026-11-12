# 0010. Controller HA needs a multi-reader store, not shared storage

Status: accepted (2026-11-11, recommended in #147). The adapter shipped and
Postgres is the only backend as of 2026-11-12: the SQLite adapter is deleted,
the controller has no database volume, and the deployment runs a Postgres 17
StatefulSet.

## Context

ADR 0009 makes a second controller replica safe: one holds a Kubernetes Lease
and reconciles, the standby holds no role and does not take the writer lock.
Measured on kind, takeover took 0.25s when the leader released the lease and
10.10s when the holder went stale and its lease had to expire. A session created
before the leader was deleted still executed after it.

None of that was deployable while the controller kept its SQLite file on a
`ReadWriteOnce` PVC: the pod was pinned to the control-plane node, so a second
replica scheduled anywhere else waited forever on a volume it could not mount.
The election was correct; the storage was the ceiling. HA was demonstrated, not
shipped.

Three ways out were on the table (#147): an RWX volume, a store with more than
one reader, or accepting single-node HA and saying so.

## Decision

**Target a multi-reader store: Postgres behind the `Store` port, with the Lease
kept as the reconcile owner.** That was the shape of #25, sequenced as
asynchronous ports on SQLite, then the adapter, then contract tests against both.

The 0.25s/10.10s numbers are the budget this has to stay inside, and they are a
lease budget, not a storage budget. They also show the lease is not the
expensive part: 10.10s of stale-holder wait already buys a correct takeover. What
the numbers do not show is how long a replacement pod waits for its volume,
which on the clouds this runs on is 30s to 2min for detach and re-attach. On RWO
storage the failover time is that number, not 10.10s, and no amount of lease
tuning changes it. That is why the controller no longer holds the volume.

The shipped deployment is now Postgres (`STORE_BACKEND=postgres`,
`DATABASE_URL` from `postgres-credentials`), with one primary StatefulSet on a
`ReadWriteOnce` volume and the controller at one replica. The lease still
elects the reconcile owner, so the pod count is a capacity decision, not a
correctness one: a second replica starts as a standby and reports not-ready.
What that does not give you is database HA. Losing the node still means waiting
for the primary to be rescheduled and its volume reattached; the takeover
numbers above are a lease budget measured against a controller restart, not a
promise about the database.

Progress as of 2026-11-12: the SQLite adapter and the controller's SQLite
backup path are deleted, and the manifest ships `deploy/kubernetes/05-postgres.yaml`
with a `postgres` Service, NetworkPolicy and generated dev credentials. Two
things are still owed: a recorded failover with the Postgres backend on a real
cluster (the 0.25s/10.10s numbers were measured with SQLite), and an operator
runbook once the database layer is CloudNativePG or pgBackRest instead of a bare
StatefulSet.

Consequences specific to the choice:

- The Lease stays. Two reconcilers over the same rows is unsafe whatever the
  store does; the store cannot tell "which effect to run", only "this effect
  already ran". ADR 0009's argument holds unchanged.
- The store-level backstop changes shape. `PRAGMA query_only` is gone, so the
  Postgres adapter takes a `pg_advisory_lock` on the writer connection and
  refuses writes without it. The lease still takes over in 10.10s; the lock is
  what makes a lease bug loud instead of divergent.
- Single-connection transaction order stops being free. Every conditional
  transition used to lean on one SQLite connection serialising `BEGIN
  IMMEDIATE` and the `WHERE state = ...` guard. Under Postgres those guards are
  `UPDATE ... WHERE state IN (...) RETURNING` under `READ COMMITTED`, and the
  adversarial interleavings are tested against the adapter (#25).
- **The port itself had to become asynchronous.** `node:sqlite` is synchronous,
  so every store method returned its value, and the use cases branched on those
  values inline (`if (!store.setReady(...)) return;`). No Postgres client can be
  called from a synchronous method, so the ports became `Promise`-returning
  first, and that cascaded through the effect interpreter, provisioning,
  lifecycle, termination and the control API.
- Backups left the process. Copying the database file became a dump, and a dump
  is the wrong thing for a service to own: logical and physical backups, PITR,
  encryption and retention belong to the database layer (CloudNativePG or
  pgBackRest). `docs/backup-restore.md` describes that split and the restore
  verification that runs the store contract suite against the restored
  database. The controller no longer writes backups and has no backup volume.

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

Honest, and it is what shipped before #25, but it is not an answer to a
control-plane outage: losing the node loses the only writer, and paid sessions
wait for the pod to be rescheduled onto that same node. With `strategy:
Recreate` that is a full rollout, not a failover. Postgres does not fix the
database's own single-node exposure either; that is the job of the database
layer described in `docs/backup-restore.md`.

## Alternatives not taken

- **libSQL / rqlite.** Same shape as Postgres and a smaller client, but a
  smaller operational surface means fewer people can run it, and Postgres is
  already the one the ledger work assumes.
- **Move election into Postgres** (advisory lock as the only leader mechanism)
  and delete the Kubernetes Lease. One mechanism instead of two, but it throws
  away a measured 0.25s path and makes the controller unable to fail over while
  the database is down. Not worth it for this release.
