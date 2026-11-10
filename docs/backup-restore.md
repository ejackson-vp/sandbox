# Backup and restore

Status: **implemented; disabled by default.** Enable it in the cluster overlay
once the `backup-encryption-key` secret exists.

The controller keeps the payment ledger, intents and session state in one SQLite
database. This page covers the automated, encrypted backup and the restore
procedure. It is not a substitute for off-site storage or point-in-time
recovery.

## What is backed up

Every backup is a consistent copy of the whole controller database, including:

- `payments` and `payment_ledger` (the money records);
- `payment_intents` (the replay/outbox state);
- `sessions`, operations and reservations.

The copy is made with SQLite's online backup API, so the controller keeps
serving while it runs. The copy is checked with `PRAGMA integrity_check` and
table row counts before it is encrypted.

## Schedule and retention

| Setting | Default | Meaning |
|---|---|---|
| `BACKUP_DIR` | empty | Backup directory. Empty disables the service. |
| `BACKUP_INTERVAL_MS` | `21600000` (6 h) | Minimum time between backup attempts. |
| `BACKUP_RETENTION` | `14` | Number of encrypted backups to keep. |
| `BACKUP_ENCRYPTION_KEY` | required when enabled | 32 bytes as base64 or 64 hex characters. |

The RPO is the backup interval (6 hours by default). The RTO is the time to
scale the controller down, run the restore job, verify counts and scale up:
expect roughly 10 minutes for a small homelab database. Backups live on the
separate `controller-backups` PVC. That protects against a corrupt database or a
bad migration, but **not** against losing the node or both PVCs. Copy the newest
encrypted file off the cluster for disaster recovery.

## Encryption

Each file is written as:

```text
X402BK1\n | 12-byte IV | AES-256-GCM ciphertext | 16-byte tag
```

The key is read from `backup-encryption-key` in `x402-secrets`. Losing it makes
every backup unreadable; keep it with the other recovery material. Rotating it
does not re-encrypt old files, so retain the old key for the old backups.

## Enable

1. Generate a key and add it to the secret (do not commit the plaintext):

   ```bash
   openssl rand -base64 32
   ```

   Add the value as `backup-encryption-key` in `x402-secrets` (the homelab's
   SOPS file, or local `deploy/kubernetes/02-secrets-dev.yaml`). If your local
   secret predates this key, rerun `scripts/dev-secrets.sh --force`.

2. In the cluster overlay, set:

   ```yaml
   BACKUP_DIR: "/backups"
   BACKUP_INTERVAL_MS: "21600000"
   BACKUP_RETENTION: "14"
   ```

   The base manifest already mounts `controller-backups` at `/backups`. The
   controller fails fast if `BACKUP_DIR` is set without the key.

3. Roll the controller and check the first backup:

   ```bash
   kubectl -n sandbox-system rollout status deploy/controller
   kubectl -n sandbox-system exec deploy/controller -- \
     ls -l /backups
   curl -s http://controller.sandbox-system:9100/metrics | \
     grep sandbox_backup
   ```

A successful backup logs `backup_completed` with the row counts and byte size.
A failed attempt logs `backup_failed` and increments
`sandbox_backup_failures_total`. Alert when `sandbox_backup_age_seconds` exceeds
twice the configured interval.

## Restore

Stop the writer first. A WAL or SHM sidecar next to the target is refused rather
than overwritten.

1. Scale the controller to zero:

   ```bash
   kubectl -n sandbox-system scale deploy/controller --replicas=0
   kubectl -n sandbox-system wait --for=delete pod -l app=controller --timeout=120s
   ```

2. Pick the newest backup:

   ```bash
   kubectl -n sandbox-system run backup-list --rm -it --restart=Never \
     --image=<control-image> \
     --overrides='{"spec":{"containers":[{"name":"list","image":"<control-image>","command":["ls","-l","/backups"],"volumeMounts":[{"name":"backups","mountPath":"/backups"}]}],"volumes":[{"name":"backups","persistentVolumeClaim":{"claimName":"controller-backups"}}]}}'
   ```

3. Run the restore job. Copy
   [`deploy/kubernetes/backup-restore-job.yaml.example`](../deploy/kubernetes/backup-restore-job.yaml.example),
   replace the image tag and backup filename, and apply it:

   ```bash
   kubectl apply -f deploy/kubernetes/backup-restore-job.yaml.example
   kubectl -n sandbox-system logs -f job/controller-restore
   ```

   The job decrypts to a temporary file, verifies integrity and counts,
   preserves the existing database as `controller.db.pre-restore-<timestamp>`,
   and only then installs the restored copy. Add
   `--payment-key=<key>` to the job args to assert that a known payment and its
   ledger row are present.

4. Scale the controller back up and check readiness:

   ```bash
   kubectl -n sandbox-system scale deploy/controller --replicas=1
   kubectl -n sandbox-system rollout status deploy/controller
   ```

5. Keep the `pre-restore` file until a create/exec/destroy smoke test passes,
   then remove it.

## Rehearsal

A restore you have never run is a guess. Once a quarter:

1. take the newest file to a scratch namespace or a local directory;
2. run the same `backup-restore` command against a scratch database;
3. confirm the printed counts and `PRAGMA integrity_check`;
4. record the RTO and any missing steps.

The unit tests cover encryption round-trips, a wrong key, a truncated file, a
known payment, retention, and the native online copy.
