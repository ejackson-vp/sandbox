/**
 * Restore a controller backup after the controller has been stopped.
 *
 * The key is read from the flag, not logged. The target database must not have a
 * WAL/SHM sidecar; see docs/backup-restore.md for the full procedure.
 */
import { parseArgs } from "node:util";
import { restoreBackup } from "./backup.js";
import { parseBackupKey } from "./backup-key.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      backup: { type: "string" },
      db: { type: "string" },
      key: { type: "string" },
      "payment-key": { type: "string" },
      force: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  if (!values.backup || !values.db) {
    throw new Error(
      "usage: backup-restore --backup <file.db.enc> --db <path> [--key <base64|hex>] [--payment-key <key>] [--force]",
    );
  }
  const rawKey = values.key ?? process.env.BACKUP_ENCRYPTION_KEY;
  if (!rawKey) {
    throw new Error("BACKUP_ENCRYPTION_KEY is not set; pass --key or set the environment");
  }
  const counts = await restoreBackup(
    values.backup,
    values.db,
    parseBackupKey(rawKey),
    {
      force: values.force,
      ...(values["payment-key"] ? { paymentKey: values["payment-key"] } : {}),
    },
  );
  console.log(JSON.stringify({ restored: values.db, counts }, null, 2));
}

main().catch((err: unknown) => {
  console.error(`backup restore failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
