# Backup and restore

Status: **the recovery window is designed and drilled, not yet provisioned.**

The manifests, the configuration and the drill are in this repository, and the
decision is [ADR 0015](adr/0015-postgres-pitr.md). What is missing is the object
store and the Secret that names it: one thing an operator has to create, because
no repository can. Until that exists the only backup of the ledger is the nightly
`pg_dump` CronJob described further down, with an RPO of up to a day.

The controller keeps the payment ledger, intents and session state in Postgres
(`deploy/kubernetes/05-postgres.yaml`, [ADR 0010](adr/0010-controller-ha-storage.md)).
It used to copy its SQLite file to a `controller-backups` PVC and encrypt the
copy itself. That path is deleted, along with the volume, the
`BACKUP_ENCRYPTION_KEY` secret and the `BACKUP_*` settings. A service that backs
up its own database has to get the schedule, the off-site copy, the retention and
the restore drill right, and it usually does none of them well.

## What is in the database

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

### The ledger must survive, the sessions do not

The two halves of this database have different values, and the design follows
that rather than treating every table the same.

| Data | Cost of losing it | What covers it |
| --- | --- | --- |
| `payments`, `payment_ledger`, `payment_intents` | money moved on chain with no record of what it bought: no session to serve, no refund to issue, and no way to tell from the database what happened | PITR, 60s RPO, 14 day window |
| `sessions`, `exec_requests`, `reservations` | a paid session dies mid-flight; the client is refunded or retries and the work is redone | the same PITR window, but nobody needs it to be 60s |
| checkpoint workspaces (per-session PVCs) | the sandbox's `/workspace` is gone and the session resumes as `checkpoint_missing` | nothing here, see [ADR 0007](adr/0007-checkpoint-at-rest-plaintext.md) |

A restore therefore restores the ledger exactly, and restores sessions as far as
their *records* go. Do not promise a customer their `/workspace` back from a
database restore.

## The recovery window (designed)

One mechanism: **pgBackRest 2.60** in a derived image
(`Dockerfile.postgres-pitr`), archiving WAL continuously to an S3-compatible
repository and taking a daily base backup from a sidecar in the existing pod.

| Piece | Where | What it does |
| --- | --- | --- |
| `archiving` | `deploy/kubernetes/pitr/postgres-statefulset.patch.yaml` | `archive_mode=on`, `archive_command = pgbackrest --stanza=sandbox archive-push %p`, `archive_timeout=60` |
| `config` | `deploy/kubernetes/pitr/configmap.yaml` | pgBackRest options: S3 repository, `aes-256-cbc`, 14 day retention, async archiving with a 1GiB queue, and the sidecar's backup loop |
| `sidecar` | same patch | shares the pod's socket, mounts PGDATA **read-only**, creates the stanza, then `backup --type=full`, `verify`, sleep a day |
| `credentials` | `postgres-pitr` Secret, `02-secrets-pitr.yaml.example` | bucket, endpoint, region, keys and cipher pass as `PGBACKREST_*` env vars. Nothing in the repository is a credential |
| `egress` | `deploy/kubernetes/pitr/networkpolicy.yaml` | the store's only egress: 443 and DNS |
| `restore job` | `deploy/kubernetes/pitr/restore-job.yaml.example` | the one-shot Job that puts a backup back on the volume |
| `drill` | `scripts/pitr-drill.sh` | base backup, WAL replay to a timestamp, contract, in one command |

Two properties worth reading out of the configuration:

- **Archiving is asynchronous.** A commit writes the segment into a spool
  directory and returns; a child process pushes it. Synchronous archiving would
  put the object store's latency inside every segment switch, and an unreachable
  bucket would stall checkpointing until the volume filled. The price is the
  queue: past 1GiB of unshipped WAL, pgBackRest drops the oldest segments with a
  warning and keeps Postgres writing. That is an RPO gap, deliberately chosen
  over an outage.
- **The sidecar cannot write to the data directory.** It mounts PGDATA
  read-only, so a bug in the backup path can read the database and cannot damage
  it.

The component is not part of `deploy/kubernetes` (kind has no object store, and
archiving there would only fill `pg_wal` with segments nothing can ship) and not
part of `deploy/talos` either (a reconcile would try to archive into a repository
that does not exist, and the postgres container would not start). `deploy/pitr`
is `deploy/talos` plus this component, which is the overlay to apply once the
three things below exist:

```sh
kubectl kustomize deploy/pitr | kubectl diff -f -   # what enabling it changes
kubectl apply -k deploy/pitr
```

### What an operator has to provision

Two things, and the first is the one no repository can hold:

