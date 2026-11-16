#!/usr/bin/env bash
# Postgres PITR drill (ADR 0015).
#
# Proves the mechanism the deployment relies on, end to end, on one machine:
#
#   1. start a throwaway Postgres 17 with continuous archiving on, the same
#      `archive_command` and the same pgBackRest configuration the cluster runs;
#   2. take a base backup, write a marker row, record the wall clock, write a
#      second marker row, and force the WAL segment out;
#   3. restore the base backup into an empty data directory and replay WAL up to
#      the recorded timestamp, which must keep the first row and drop the second;
#   4. start it, confirm it is a promoted primary, and run the store contract
#      suite against it, because "the database starts" is not "the ledger
#      survived".
#
# What it cannot prove from a laptop, and does not claim to: the S3 repository,
# the sidecar's daily loop, the NetworkPolicy, the image digest the cluster
# pulls, and the PVC. It uses a POSIX repository in a directory instead of a
# bucket. Everything else is the shipped configuration: the file is extracted
# from deploy/kubernetes/pitr/configmap.yaml and the archive command is checked
# against the StatefulSet patch, so this cannot drift from the deployment
# without failing here.
#
#   ./scripts/pitr-drill.sh                   # full cycle on this machine
#   ./scripts/pitr-drill.sh --keep            # leave both containers running
#   ./scripts/pitr-drill.sh --restore-from=DIR --target='2026-11-15 03:00:00+00'
#                                             # quarterly drill against a
#                                             # repository copied down with
#                                             # `aws s3 sync`, contract only
#
# Requirements: docker, and a checkout with node_modules installed (the last
# step runs the store contract). The image is built from
# Dockerfile.postgres-pitr on the first run if it is not present.
#
# Exit codes: 0 the restored copy passed the point-in-time assertions and the
# contract, 1 any step failed, 2 usage error.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${PITR_IMAGE:-x402-sandbox/postgres-pitr:17}"
STANZA="sandbox"
DB_NAME="sbx_restore_drill"
DB_USER="sandbox"
DB_PASSWORD="${PITR_DB_PASSWORD:-pitr-drill}"
CONFIG_MANIFEST="$ROOT/deploy/kubernetes/pitr/configmap.yaml"
STATEFULSET_PATCH="$ROOT/deploy/kubernetes/pitr/postgres-statefulset.patch.yaml"
ARCHIVE_COMMAND="archive_command=pgbackrest --stanza=sandbox archive-push %p"
CONTRACT_SCRIPT="test:store-contract-restored"

usage() {
  sed -n '2,36p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

restore_from=""
target=""
keep=0
for argument in "$@"; do
  case "$argument" in
    --keep) keep=1 ;;
    --restore-from=*) restore_from="${argument#*=}" ;;
    --target=*) target="${argument#*=}" ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "pitr-drill: unknown argument '$argument' (try --help)" >&2
      exit 2
      ;;
  esac
done

say() { echo "[pitr-drill] $*"; }
die() {
  echo "[pitr-drill] FAIL: $*" >&2
  exit 1
}

# `date +%s%3N` is not portable to the BSD date on macOS, which is where this
# runs, and the numbers here are small enough that whole seconds hide the answer.
# node is already a hard requirement of the last step.
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }
since_ms() { echo $(( $(now_ms) - $1 )); }
seconds() { echo "$(( $1 / 1000 )).$(printf '%03d' $(( $1 % 1000 )))s"; }

# --- preflight -------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker is not on PATH; this drill needs a container runtime"
command -v node >/dev/null 2>&1 || die "node is not on PATH; the drill runs the store contract and uses node as its clock"
docker info >/dev/null 2>&1 || die "docker is not running"
[ -x "$ROOT/node_modules/.bin/vitest" ] ||
  die "node_modules is missing; run 'npm ci' in $ROOT first (the last step runs the store contract)"
[ -f "$CONFIG_MANIFEST" ] || die "$CONFIG_MANIFEST is missing; the drill reads the shipped pgBackRest config from it"
[ -f "$STATEFULSET_PATCH" ] || die "$STATEFULSET_PATCH is missing"
grep -Fq "$ARCHIVE_COMMAND" "$STATEFULSET_PATCH" ||
  die "$STATEFULSET_PATCH no longer sets '$ARCHIVE_COMMAND'; update this drill with it"

