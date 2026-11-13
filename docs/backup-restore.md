# Backup and restore

Status: **the controller does not back anything up.** The database layer owns
backup, PITR, encryption, retention and the restore drill.

The controller keeps the payment ledger, intents and session state in Postgres
(`deploy/kubernetes/05-postgres.yaml`, [ADR 0010](adr/0010-controller-ha-storage.md)).
It used to copy its SQLite file to a `controller-backups` PVC and encrypt the
copy itself. That path is deleted, along with the volume, the
`BACKUP_ENCRYPTION_KEY` secret and the `BACKUP_*` settings. A service that backs
up its own database has to get the schedule, the off-site copy, the retention and
the restore drill right, and it usually does none of them well.

## What is backed up

The whole database, including:

- `payments` and `payment_ledger` (the money records);
- `payment_intents` (the replay/outbox state);
- `sessions`, operations, reservations and `challenge_nonces`.

**Checkpoint workspaces are not in the database.** A suspendable session's
`/workspace` is a separate per-session PVC, never mounted by the controller, and
it is plaintext. Restoring the database restores the session *record*; if the
workspace PVC is gone, the session resumes as `checkpoint_missing`. Checkpoint
durability is a separate problem: see
[ADR 0007](adr/0007-checkpoint-at-rest-plaintext.md) and
[lifecycle.md](lifecycle.md#checkpoint-at-rest-expiry-and-backup).

## Pick a layer

Two shapes fit this deployment. Neither is in this repository; both replace the
bare StatefulSet in `05-postgres.yaml` when the deployment outgrows it.

| Option | What it gives you | What it costs |
| --- | --- | --- |
| **CloudNativePG** | A `Cluster` CRD with streaming replicas, continuous WAL archiving to object storage, PITR, and `barman-cloud` for base backups. Restores are `bootstrap.recovery` from a backup or a PITR target. | An operator on the cluster, an object store, and a CRD that owns the Postgres pods instead of the plain StatefulSet here. |
| **pgBackRest** | Repo-based full/differential/incremental backups, parallel WAL archiving, PITR, and its own retention and encryption. Works with the existing StatefulSet. | A sidecar or CronJob plus a repo (S3, NFS or a PVC), and a config file that has to be right before the first backup. |

Either way, the properties the controller's old path had to provide are now
configuration in that layer:

- **Encryption.** CloudNativePG's object-store backend or pgBackRest's
  `repo-cipher-pass` encrypts at rest. Losing that key makes every backup
  unreadable, so keep it with the other recovery material, not in the same
  bucket.
- **Retention.** Set a retention policy in the layer (for example
  `retentionPolicy: "14d"` or pgBackRest's `repo1-retention-full`). The database
  layer prunes; nothing here does.
- **Off-cluster copy.** The backup repo must not be the same volume or the same
  node as the primary. A backup that lives beside the database protects against
  a bad migration, not against losing the node.
- **RPO / RTO.** WAL archiving gives a PITR window of minutes; a nightly base
  backup alone gives an RPO of a day. Decide the window, then verify the restore
  meets the RTO you wrote down.

The homelab overlay takes a smaller step: a nightly `pg_dump` CronJob in
`homelab/apps/sandbox/postgres-backup.yaml`, encrypted with the cluster's
existing backup key, restored into a scratch database to prove it reads, and
kept for seven days. That catches a bad migration or a deleted row. It is not
disaster recovery, because the dump sits on a PVC on the same node as the
primary; copy the files off-node or move to one of the two options above.

## Restore verification

A restore you have never run is a guess. The check is the store contract suite,
run against the restored database, because it proves the payment, session,
transition and reservation invariants survived the copy, not just that `pg_dump`
exited zero.

1. Restore into a **scratch** database, never over the primary:

   ```bash
   # CloudNativePG: a recovery cluster
   kubectl apply -f restore-cluster.yaml     # bootstrap.recovery, no application traffic

   # pgBackRest: restore to a new data directory, then start a throwaway server
   pgbackrest --stanza=sandbox --pg1-path=/restore/data --delta restore
   ```

2. Point the suite at it. It truncates every table, so the target must be the
   restored copy and nothing else:

   ```bash
   DATABASE_URL='postgres://sandbox:<pw>@127.0.0.1:5433/sandbox?sslmode=disable' \
     npm run test:store-contract
   ```

   A local server from the restored directory works too: start `postgres` on a
   spare port with `-D /restore/data`, run the suite, then stop it.

3. Run a create/exec/destroy smoke test against a controller pointed at the
   restored database, and confirm a known `payments.payment_key` has its
   `payment_ledger` row.

4. Record the RTO, the backup age and any step that was not in this page. Repeat
   quarterly, and after any change to the backup layer.

The suite is the one `npm run test:store-contract` runs. It skips unless
`DATABASE_URL` is set, which is what makes it safe to point at a scratch
database and dangerous to point at a primary.

## Verified by

`tests/integration/restore-drill.test.ts` (`npm run test:restore-drill`) is the
executable version of the check above. It seeds a source database with a settled
payment, a refunded duplicate charge, an unclaimed refund row and a READY session
interrupted mid-operation, copies it with `CREATE DATABASE … TEMPLATE …` (a
server-side copy, so no `pg_dump` binary to install or version to match), and
asserts against the copy: all four ledger rows match column for column, the
settled key is still rejected by `payments_pkey` (SQLSTATE 23505) so a replay
cannot charge twice, the interrupted operation finishes, replaying its request id
is refused as a duplicate, and a new settlement succeeds on the copy. It needs
`DATABASE_URL`, and it runs in the `postgres contract` CI job, so a change that
breaks the copy fails a pull request instead of a quarterly drill.

It does not cover point-in-time recovery, a cross-region restore, or the
Kubernetes objects around the database (pods, PVCs, the Lease): it proves the
database copy is usable, not that a backup exists or that the cluster recovers.

## What is not covered

- **Checkpoint workspaces.** A suspendable workspace is a plaintext per-session
  PVC with its own expiry. An object-store checkpoint with a client-held key is
  follow-up 1 in [ADR 0007](adr/0007-checkpoint-at-rest-plaintext.md).
- **Relay state.** In-memory per pod, by design
  ([architecture-principles.md](architecture-principles.md)).