1. **A bucket and a Secret.** An S3-compatible bucket, an access key pair and a
   cipher passphrase, in the `postgres-pitr` Secret.
   `02-secrets-pitr.yaml.example` lists the keys. Keep the cipher passphrase
   somewhere that survives the cluster *and* the secret store: without it every
   backup is ciphertext.
2. **The image.** `docker build -f Dockerfile.postgres-pitr -t <registry>/postgres-pitr:17 .`,
   push it, and add it to the commented `images:` block in `deploy/pitr`.
   `release.yml` does not build this image.

Nothing else: no ServiceAccount, no RBAC, no CRD, no operator.

### Is it working?

Four checks, in order of how much they tell you:

```sh
# 1. The repository has a base backup, the WAL range covers it, and the stanza
#    is healthy. This is the state field an alert should watch.
kubectl -n sandbox-system exec -c postgres postgres-0 -- \
  pgbackrest --stanza=sandbox info

# 2. The configuration is right end to end: config, connection, archive_command.
kubectl -n sandbox-system exec -c postgres postgres-0 -- \
  pgbackrest --stanza=sandbox check

# 3. WAL is actually leaving. failed_count and the gap between the last archived
#    segment and the current one are the two numbers that matter.
kubectl -n sandbox-system exec -c postgres postgres-0 -- psql -U sandbox -d sandbox \
  -c "SELECT archived_count, failed_count, last_archived_wal, last_archived_time FROM pg_stat_archiver"

# 4. The sidecar's own log: the last backup, the last verify, and the next one.
kubectl -n sandbox-system logs -c pgbackrest postgres-0 --tail=50
```

`verify` runs after every base backup, so a repository that has stopped being
restorable shows up in the sidecar log and in the `info` status before anyone
needs it. That check is the reason this mechanism was chosen over WAL-G; see
[ADR 0015](adr/0015-postgres-pitr.md).

A fresh volume logs `archive command failed` until the sidecar creates the
stanza, which it retries every ten seconds from its first start. Postgres retries
the same segment on an exponential backoff, so the failure is self-healing, and
the `failed_count` it leaves behind is expected on day one.

## RPO and RTO

| | Designed | Measured |
| --- | --- | --- |
| **RPO** | 60s: `archive_timeout=60` closes a segment, the async push lands it. Up to 1GiB of WAL at risk while the object store is unreachable | 1.2s from `pg_switch_wal` to `last_archived_wal`; the drill also proves replay *stops* at the target, by writing a row 3s after it and showing the row is not in the restored copy |
| **RTO** | restore the newest base backup, replay up to a day of WAL, run the contract | 1.4s restore + 1.3s replay and promote + 2.0s contract, on the drill's 30MB database. Add image pull, volume attach (30s to 2min, [ADR 0010](adr/0010-controller-ha-storage.md)) and a human |

Both numbers are about the database. The outage also includes the operator
finding the cipher passphrase, choosing a target timestamp, and the control plane
being scaled down while the restore runs.

A daily base backup means up to a day of WAL to replay. On a database with real
write volume that is minutes, not seconds; shorten
`PITR_BACKUP_INTERVAL_SECONDS` on the sidecar rather than assuming otherwise.

## Restore: the runbook

Two shapes. Rehearse with the first, use the second for the real thing.

### Into a throwaway instance

This is the quarterly drill, and it is also what to do when someone asks "can we
recover to just before the bad migration" without touching production.

```sh
export PGBACKREST_REPO1_CIPHER_PASS='<from the postgres-pitr Secret>'
aws s3 sync "s3://<bucket>/backup/sandbox" /tmp/pitr-repo/backup/sandbox
aws s3 sync "s3://<bucket>/archive/sandbox" /tmp/pitr-repo/archive/sandbox
./scripts/pitr-drill.sh --restore-from=/tmp/pitr-repo --target='2026-11-15 03:00:00+00'
```

The script copies the repository into a sandbox directory, restores it into a
container, replays to the target, prints where replay stopped, and runs the store
contract against the result. It prints the timings and what it did not cover.
`--keep` leaves the containers up so you can query the recovered database.

A repository from the cluster has no `pitr_drill` table, so the boundary is
asserted by the `recovery stopping before commit of transaction …` line and by
the contract, not by marker rows. Run the local cycle in the section below when
you want the both-sides proof: it writes a row either side of the timestamp and
fails if replay crosses it.

### Over the live volume

The real restore. Two pods must be stopped first: the controller (it writes) and
Postgres (its volume is about to be rewritten).