# The configuration under test is the one in the ConfigMap, with the repository
# swapped from S3 to a directory. Nothing is retyped here: a key added to the
# manifest is a key the drill runs, and a key removed from it is a key the drill
# stops covering.
CONFIG="$(awk '
  /^  pgbackrest\.conf: \|$/ { inside = 1; next }
  /^  [a-z-]+\.sh: \|$/ { inside = 0 }
  !inside { next }
  { sub(/^    /, "") }
  $0 == "repo1-type=s3" { print "repo1-type=posix"; print "repo1-path=/repo"; next }
  { print }
' "$CONFIG_MANIFEST")"
[ -n "$CONFIG" ] || die "could not read the pgbackrest.conf block out of $CONFIG_MANIFEST"
grep -Fq '[global]' <<<"$CONFIG" || die "the pgbackrest.conf block in $CONFIG_MANIFEST has no [global] section"
grep -Fq 'archive-async=y' <<<"$CONFIG" ||
  die "the pgbackrest.conf block lost archive-async=y; the drill would stop covering the archive queue"
grep -Fq 'repo1-path=/repo' <<<"$CONFIG" ||
  die "could not swap the S3 repository for a directory: the block no longer says repo1-type=s3"
if grep -Fq 'repo1-type=s3' <<<"$CONFIG"; then
  die "the swap left repo1-type=s3 in the config; the drill would try to reach an object store"
fi

if [ -z "${PITR_SKIP_BUILD:-}" ] && ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  say "building $IMAGE from Dockerfile.postgres-pitr"
  docker build -f "$ROOT/Dockerfile.postgres-pitr" -t "$IMAGE" "$ROOT" >/dev/null ||
    die "could not build $IMAGE"
fi
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "$IMAGE does not exist and PITR_SKIP_BUILD is set"

# --- work directory and containers ----------------------------------------
WORK="${PITR_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/pitr-drill.XXXXXX")}"
WORK="${WORK%/}"
mkdir -p "$WORK/repo" "$WORK/spool/log" "$WORK/source" "$WORK/restore"
# The containers run as uid 999, which owns nothing on the host.
chmod -R 0777 "$WORK"
printf '%s\n' "$CONFIG" >"$WORK/pgbackrest.conf"
chmod 0644 "$WORK/pgbackrest.conf"

SOURCE="pitr-drill-source-$$"
RESTORED="pitr-drill-restore-$$"
# A repository this drill created is encrypted with a pass nobody else needs to
# know. A repository it did not create (--restore-from) was encrypted by the
# cluster, so the pass has to come from the environment, exactly as the pod gets
# it from the Secret.
CIPHER_PASS="${PGBACKREST_REPO1_CIPHER_PASS:-drill-$(date +%s)-$RANDOM$RANDOM}"
OUTPUT="$WORK"

# The same shape as the pod: the file holds the configuration, the environment
# holds the cipher pass and the database user, and nothing is passed on a
# command line.
container_env=(
  -e "PGBACKREST_REPO1_CIPHER_PASS=$CIPHER_PASS"
  -e "PGBACKREST_PG1_USER=$DB_USER"
)
container_mounts=(
  -v "$WORK/repo:/repo"
  -v "$WORK/spool:/var/spool/pgbackrest"
  -v "$WORK/pgbackrest.conf:/etc/pgbackrest/pgbackrest.conf:ro"
)

cleanup() {
  status=$?
  # A failed drill with its logs deleted is a failed drill twice. Print the tail
  # of whatever it managed to write before the work directory goes away.
  if [ "$status" -ne 0 ] && [ "$keep" -eq 0 ]; then
    for log in "$WORK"/restore.log "$WORK"/backup.log "$WORK"/contract.log "$WORK"/baseline.log; do
      [ -s "$log" ] || continue
      echo "[pitr-drill] --- ${log##*/} (last 15 lines) ---" >&2
      tail -15 "$log" >&2
    done
  fi
  if [ "$keep" -eq 1 ]; then
    say "--keep: $SOURCE and $RESTORED left running, work directory $WORK kept"
    say "  inspect the repository with: docker exec -u postgres $RESTORED pgbackrest info"
    say "  remove everything with: docker rm -f $SOURCE $RESTORED && rm -rf $WORK"
  else
    docker rm -f "$SOURCE" "$RESTORED" >/dev/null 2>&1 || true
    rm -rf "$WORK"
  fi
  if [ "$status" -ne 0 ]; then
    echo "[pitr-drill] FAIL: the drill did not finish (exit $status)" >&2
  fi
}
trap cleanup EXIT
# A `set -e` exit names nothing, which is how a drill fails in someone else's
# terminal and gets reported as "it did not work". Say which step.
trap 'echo "[pitr-drill] failed at line $LINENO: $BASH_COMMAND" >&2' ERR
set -E

