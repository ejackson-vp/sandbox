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

A restore you have never run is a guess. The check is the store contract suite
run against a database restored from the artifact, because it proves the
payment, session, transition and reservation invariants survived the restore,
not just that `pg_dump` exited zero.

### The homelab dump

`make test-restore-dump DUMP=<file>` (`node scripts/restore-dump.mjs <file>`)
runs the whole loop:

- creates `sbx_restore_<stamp>_<pid>_<random>`, a name no deployed database has;
- decrypts with `openssl enc -d -aes-256-cbc -pbkdf2` when the file starts with
  `Salted__` and `BACKUP_ENCRYPTION_KEY` is set, and streams it into
  `pg_restore --no-owner --no-privileges --exit-on-error`;
- prints the schema version;
- fingerprints every money and session table in the copy and in the database the
  dump came from, and compares them (below);
- runs the store contract (`tests/restore/`) against that copy;
- drops the database on success, on failure and on `SIGINT`/`SIGTERM`, unless
  `--keep` is passed;
- exits non-zero on any failure.

The comparison has to run before the contract, because the contract truncates
every table. By the time it passes there are no rows left to check.

```sh
[restore-dump] data: source 127.0.0.1:5453/sandbox (read-only, full scan)
[restore-dump] data payments           rows=12      fp=707fdcd25c47390d94f707cdd6bfd45b match (1 ms copy, 0 ms source)
[restore-dump] data exec_requests      rows=36      fp=5ae31a59113368ff52dcdf94e00e34d0 match (1 ms copy, 0 ms source)
[restore-dump] data total              rows=102     fp=a5e551dcb4da4de53e69dc5bdbb12786 match (8 tables, full scan of both databases, 36 ms)
[restore-dump] PASS: sbx_restore_… survived the dump, the restore, the row comparison and the store contract (schema v18, 12 sessions, total fp a5e551dcb4da4de53e69dc5bdbb12786)
```

Per table it prints `count(*)` and an md5 of the rows, in primary-key order,
hashed as `md5(ROW(<columns sorted by name>)::text)`. Missing, duplicated and
altered rows all change at least one of the two numbers. `exec_requests` is
ordered by `(session_id, id)` and text keys sort with `COLLATE "C"`, so a copy on
a cluster with a different locale still hashes the same way. Both connections
run `default_transaction_read_only = on`; the check only reads.

The cost is one sequential scan of each table on each database, plus a sort by
primary key when the planner does not use the key's index, and about 32 bytes of
aggregate state per row per side while the hash is built. Nothing is sampled.
The run prints rows and milliseconds per table, and a note for a table over a
million rows, so measure it once against the real database before a drill.

A mismatch exits 1 and names the table with both numbers:

```sh
[restore-dump] FAIL: the restored copy does not match the source (1 of 8 tables differ)
[restore-dump]   payment_ledger: source rows=11 fp=02be7602dc5692b21234b0533949c7a0, copy rows=12 fp=1bb4df5fc2772b3d4b7b1e6894b3ac91
[restore-dump]   total: source rows=101 fp=3c28ad991e62ff9a88ce7363aebefd25, copy rows=102 fp=a5e551dcb4da4de53e69dc5bdbb12786
```

The source defaults to the database named in `DATABASE_URL`, read only.
`--compare-url` points the comparison at another database (the source of the
dump, if the admin connection is somewhere else). If that database has no
`payments`, `payment_ledger` or `sessions`, the run says so and fingerprints the
copy only: a laptop with an artifact and no source can still prove the schema,
not the rows. `--no-compare` does the same deliberately.

A dump older than the source will differ, and the check reports it. That is
drift, not corruption: the numbers name the tables that moved. Restoring a
week-old artifact against a live database is the one case to expect a mismatch.

`DATABASE_URL` is the admin connection. The script creates and drops its own
database and never writes to the one named in that URL. It needs `pg_restore`
and `openssl` on `PATH`, from a client at least as new as the server that wrote
the dump (`postgresql-client`, or `brew install libpq`).

Get a dump onto the machine first. It lives on the `postgres-backups` PVC, so
copying it out needs a pod with that volume mounted; `homelab/apps/sandbox/README.md`
has that command. Then:

```sh
export BACKUP_ENCRYPTION_KEY="$(kubectl -n sandbox-system get secret x402-secrets \
  -o jsonpath='{.data.backup-encryption-key}' | base64 -d)"
export DATABASE_URL='postgres://postgres:<pw>@127.0.0.1:5451/sandbox'

make test-restore-dump DUMP=postgres-<stamp>.dump.enc
```

A pass ends with `survived the dump, the restore, the row comparison and the
store contract` and a green contract suite. The `total fp` on that line is the
fingerprint of the copy, so two runs of the same artifact print the same number.
A truncated file, a wrong key, a corrupt archive or a dump this build cannot use
all exit 1 with the failing step named, and so does a row that did not come back.
`--keep` leaves the copy in place for the smoke test below and prints the
`DROP DATABASE` command.

Note what `npm run test:store-contract` does **not** do: with `DATABASE_URL`
pointed at a restored database it creates a fresh `sbx_test_…` database from
that URL and runs there, so the contract never runs against the restored copy.
That is why the script uses `npm run test:store-contract-restored`, which runs
the same suite against `SBX_RESTORE_DATABASE_URL` exactly as given.