```sh
# 1. While everything is still up, read the repository: the backups it holds and
#    the WAL range they cover. A target before the oldest backup or after the
#    newest archived segment cannot be reached, and finding that out now is
#    cheaper than finding it out at step 3.
kubectl -n sandbox-system exec -c postgres postgres-0 -- \
  pgbackrest --stanza=sandbox info

# 2. Stop the writer, then the database. The controller holds the Lease, so
#    scaling it to zero is also what stops a new leader from starting mid-restore.
kubectl -n sandbox-system scale deploy/controller --replicas=0
kubectl -n sandbox-system scale sts/postgres --replicas=0

# 3. Restore. Edit the two placeholders in the example job first.
kubectl -n sandbox-system create -f deploy/kubernetes/pitr/restore-job.yaml.example

# 4. Watch it finish, then start the database again. Postgres replays the rest of
#    the WAL itself, from the recovery config the restore job wrote, and promotes
#    at the target.
kubectl -n sandbox-system logs job/postgres-restore -f
kubectl -n sandbox-system scale sts/postgres --replicas=1

# 5. Let the controller migrate and verify the schema, then start traffic.
kubectl -n sandbox-system scale deploy/controller --replicas=1
kubectl -n sandbox-system rollout status deploy/controller --timeout=180s
```

If the volume is **corrupt** rather than merely wrong, do not `--delta` over it.
Delete the PVC (`kubectl -n sandbox-system delete pvc data-postgres-0`), let the
StatefulSet create an empty one, and run the same job without `--delta`. The base
backup is on the object store, so discarding the volume costs one restore.

Step 5 is also where a schema problem surfaces: the controller refuses a database
newer than the build (`refusing to downgrade`), so a restore from a newer release
needs that release.

### After any restore

- Run a create/exec/destroy smoke test against the restored stack, and confirm a
  known `payments.payment_key` has its `payment_ledger` row with the status you
  expect.
- Record the RTO (first command to a serving API), the age of the base backup,
  the WAL replayed, and every step that was not on this page.
- Run `pgbackrest verify` once more. If it fails after a successful restore, the
  repository is in worse shape than the restore suggested and that is worth
  knowing before the next incident.
- Check the sidecar took a backup after the restore, so the timeline is not left
  with a gap where the promoted primary's WAL has nowhere to go.

## The drill

`make pitr-drill` (`./scripts/pitr-drill.sh`) exercises the mechanism, not the
deployment: it starts a throwaway Postgres with the shipped `archive_command` and
the shipped pgBackRest configuration read out of the ConfigMap, takes a base
backup, writes a row either side of a timestamp, replays WAL to that timestamp,
promotes, and runs the store contract against the result. Replaying one row too
far fails the run, which is the assertion `pgbackrest info` cannot make. A POSIX repository in a
temporary directory stands in for the bucket, so it needs docker, node and a
checkout with `node_modules`; the first run also builds the pgBackRest image,
which needs network.

Real output from the run that shipped this, on an M-series Mac with Docker
Desktop, against a 30MB database:

```sh
[pitr-drill] source passes the contract (2.224s, Tests  22 passed)
[pitr-drill] base backup 20261116-015413F in 39.411s (5.8MB in the repository)
[pitr-drill] verifying the repository reads back
[pitr-drill] target timestamp 2026-11-16 01:54:56.95518+00
[pitr-drill] segment 000000010000000000000004 archived in 1.299s (failed archive attempts so far: 0)
[pitr-drill] restore took 1.451s
[pitr-drill] restored instance is up and promoted after 2s (1.269s including WAL replay)
[pitr-drill] recovery stopping before commit of transaction 875, time 2026-11-16 01:55:00.124231+00
[pitr-drill] point in time: 'before' came back, 'after' did not, so replay stopped at 2026-11-16 01:54:56.95518+00
[pitr-drill] contract passed against the restored copy (1.993s, Tests  22 passed)
[pitr-drill] PASS
[pitr-drill]   RTO measured here  2.720s (restore plus replay; no image pull, no volume attach, no human)
```

Read the base backup number with suspicion: 39s to copy 30MB is the container
file-sharing layer on a laptop, not a PVC read and an S3 write. The restore,
replay and contract numbers are the shape of the RTO; the backup number is not
usable for anything.

What the drill does **not** cover, and says so in its own output: the S3
repository, the sidecar loop inside a pod, the NetworkPolicy, the image digest a
cluster pulls, and the PVC. Those need a cluster and a bucket. The first run of
this drill against the reference deployment is the follow-up on #162, and until
it happens this page describes a design that has been exercised, not a
deployment that has been proved.

## The nightly dump (interim, and all that runs today)

Until the bucket exists, the reference deployment takes a smaller step: a nightly
`pg_dump` CronJob (`apps/sandbox/postgres-backup.yaml` in the private deployment
repository), encrypted with the cluster's existing backup key, restored into a
scratch database to prove it reads, and kept for seven days. That catches a bad
migration or a deleted row. It is not disaster recovery, because the dump sits on
a PVC on the same node as the primary.