# psql inside a container, so the drill needs no host Postgres client. One round
# trip per call is fine at this size and keeps the steps readable.
psql_in() {
  docker exec "$1" psql -U "$DB_USER" -d "$DB_NAME" -tAX -c "$2"
}

host_port_of() {
  local published
  published="$(docker port "$1" 5432/tcp 2>/dev/null | head -1)"
  echo "${published##*:}"
}

# Echoes the number of seconds it waited, and fails after `tries` seconds.
wait_for_postgres() {
  local container="$1" tries="${2:-120}" index
  for ((index = 1; index <= tries; index += 1)); do
    if docker exec "$container" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
      echo "$index"
      return 0
    fi
    sleep 1
  done
  return 1
}

run_contract() {
  local url="$1" log="$2"
  (
    cd "$ROOT" &&
      DATABASE_URL="$url" SBX_RESTORE_DATABASE_URL="$url" npm run --silent "$CONTRACT_SCRIPT"
  ) >"$log" 2>&1
}

if [ -n "$restore_from" ]; then
  # --- quarterly mode: an existing repository, no source phase -------------
  [ -d "$restore_from" ] || die "--restore-from '$restore_from' is not a directory"
  [ -n "$target" ] ||
    die "--restore-from needs --target='<timestamp>': naming the moment to recover to is the whole drill"
  say "restoring from $restore_from to $target"
  # A copy, so a restore bug cannot touch the artifact an operator just carried
  # off the object store, and so the container can write its locks somewhere.
  rm -rf "$WORK/repo"
  cp -R "$restore_from" "$WORK/repo" || die "could not copy $restore_from into the sandbox"
  chmod -R 0777 "$WORK/repo"
  restore_started="$(now_ms)"
