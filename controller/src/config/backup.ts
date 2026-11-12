/**
 * Scheduled SQLite backups: where, how often, how many, and with which key.
 *
 * The key material is parsed and validated before any listener port so a
 * controller with a backup directory and no key fails on the first thing an
 * operator can fix. The interval and retention are read later, with the rest
 * of the persisted-state settings.
 *
 * A relay or proxy never writes the database, so neither runs backups and
 * neither is asked for a key.
 */
import { envInt as int } from "@x402s/shared/env";
import { parseBackupKey } from "../backup-key.js";
import type { Role } from "./role.js";
import type { ControllerConfig } from "./types.js";

interface BackupKeyMaterial {
  /** Empty disables scheduled backups. */
  backupDir: string;
  /** Required when backupDir is set; null when backups are disabled. */
  backupKey: Buffer | null;
}

type BackupSettings = Pick<
  ControllerConfig,
  "backupDir" | "backupIntervalMs" | "backupRetention" | "backupKey"
>;

export function parseBackupKeyMaterial(
  env: NodeJS.ProcessEnv,
  role: Role,
): BackupKeyMaterial {
  const backupEnabled = role === "controller" || role === "all";
  const backupDir = backupEnabled ? (env.BACKUP_DIR ?? "") : "";
  const backupKey =
    backupEnabled && backupDir && env.BACKUP_ENCRYPTION_KEY
      ? parseBackupKey(env.BACKUP_ENCRYPTION_KEY)
      : null;
  if (backupDir && !backupKey) {
    throw new Error("BACKUP_ENCRYPTION_KEY is required when BACKUP_DIR is set");
  }
  return { backupDir, backupKey };
}

export function parseBackup(
  env: NodeJS.ProcessEnv,
  material: BackupKeyMaterial,
): BackupSettings {
  return {
    backupDir: material.backupDir,
    backupIntervalMs: int(env.BACKUP_INTERVAL_MS, 21_600_000, 60_000, 604_800_000),
    backupRetention: int(env.BACKUP_RETENTION, 14, 1, 365),
    backupKey: material.backupKey,
  };
}