### A CloudNativePG or pgBackRest recovery instance

Those restores produce a running database rather than a file, so point the same
suite at a database in the recovery instance. It truncates every table, so use
a throwaway instance or a database named for the drill:

```sh
SBX_RESTORE_DATABASE_URL='postgres://sandbox:<pw>@127.0.0.1:5433/sbx_restore_drill' \
  npm run test:store-contract-restored
```

`tests/restore/store-contract.test.ts` refuses a database whose name does not
start with `sbx_restore_`. Set `SBX_RESTORE_ALLOW_ANY_DB=1` only on a recovery
instance you are willing to empty.

### Schema versions

`sandbox_schema.version` is the dump's schema version. The script reads it,
prints it, and acts on it the way the controller does at start-up
(`migratePostgres` in `controller/src/store/postgres/schema.ts`):

- **Older than this checkout.** The contract fixture opens a writer on the copy,
  so the additive ladder runs before the first test and migrates the copy to
  `SCHEMA_VERSION`. That is the production start-up path, so it proves the
  ladder runs against the artifact and existing rows survive it. It does not
  prove the old schema behaves, because nothing asserts against the pre-migration
  state.
- **The same version.** No ladder, the suite runs as written.
- **Newer than this build.** `migratePostgres` throws
  `refusing to downgrade`, the controller would not start on it either, and the
  script stops before running the contract and says so. Restore with the build
  that wrote the dump.
- **No version row.** Treated as v0 and the base schema is applied. The script
  separately refuses a dump without `sessions`, `payments` and
  `payment_ledger`, so an unrelated database is not mistaken for a backup.

### After the restore

Run a create/exec/destroy smoke test against a controller pointed at the kept
copy, and confirm a known `payments.payment_key` has its `payment_ledger` row.
Record the RTO, the backup age and any step that was not on this page. Repeat
quarterly, and after any change to the backup layer.

## Verified by

`tests/integration/restore-drill.test.ts` (`npm run test:restore-drill`) is a CI
approximation of the check above, not a replacement for it. It seeds a source
database with a settled payment, a refunded duplicate charge, an unclaimed refund
row and a READY session interrupted mid-operation, copies it with
`CREATE DATABASE … TEMPLATE …`, and asserts against the copy that the invariants
survive: all four ledger rows match column for column, the settled key is still
rejected by `payments_pkey` (SQLSTATE 23505) so a replay cannot charge twice, the
interrupted operation finishes, replaying its request id is refused as a
duplicate, and a new settlement succeeds on the copy. It needs `DATABASE_URL`,
runs in the `postgres contract` CI job, and is excluded from
`npm run test:integration` so it runs once per pull request.

The copy is a server-side `TEMPLATE` of a cleanly closed source, which is not a
production restore path: CloudNativePG `bootstrap.recovery`, pgBackRest and the
homelab `pg_dump` CronJob all replay WAL or restore a dump. The drill also says
nothing about point-in-time recovery, a cross-region restore, or the Kubernetes
objects around the database (pods, PVCs, the Lease).

`scripts/restore-dump.mjs` closes the artifact half: it takes a real
`pg_dump -Fc` file, decrypts it the way the CronJob encrypted it, restores it,
compares every money and session table against the database the dump came from,
and runs the contract against the restored copy. A table that lost rows, gained a
duplicate or changed a value fails the run with the table and both fingerprints
named, before the contract has a chance to truncate anything.
`tests/unit/restore-dump.test.ts` and `tests/unit/restore-verify.test.ts` pin its
decisions without a server (argument parsing, the scratch name, the encryption
sniff, the schema-version branch, and what the fingerprint hashes and orders by).
It is not in CI: no runner holds the `postgres-backups` PVC or the backup key,
and the nightly faults job runs against a cluster that backs nothing up. The
quarterly drill is still a human with the key, and this is the command they run.

What is still unproven:

- **The rows, when there is no source to compare with.** The comparison needs
  the database the dump came from. `--no-compare`, or a `DATABASE_URL` database
  with no sandbox tables, drops the run back to schema and counts, and says so
  in the output. Comparing a week-old artifact against a live source also shows
  legitimate drift, which reads as a mismatch: check the dump's age before
  believing it.
- **Columns that only one side has.** A dump taken before a ladder step is
  compared on the columns both sides share, and the skipped columns are named.
  An altered value in a column the dump predates is not seen.
- **Anything off-node.** The homelab dump lands on the same local-path PVC as
  the primary. It catches a bad migration or a deleted row; it is not disaster
  recovery, and no drill here changes that.
- **WAL replay and PITR.** No test in this repository replays WAL,
  bootstraps a CloudNativePG recovery cluster or restores a pgBackRest repo.
- **The Kubernetes objects around the database.** Restoring rows does not
  restore the StatefulSet, the PVCs or the Lease.

## What is not covered

- **Checkpoint workspaces.** A suspendable workspace is a plaintext per-session
  PVC with its own expiry. An object-store checkpoint with a client-held key is
  follow-up 1 in [ADR 0007](adr/0007-checkpoint-at-rest-plaintext.md).
- **Relay state.** In-memory per pod, by design
  ([architecture-principles.md](architecture-principles.md)).
