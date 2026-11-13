/**
 * Mutation testing for the three modules where a surviving mutant is a bug
 * rather than a style opinion:
 *
 *   shared/src/payment.ts              pricing and x402 scheme validation
 *   controller/src/control-api/payments.ts  the internal money routes
 *   sdk/src/transfers.ts               client-side transfer orchestration
 *
 * Line coverage says those lines ran. A mutant that survives says the test ran
 * the line and asserted nothing about it, which is the only signal that finds a
 * missing assertion behind a green suite.
 *
 * Thresholds report, they do not gate. `break` is null on purpose for the first
 * landing: nobody has measured this repo yet, so the first run is the baseline.
 * Setting `break` now would either fail every pull request (if the score is low)
 * or claim a guarantee the suite does not have (if it is set just under today's
 * number). Watch the trend in the nightly artifact first, then set `break` to
 * `low`, which is the number that means "the suite stopped asserting".
 *
 * It is a `.mjs` file rather than JSON so this reasoning lives next to the
 * values it explains.
 */
export default {
  $schema: "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  packageManager: "npm",
  testRunner: "vitest",

  // The vitest runner forks vitest, which reads the repo config, so the
  // `@x402s/shared` source alias and the Postgres global setup apply here too.
  vitest: {
    configFile: "vitest.config.ts",
    // Same pool as vitest.config.ts. The runner defaults to `threads`; this
    // repo uses `forks` because the global setup and the store talk to Postgres
    // from a child process.
    pool: "forks",
  },

  mutate: [
    "shared/src/payment.ts",
    "controller/src/control-api/payments.ts",
    "sdk/src/transfers.ts",
  ],

  // Unit, fuzz and the portable transfer contract only. Integration
  // (tests/integration, tests/security) needs a guest binary or a live kind
  // cluster, so re-running it per mutant would be minutes per mutation and is
  // deliberately out of scope. These three directories are ~10 s in total and
  // their files import the mutated modules directly, which is what per-test
  // coverage needs to map a mutant to the tests that reach it.
  testFiles: ["tests/unit/**/*.test.ts", "tests/fuzz/**/*.test.ts", "tests/transfers/**/*.test.ts"],

  // perTest is the vitest runner's only coverage mode: the dry run records
  // which test covered which line, then a mutant run executes just those tests
  // instead of all ~1100. Without it every mutant would pay for the full suite.
  coverageAnalysis: "perTest",

  // Four workers. Each one is a forked vitest process with its own Postgres
  // connections, so this is deliberately not `os.cpus().length`: on a 2-core CI
  // runner that would thrash the database rather than finish sooner. Override
  // for a bigger box with STRYKER_CONCURRENCY.
  concurrency: Number(process.env.STRYKER_CONCURRENCY ?? 4),

  // A killed mutant normally reports in a second; the ceiling catches a hung
  // test rather than silently stalling the nightly. The dry run starts the
  // whole unit suite, so it gets a larger allowance.
  timeoutMS: 60_000,
  timeoutFactor: 2.5,
  dryRunTimeoutMinutes: 15,

  // Static mutants (module-level constants, e.g. the mock scheme's asset and
  // decimals) are re-run against every test by definition, so they are the slow
  // ones. They still matter here: a wrong MOCK_ASSET_DECIMALS or PAYMENT_VERSION
  // is a real interoperability bug. Leave them in.
  ignoreStatic: false,

  reporters: ["clear-text", "progress", "html", "json"],

  htmlReporter: {
    fileName: "reports/mutation/index.html",
  },
  jsonReporter: {
    fileName: "reports/mutation/mutation.json",
  },
  clearTextReporter: {
    // Print a line per file even when everything was killed, so a green run
    // still shows the score it is green at.
    allowEmpty: true,
    maxTestsToLog: 3,
  },

  tempDirName: ".stryker-tmp",

  // Report, do not fail. See the header.
  thresholds: {
    high: 80,
    low: 60,
    break: null,
  },
};
