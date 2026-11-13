/**
 * The store contract, against a database restored from a backup artifact.
 *
 * `scripts/restore-dump.mjs` restores a dump into a scratch database it
 * creates, then runs this file with `SBX_RESTORE_DATABASE_URL`. Running
 * `npm run test:store-contract` with `DATABASE_URL` pointed at a restored
 * database does not do this: the harness derives a new `sbx_test_…` database
 * from that URL, so the contract never reaches the restored copy.
 *
 * The suite truncates every table before each test. That is why the database
 * name has to carry the `sbx_restore_` prefix the script writes: this file
 * must never be able to point at a primary by accident.
 */
import { postgresBackend } from "../unit/store-contract/fixtures.js";
import { describeStoreContract } from "../unit/store-contract/suite.js";

const url = process.env.SBX_RESTORE_DATABASE_URL?.trim();

if (!url) {
  throw new Error(
    "SBX_RESTORE_DATABASE_URL is not set. Restore an artifact with " +
      "`node scripts/restore-dump.mjs <dump>`, which creates the scratch copy and runs this suite against it.",
  );
}

const database = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ""));
const allowAnyDatabase = process.env.SBX_RESTORE_ALLOW_ANY_DB === "1";

if (!database.startsWith("sbx_restore_") && !allowAnyDatabase) {
  throw new Error(
    `refusing to run the store contract against '${database}': the suite truncates every table. ` +
      "Use the scratch database scripts/restore-dump.mjs creates, or set SBX_RESTORE_ALLOW_ANY_DB=1 " +
      "on a throwaway recovery instance you are willing to empty.",
  );
}

describeStoreContract(postgresBackend(url));