else
  # --- local mode: build the timeline we are going to recover to -----------
  say "starting the source database with archive_mode=on"
  docker run -d --name "$SOURCE" \
    -e "POSTGRES_USER=$DB_USER" \
    -e "POSTGRES_PASSWORD=$DB_PASSWORD" \
    -e "POSTGRES_DB=$DB_NAME" \
    -e PGDATA=/var/lib/postgresql/data/pgdata \
    "${container_env[@]}" \
    -p 127.0.0.1::5432 \
    -v "$WORK/source:/var/lib/postgresql/data" \
    "${container_mounts[@]}" \
    "$IMAGE" \
    -c archive_mode=on \
    -c archive_timeout=60 \
    -c unix_socket_directories=/var/run/postgresql \
    -c "$ARCHIVE_COMMAND" >/dev/null ||
    die "could not start the source container"
  wait_for_postgres "$SOURCE" >/dev/null || die "the source database never came up; check docker logs $SOURCE"
  source_port="$(host_port_of "$SOURCE")"
  [ -n "$source_port" ] || die "the source container published no port; the contract suite needs one"
  say "source is up on 127.0.0.1:$source_port"

  # The stanza comes before any traffic, the way the sidecar creates it at pod
  # start. A base backup refuses to begin until the WAL before its start point is
  # archived, and Postgres retries a failing archive_command on an exponential
  # backoff, so archiving into a repository with no stanza turns a 15s backup
  # into a 60s one for no reason.
  say "creating the stanza"
  docker exec -u postgres "$SOURCE" pgbackrest check --stanza="$STANZA" >/dev/null 2>&1 ||
    docker exec -u postgres "$SOURCE" pgbackrest stanza-create --stanza="$STANZA" >/dev/null ||
    die "stanza-create failed; check the repository and the cipher pass"

  # The schema has to exist before the base backup, and the cheapest honest way
  # to create it is the suite that will later judge the restored copy. A pass
  # here is also the baseline the restored copy has to match.
  say "seeding the schema and taking a baseline: the store contract on the source"
  baseline_started="$(now_ms)"
  run_contract "postgres://$DB_USER:$DB_PASSWORD@127.0.0.1:$source_port/$DB_NAME" "$OUTPUT/baseline.log" ||
    { tail -30 "$OUTPUT/baseline.log" >&2; die "the store contract failed on the source database"; }
  baseline_ms="$(since_ms "$baseline_started")"
  say "source passes the contract ($(seconds "$baseline_ms"), $(grep -oE 'Tests +[0-9]+ passed' "$OUTPUT/baseline.log" | head -1))"

  say "taking a full base backup"
  backup_started="$(now_ms)"
  docker exec -u postgres "$SOURCE" pgbackrest backup --stanza="$STANZA" --type=full \
    --log-level-console=info >"$OUTPUT/backup.log" 2>&1 ||
    die "the base backup failed; see the pgBackRest output in $OUTPUT/backup.log"
  backup_ms="$(since_ms "$backup_started")"
  backup_label="$(sed -n 's/.*new backup label = \([^ ]*\).*/\1/p' "$OUTPUT/backup.log" | tail -1)"
  docker exec -u postgres "$SOURCE" pgbackrest info --stanza="$STANZA" >"$OUTPUT/info.log" 2>&1 || true
  backup_bytes="$(sed -n 's/.*repo1: backup set size: \([^,]*\).*/\1/p' "$OUTPUT/info.log" | tail -1)"
  say "base backup ${backup_label:-?} in $(seconds "$backup_ms") (${backup_bytes:-unknown} in the repository)"

  say "verifying the repository reads back"
  docker exec -u postgres "$SOURCE" pgbackrest verify --stanza="$STANZA" >/dev/null 2>&1 ||
    die "pgbackrest verify failed: the repository cannot be read back, so there is nothing to drill"

  # The timeline. The row committed before the target must come back, the row
  # committed after it must not. A restore that only proves "there is data"
  # proves nothing about point in time.
  say "writing the marker rows around the target"
  psql_in "$SOURCE" "CREATE TABLE pitr_drill (id text PRIMARY KEY, note text)" >/dev/null
  psql_in "$SOURCE" "INSERT INTO pitr_drill VALUES ('before', 'committed before the target')" >/dev/null
  # A few seconds of margin: pgBackRest refuses a target that is not strictly
  # after the base backup's stop time, and the check is in whole seconds.
  sleep 3
  target="$(psql_in "$SOURCE" "SELECT now()")"
  say "target timestamp $target"
  sleep 3
  psql_in "$SOURCE" "INSERT INTO pitr_drill VALUES ('after', 'committed after the target')" >/dev/null
  current_segment="$(psql_in "$SOURCE" "SELECT pg_walfile_name(pg_current_wal_lsn())")"
  psql_in "$SOURCE" "SELECT pg_switch_wal()" >/dev/null
  archive_started="$(now_ms)"
  archived=""
  for ((index = 1; index <= 90; index += 1)); do
    archived="$(psql_in "$SOURCE" "SELECT last_archived_wal FROM pg_stat_archiver")"
    if [ "$archived" = "$current_segment" ]; then break; fi
    sleep 1
  done
  [ "$archived" = "$current_segment" ] ||
    die "segment $current_segment was not archived within 90s (pg_stat_archiver says '$archived'); the archiver is the thing under test"
  archive_ms="$(since_ms "$archive_started")"
  failed_archives="$(psql_in "$SOURCE" "SELECT failed_count FROM pg_stat_archiver")"
  say "segment $current_segment archived in $(seconds "$archive_ms") (failed archive attempts so far: ${failed_archives:-0})"

  restore_started="$(now_ms)"
fi

# --- restore --------------------------------------------------------------
# Into an empty directory, as the unprivileged user, with the same file and
# environment the cluster uses. `--type=time --target-action=promote` is what
# docs/backup-restore.md tells an operator to run.
say "unpacking the base backup and writing the recovery config for $target"
mkdir -p "$WORK/restore/pgdata"
chmod 0700 "$WORK/restore/pgdata"
docker run --rm -u postgres "${container_env[@]}" \
  -v "$WORK/restore:/var/lib/postgresql/data" \
  "${container_mounts[@]}" \
  --entrypoint pgbackrest "$IMAGE" \
  restore --stanza="$STANZA" --type=time --target="$target" --target-action=promote \
  --log-level-console=info >"$OUTPUT/restore.log" 2>&1 ||
  die "pgbackrest restore failed; see the pgBackRest output in $OUTPUT/restore.log"
restore_ms="$(since_ms "$restore_started")"
say "restore took $(seconds "$restore_ms")"

# --- start it and wait for replay ----------------------------------------
docker run -d --name "$RESTORED" \
  -e PGDATA=/var/lib/postgresql/data/pgdata \
  "${container_env[@]}" \
  -p 127.0.0.1::5432 \
  -v "$WORK/restore:/var/lib/postgresql/data" \
  "${container_mounts[@]}" \
  "$IMAGE" >/dev/null || die "could not start the restored instance"
