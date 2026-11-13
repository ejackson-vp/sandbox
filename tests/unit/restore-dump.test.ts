/**
 * The restore wrapper is the only thing that decides whether a backup artifact
 * is usable, and it runs outside CI against a database nobody wants to lose.
 * These tests pin the decisions it makes before it touches a server: argument
 * parsing, the scratch name, the encryption sniff, and the schema-version
 * branch. The restore itself is proved by running the script (docs/backup-restore.md).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../../controller/src/store/schema-version.js";
import {
  UsageError,
  buildSchemaVersion,
  databaseNameOf,
  dumpLooksEncrypted,
  main,
  parseArgs,
  schemaPlan,
  scratchDatabaseName,
} from "../../scripts/restore-dump.mjs";

describe("restore-dump", () => {
  it("takes one dump path and the documented options", () => {
    expect(parseArgs(["postgres.dump.enc"])).toEqual({
      dump: "postgres.dump.enc",
      keyEnv: "BACKUP_ENCRYPTION_KEY",
      databaseUrl: null,
      keep: false,
      help: false,
    });
    expect(
      parseArgs([
        "--database-url",
        "postgres://postgres:pg@127.0.0.1:5432/postgres",
        "--key-env",
        "OTHER_KEY",
        "--keep",
        "postgres.dump.enc",
      ]),
    ).toMatchObject({
      dump: "postgres.dump.enc",
      keyEnv: "OTHER_KEY",
      databaseUrl: "postgres://postgres:pg@127.0.0.1:5432/postgres",
      keep: true,
    });
  });

  it("refuses an unknown option, a missing value and a second path", () => {
    expect(() => parseArgs(["--key"])).toThrow(UsageError);
    expect(() => parseArgs(["--key-env"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--nope", "dump"])).toThrow(/unknown option --nope/);
    expect(() => parseArgs(["one", "two"])).toThrow(/expected one dump path/);
  });

  it("names the scratch database with a prefix and a shape that cannot collide", () => {
    const name = scratchDatabaseName(new Date("2026-11-12T03:23:00.000Z"), 4242, "deadbeef");
    expect(name).toBe("sbx_restore_20261112t032300_4242_deadbeef");
    expect(name.startsWith("sbx_restore_")).toBe(true);
    expect(name).toMatch(/^[a-z0-9_]+$/);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).not.toBe("sandbox");
    // Same second, another process or another random suffix: another name.
    expect(scratchDatabaseName(new Date("2026-11-12T03:23:00.000Z"), 4243, "deadbeef")).not.toBe(name);
  });

  it("recognises the openssl header, not a plain archive", () => {
    expect(dumpLooksEncrypted(Buffer.from("Salted__0123456"))).toBe(true);
    expect(dumpLooksEncrypted(Buffer.from("PGDMP\x01\x0e\x00"))).toBe(false);
    expect(dumpLooksEncrypted(Buffer.from("Salt"))).toBe(false);
    expect(dumpLooksEncrypted(Buffer.alloc(0))).toBe(false);
  });

  it("refuses a dump from a newer build and migrates forward on an older one", () => {
    expect(schemaPlan(19, 18)).toMatchObject({ action: "refuse" });
    expect(schemaPlan(19, 18).message).toMatch(/refuses to downgrade|would not start/);

    expect(schemaPlan(18, 18)).toMatchObject({ action: "current" });

    // The ladder is additive, so an older dump is migrated on the copy rather
    // than rejected; the message says the suite sees the migrated schema.
    const older = schemaPlan(16, 18);
    expect(older).toMatchObject({ action: "migrate" });
    expect(older.message).toMatch(/migrates it to v18/);

    expect(schemaPlan(null, 18)).toMatchObject({ action: "unversioned" });
    expect(schemaPlan(18, null)).toMatchObject({ action: "unknown" });
  });

  it("reads the schema version this checkout ships", () => {
    // A rename or a change of shape would otherwise make the script silent.
    expect(buildSchemaVersion()).toBe(SCHEMA_VERSION);
  });

  it("reads the database name out of the admin URL", () => {
    expect(databaseNameOf("postgres://postgres:pg@127.0.0.1:5432/sandbox")).toBe("sandbox");
    expect(databaseNameOf("postgres://postgres:pg@127.0.0.1:5432/")).toBe("postgres");
  });

  it("exits 2 before connecting when the dump or DATABASE_URL is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "restore-dump-"));
    const empty = join(dir, "empty.dump");
    writeFileSync(empty, "");

    await expect(main([], {})).resolves.toBe(2);
    await expect(main([join(dir, "absent.dump")], {})).resolves.toBe(2);
    // A readable file, but no admin connection to create a scratch database with.
    await expect(main([empty], {})).resolves.toBe(2);
  });
});
