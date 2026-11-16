# 0015. Point-in-time recovery for the ledger's Postgres with pgBackRest

Status: accepted (2026-11-15). Ships as the `pitr` kustomize component
(`deploy/kubernetes/pitr/`), composed by `deploy/pitr` (the reference deployment
plus that component, and not the default: see the cost below). Drilled end to end
against a local Postgres with a POSIX repository; **not yet run against the
cluster's object store**, because this repository cannot provision one.

## Context

The Postgres durability row in `security-review/RELEASE_GATE.md` is PARTIAL: a
nightly `pg_dump` completes, there is no point-in-time recovery, and the restore
drill has never run against production data (#162). A dump a day means a bad
migration, a wrong `DELETE` or a corrupted page costs up to 24 hours of the
payment ledger, and the ledger is the one table whose loss cannot be repaired by
redoing the work: the chain has the transfer, and the database has no record of
what it paid for.

Sessions are a different problem. A lost `sessions` row costs a refund or a
re-run, both of which the code already does. That asymmetry is why this record
spends its budget on a byte-level recovery window for the whole database rather
than on anything clever per table.

What this has to fit:

- a plain Postgres 17 StatefulSet, one primary, one `ReadWriteOnce` volume,
  pinned to the control-plane node ([ADR 0010](0010-controller-ha-storage.md));
- an object store this repository cannot provision, and no bucket name, endpoint,
  account id or key may be committed;
- one operator, who is also the person who will run the restore at 3am;
- no change to the API, the controller or the payment path.

## Decision

**pgBackRest 2.60, continuous WAL archiving to an S3-compatible repository, a
daily base backup from a sidecar in the existing pod, and restores by
`pgbackrest restore --type=time`.**

Concretely, in `deploy/kubernetes/pitr/`:

- Postgres starts with `archive_mode=on`,
  `archive_command = pgbackrest --stanza=sandbox archive-push %p` and
  `archive_timeout=60`.
- Archiving is asynchronous with a 1GiB queue bound, so an unreachable bucket
  stops the RPO from improving instead of stopping the write path.
- A `pgbackrest` sidecar shares the pod's unix socket, mounts PGDATA read-only,
  creates the stanza if it is missing, and then does `backup --type=full`,
  `verify`, sleep a day.
- 14 days of base backups and the WAL that belongs to them, pruned by
  `repo1-retention-full-type=time`.
- The repository is encrypted (`aes-256-cbc`) with a pass that exists only in a
  Secret.
- Configuration lives in a ConfigMap. The bucket, endpoint, region, keys and
  cipher pass arrive as `PGBACKREST_*` environment variables from the
  `postgres-pitr` Secret, which is why nothing in the repository is a credential.
- **No ServiceAccount and no RBAC.** Nothing in this design calls the Kubernetes
  API, and the pod already runs with `automountServiceAccountToken: false`. A
  cluster with pod identity would annotate a ServiceAccount and drop the access
  keys from the Secret; that is an improvement to make there, not a requirement
  here.

### RPO and RTO as designed

| | Designed | Evidence |
| --- | --- | --- |
| RPO | 60s: `archive_timeout=60` closes a segment, the async push lands it. Measured push latency 1.2s. Up to 1GiB of WAL is at risk if the store is unreachable, and that shows up as failed `pg_stat_archiver` counts | the drill writes a row 3s after the target and proves it is not in the restored copy, so replay really stops where it is told to |
| RTO | restore the newest base, replay up to a day of WAL, run the contract | 1.4s restore + 1.3s replay and promote + 2.0s contract on the drill's 30MB database. Add image pull, volume attach (30s to 2min per ADR 0010), and a human |

The RTO number is the database work, not the outage. The outage includes the
operator finding the cipher pass, deciding on a target timestamp, and the
control plane being down while the controller is scaled to zero.

## Rejected: WAL-G

The close second, and the cheaper install: one static binary, environment-only
configuration, no stanza, `wal-g backup-push` and `wal-g backup-fetch`. It also
has a file-backed backend, which would have made the local drill simpler.

Rejected on two things that matter more to one operator than install effort:

1. **`pgbackrest verify`.** It re-reads the repository and checks each backup
   against its manifest, including the WAL needed to make it consistent, without
   restoring it. The risk with a backup system nobody watches is not that it
   stops running (that alerts) but that it keeps running and produces artifacts
   that do not restore. WAL-G has no equivalent check; the only proof is a
   restore, which is the expensive thing this change is trying to make routine.
2. **Retention.** `repo1-retention-full-type=time` with 14 days expires base
   backups and their WAL together. WAL-G needs a separate `delete retain FULL n`
   invocation, which is a second job with its own schedule and its own way of
   being wrong (an empty repository is the quiet failure, a full bucket the
   loud one).

Cost of that choice: a config file with about fifteen options, a stanza that has
to exist before the first `archive-push` succeeds (a fresh volume logs archive
failures until the sidecar creates it), and a derived image.

## Rejected: CloudNativePG

The better end state, and the wrong next step. A `Cluster` owns the pods, the
service, the PVCs and the backups, and gives streaming replicas, an instance
manager and `bootstrap.recovery` for free. It also cannot adopt what runs today:
there is no supported path from a plain `postgres:17` data directory on a
`ReadWriteOnce` PVC into a CNPG cluster short of dumping and restoring the ledger
into a new one. That migration is a full outage and a restore performed with no
tested backup on the other side, which is the exact risk this change exists to
remove. Doing CNPG first means doing the dangerous restore first, and installing
an operator on the critical path at the same time.

What is given up is the real fix for node loss: a second copy of the database on
another node. This design does not provide one, and the runbook is honest about
it.

## Cost, stated

- **The write path no longer waits for the bucket, and the queue is the price.**
  Past `archive-push-queue-max=1GiB` pgBackRest drops the oldest queued segments
  with a warning and keeps Postgres writing. That is an RPO gap; `verify` after
  the next backup names it, and the archiver counters in
  [backup-restore.md](../backup-restore.md) are the alert.
- **A second image, and a deployment that is not on by default.**
  `Dockerfile.postgres-pitr` adds pgBackRest to `postgres:17`, because
  `archive_command` runs inside the postgres container and the stock image has no
  pgBackRest. Until that image and the Secret exist, applying the component does
  not degrade the database, it stops it: ImagePullBackOff on the postgres
  container, or a pod that will not start for a missing Secret. That is why
  `deploy/pitr` exists as a separate overlay and `deploy/talos` was left alone.
  `release.yml` does not build it and `deploy/release-pins.json` does not cover
  it, so the digest in the overlay is the only pin. An operator has to build,
  push and pin it before the component works.
- **The cipher pass is recovery material.** Lose it and the repository is
  ciphertext. Keeping it in the same bucket is the failure mode worth naming in
  a runbook, which is why `docs/backup-restore.md` says to keep it somewhere
  else.
- **WAL volume.** `archive_timeout=60` forces a segment switch whenever there has
  been activity, so a database doing a little work all day pushes 16MB segments
  continuously. On the drill's 30MB database a full backup is 5.8MB compressed;
  WAL is the number that grows, and raising `archive_timeout` to 300 buys a
  quarter of the storage for five times the RPO.
- **A daily base backup means up to a day of replay.** 1.3s for the drill's
  single segment; minutes for a database with real write volume. Shortening the
  interval buys restore time with storage, and the sidecar takes the interval as
  an environment variable.

## What is not proved

- The cluster path: S3, IAM, the sidecar loop inside a pod, the NetworkPolicy,
  the digest, the PVC mount. None of it has run.
- `scripts/pitr-drill.sh` proves the mechanism (archive command, base backup, WAL
  replay to a timestamp, store contract) on one machine with a POSIX repository.
  Its numbers are in [backup-restore.md](../backup-restore.md).
- Node loss. One primary on one volume still means the data and the node fail
  together; this makes the restore possible with a bounded RPO, not fast. A
  second node needs a second copy, which is the CloudNativePG discussion above.
- Nothing in this repository backs up checkpoint workspaces
  ([ADR 0007](0007-checkpoint-at-rest-plaintext.md)).