start_started="$(now_ms)"
ready_after="$(wait_for_postgres "$RESTORED" 180)" || {
  docker logs "$RESTORED" >&2 || true
  die "the restored instance never accepted connections; the recovery log is above"
}
start_ms="$(since_ms "$start_started")"
in_recovery="$(psql_in "$RESTORED" "SELECT pg_is_in_recovery()")"
[ "$in_recovery" = "f" ] ||
  die "the restored instance is still in recovery: replay did not reach the target, so nothing was promoted"
say "restored instance is up and promoted after ${ready_after}s ($(seconds "$start_ms") including WAL replay)"

restored_port="$(host_port_of "$RESTORED")"
[ -n "$restored_port" ] || die "could not read the restored instance's published port"

# --- the point-in-time assertions ----------------------------------------
# Where replay actually stopped, from the recovery log. This is the evidence an
# operator reads first, and it exists whether or not the repository has the
# drill's marker table.
stopped_at="$(docker logs "$RESTORED" 2>&1 | sed -n 's/.*LOG:  \(recovery stopping .*\)/\1/p' | tail -1)"
if [ -n "$stopped_at" ]; then
  say "$stopped_at"
fi

if [ "$(psql_in "$RESTORED" "SELECT to_regclass('pitr_drill') IS NOT NULL")" = "t" ]; then
  markers="$(psql_in "$RESTORED" "SELECT string_agg(id, ',' ORDER BY id) FROM pitr_drill")"
  case ",$markers," in
    *,before,after,*) die "the restore replayed past the target: both marker rows are present ($markers)" ;;
    *,before,*) say "point in time: 'before' came back, 'after' did not, so replay stopped at $target" ;;
    *) die "the restore lost the row committed before the target (markers: '${markers}')" ;;
  esac
else
  # A repository from the cluster has no marker table: only this drill writes
  # one. Say so rather than implying the boundary was checked, and lean on the
  # recovery log line above plus the contract below.
  say "this repository has no pitr_drill table (it did not come from a local run), so the boundary is asserted by the recovery log line above and the contract, not by marker rows"
fi

# --- the part that decides whether the ledger survived --------------------
say "running the store contract against the restored copy"
contract_started="$(now_ms)"
run_contract "postgres://$DB_USER:$DB_PASSWORD@127.0.0.1:$restored_port/$DB_NAME" "$OUTPUT/contract.log" || {
  tail -30 "$OUTPUT/contract.log" >&2
  die "the store contract failed against the restored copy; the whole log is in $OUTPUT/contract.log"
}
contract_ms="$(since_ms "$contract_started")"
say "contract passed against the restored copy ($(seconds "$contract_ms"), $(grep -oE 'Tests +[0-9]+ passed' "$OUTPUT/contract.log" | head -1))"

# The promoted cluster is on a new timeline, which is what promotion means.
timeline="$(psql_in "$RESTORED" "SELECT timeline_id FROM pg_control_checkpoint()")"

say "PASS"
say "  target             $target"
if [ -n "${backup_ms:-}" ]; then
  say "  base backup        $(seconds "$backup_ms") (${backup_label:-?}, ${backup_bytes:-unknown} in the repository)"
  say "  wal archive        $(seconds "$archive_ms") from pg_switch_wal to last_archived_wal"
  say "  baseline           $(seconds "$baseline_ms") for the same contract suite on the source"
else
  say "  base backup        not taken in this run (--restore-from)"
fi
say "  restore            $(seconds "$restore_ms") to unpack the base backup and write the recovery config"
say "  replay and start   $(seconds "$start_ms") until the promoted instance accepted connections"
say "  contract           $(seconds "$contract_ms") for the store suite on the restored copy"
say "  timeline           $timeline after promotion"
say "  RTO measured here  $(seconds $((restore_ms + start_ms))) (restore plus replay; no image pull, no volume attach, no human)"
say "  covered            archive_command -> base backup -> WAL replay to a timestamp -> contract"
say "  not covered        the S3 repository, the sidecar loop, the NetworkPolicy, the image digest, the PVC"
if [ -n "${backup_ms:-}" ]; then
  say "  note               the base backup number is local disk through the container file-sharing layer, not a PVC read and an object-store write; the restore and replay numbers are the shape of the RTO"
fi
