/**
 * Pruning the databases of runs that were killed before their teardown.
 *
 * The database name is the contract: sbx_test_<namespace>_<run-id>_<pid>_<random>.
 * The pid decides whether a database may be dropped, so the test crafts two
 * names against the real Postgres, one whose pid has exited and one carrying
 * this worker's live pid, and asserts the prune drops exactly the dead one.
 */
import { spawnSync } from "node:child_process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  pruneOrphanTestDatabases,
  runId,
  testDatabasePid,
} from "../helpers/test-store.js";

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** A pid that has already exited, so `kill(pid, 0)` cannot find it. */
function deadPid(): number {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    if (child.pid && !isRunning(child.pid)) return child.pid;
  }
  throw new Error("could not produce a dead pid to name a database with");
}

describe("test database pruning", () => {
  const url = process.env.DATABASE_URL ?? "";
  let admin: pg.Client;
  let deadDatabase = "";
  let liveDatabase = "";

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    // The run id is this run's, so a database left behind here is cleaned by
    // this run's teardown as well as by the prune.
    deadDatabase = `sbx_test_unit_${runId()}_${deadPid()}_deadbeef`;
    liveDatabase = `sbx_test_unit_${runId()}_${process.pid}_feedface`;
    for (const name of [deadDatabase, liveDatabase]) {
      await admin.query(`CREATE DATABASE "${name}"`);
    }
  });

  afterAll(async () => {
    for (const name of [deadDatabase, liveDatabase]) {
      if (!name) continue;
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
    }
    await admin.end().catch(() => undefined);
  });

  it("drops a dead-pid database and leaves a live-pid one alone", async () => {
    const dropped = await pruneOrphanTestDatabases(() => undefined);

    expect(dropped).toContain(deadDatabase);
    expect(dropped).not.toContain(liveDatabase);

    const left = await admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname = ANY($1) ORDER BY datname",
      [[deadDatabase, liveDatabase]],
    );
    expect(left.rows.map((row) => row.datname)).toEqual([liveDatabase]);
  });

  it("does not read a pid out of a name that is not one of ours", () => {
    // Leaving these alone is the safe answer: a guessed pid could belong to a
    // live run.
    expect(testDatabasePid("sandbox")).toBeNull();
    expect(testDatabasePid("sbx_test_unit_1234_deadbeef")).toBeNull();
    expect(testDatabasePid("sbx_test_unit_notanumber_123_abcd")).toBeNull();
    expect(testDatabasePid("sbx_test_unit_1234_0_abcd")).toBeNull();
    // The namespace may contain underscores, so the pid is read from the end.
    expect(testDatabasePid("sbx_test_unit_1234_5678_abcd")).toBe(5678);
    expect(testDatabasePid("sbx_test_integration_leadership_12_34_abcd")).toBe(34);
  });
});