`make test-restore-dump DUMP=<file>` (`node scripts/restore-dump.mjs <file>`)
runs the whole loop against one of those dumps:

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
copying it out needs a pod with that volume mounted; the private deployment
repository has that command. Then:

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
`--keep` leaves the copy in place for the smoke test above and prints the
`DROP DATABASE` command.

## Restore verification: the store contract

A restore you have never run is a guess. The check is the store contract suite
run against a database restored from the artifact, because it proves the payment,
session, transition and reservation invariants survived the restore, not just
that the restore exited zero.

Point the suite at a database in a recovered instance. It truncates every table,
so use a throwaway instance or a database named for the drill:

```sh
SBX_RESTORE_DATABASE_URL='postgres://sandbox:<pw>@127.0.0.1:5433/sbx_restore_drill' \
  npm run test:store-contract-restored
```

`tests/restore/store-contract.test.ts` refuses a database whose name does not
start with `sbx_restore_`. Set `SBX_RESTORE_ALLOW_ANY_DB=1` only on a recovery
instance you are willing to empty. `scripts/pitr-drill.sh` names its database
`sbx_restore_drill` for exactly this reason.

Note what `npm run test:store-contract` does **not** do: with `DATABASE_URL`
pointed at a restored database it creates a fresh `sbx_test_…` database from
that URL and runs there, so the contract never runs against the restored copy.
That is why both scripts use `npm run test:store-contract-restored`, which runs
the same suite against `SBX_RESTORE_DATABASE_URL` exactly as given.

### Schema versions

`sandbox_schema.version` is the dump's or backup's schema version. The scripts
read it, print it, and act on it the way the controller does at start-up
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
  that wrote the backup.
- **No version row.** Treated as v0 and the base schema is applied. The scripts
  separately refuse an artifact without `sessions`, `payments` and
  `payment_ledger`, so an unrelated database is not mistaken for a backup.

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
production restore path. The drill also says nothing about the Kubernetes objects
around the database (pods, PVCs, the Lease), or about the object store.

`scripts/pitr-drill.sh` closes the WAL half: it archives with the shipped
`archive_command`, takes a real pgBackRest base backup, replays real WAL to a
named timestamp, and proves the boundary in both directions. It is not in CI: it
needs docker, and a runner that builds the pgBackRest image. The quarterly drill
is still a human, and this is the command they run.

`scripts/restore-dump.mjs` closes the dump half: it takes a real `pg_dump -Fc`
file, decrypts it the way the CronJob encrypted it, restores it, compares every
money and session table against the database the dump came from, and runs the
contract against the restored copy. A table that lost rows, gained a duplicate or
changed a value fails the run with the table and both fingerprints named, before
the contract has a chance to truncate anything. `tests/unit/restore-dump.test.ts`
and `tests/unit/restore-verify.test.ts` pin its decisions without a server
(argument parsing, the scratch name, the encryption sniff, the schema-version
branch, and what the fingerprint hashes and orders by). It is not in CI: no
runner holds the `postgres-backups` PVC or the backup key.

What is still unproven:

- **The cluster path.** No run of this design has touched a real bucket, the
  sidecar, the NetworkPolicy or a PVC. `scripts/pitr-drill.sh` exercises the
  commands; nothing exercises the deployment.
- **Node loss.** One primary on one `ReadWriteOnce` volume means the data and the
  node fail together. PITR makes the restore possible with a bounded RPO; it does
  not make it a failover, and the 30s to 2min volume attach is still in the RTO.
- **The rows, when there is no source to compare with**, for the dump path. The
  comparison needs the database the dump came from. `--no-compare`, or a
  `DATABASE_URL` database with no sandbox tables, drops the run back to schema
  and counts, and says so in the output. Comparing a week-old artifact against a
  live source also shows legitimate drift, which reads as a mismatch: check the
  dump's age before believing it.
- **Columns that only one side has.** A dump taken before a ladder step is
  compared on the columns both sides share, and the skipped columns are named.
  An altered value in a column the dump predates is not seen.
- **The quota of a single object store bucket.** There is no second copy in
  another region and no lifecycle rule committed anywhere. The repository is
  off-node, which is the property the old dump path lacked; it is not off-vendor.

## What is not covered

- **Checkpoint workspaces.** A suspendable workspace is a plaintext per-session
  PVC with its own expiry. An object-store checkpoint with a client-held key is
  follow-up 1 in [ADR 0007](adr/0007-checkpoint-at-rest-plaintext.md).
- **Relay state.** In-memory per pod, by design
  ([architecture-principles.md](architecture-principles.md)).
- **The cipher passphrase.** It is in the `postgres-pitr` Secret and nowhere
  else in this design. If the Secret store is lost with the cluster, the
  repository is unreadable. Keep a copy outside both.
