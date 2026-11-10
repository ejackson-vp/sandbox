/**
 * Parsing for the backup encryption key.
 *
 * The key is deliberately separate from the other control-plane secrets: losing
 * it makes existing backups unreadable, and rotating it requires re-encrypting
 * or retaining the old key. Accept 32 raw bytes as base64 or 64 hex chars.
 */
export function parseBackupKey(raw: string): Buffer {
  const value = raw.trim();
  if (value.length === 0) {
    throw new Error("BACKUP_ENCRYPTION_KEY is empty");
  }
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, "hex");
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error(
      "BACKUP_ENCRYPTION_KEY must be 32 bytes encoded as base64 or 64 hex characters",
    );
  }
  return key;
}
