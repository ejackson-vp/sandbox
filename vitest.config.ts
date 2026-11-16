import { defineConfig } from "vitest/config";
import { resolveConfig, tsSpecifierPlugin } from "./vitest.shared.js";

export default defineConfig({
  plugins: [tsSpecifierPlugin],
  resolve: resolveConfig,
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    fileParallelism: false,
    // Postgres is the only store now, so the suite refuses to start without it.
    // Setup fails with one clear message; teardown drops this run's databases.
    globalSetup: ["tests/helpers/test-global-setup.ts"],
    // Vitest 5 reads coverage from `test.coverage`; a top-level block is
    // ignored without a warning, which is how the badge job got default
    // reporters and no json-summary.
    coverage: {
      provider: "v8",
      // `json-summary` feeds the README badge; `lcov` is what a reviewer opens.
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      // Only shipped TypeScript counts. Tests, build output and the guest (Go)
      // are measured separately, so mixing them in would hide regressions.
      include: [
        "shared/src/**/*.ts",
        "sdk/src/**/*.ts",
        "api/src/**/*.ts",
        "controller/src/**/*.ts",
        "cli/src/**/*.ts",
      ],
      exclude: ["**/*.d.ts", "**/*.test.ts"],
      // Floors, not targets: a drop fails `npm run test:coverage` and names the
      // module that moved instead of shrinking a badge nobody watches. Each is
      // ~2 points under the number measured on the branch that set it.
      //
      // A partial run (the integration suite on its own) is merged with this one
      // before the badge is published, so its own total is below these floors
      // and must not be gated on them. `scripts/coverage-merge.mjs` owns the
      // merged floor instead.
      ...(process.env.X402_COVERAGE_PARTIAL === "1"
        ? { thresholds: { lines: 0, branches: 0, functions: 0 } }
        : {
            // Floors are a ratchet: each one sits a couple of points under the
            // measured number for that package, so a change that adds untested
            // code fails here instead of quietly lowering the total.
            //
            // Measured on this branch (unit + property, clean run after the F-21
            // and Kata-evidence work landed): global 84.7 lines / 77.2 branches
            // / 81.2 functions, shared 91.2 / 87.0 / 94.7, cli 95.3 / 90.5 /
            // 85.5, controller 81.2 / 72.7 / 79.1, api 88.7 / 82.8 / 76.1,
            // sdk 87.7 / 74.8 / 80.3. The api and sdk floors moved because their
            // two lowest packages were covered:
            // controller client, session admission, create-path replay and the
            // mock facilitator on the API side; runtime, data plane, session
            // lifecycle and directory transfers on the SDK side. The unit run
            // does not see `tests/integration` or `tests/transfers`, so
            // api/src/server.ts, api/src/main.ts and sdk/src/transfers.ts read
            // lower here than the merged badge does; the floors under api and
            // sdk are for this run, which is the one that gates a PR.
            thresholds: {
              lines: 82,
              branches: 74,
              functions: 79,
              "shared/src/**": { lines: 89, branches: 84, functions: 94 },
              "cli/src/**": { lines: 93, branches: 88, functions: 83 },
              "controller/src/**": { lines: 78, branches: 69, functions: 76 },
              "api/src/**": { lines: 86, branches: 81, functions: 73 },
              "sdk/src/**": { lines: 85, branches: 72, functions: 78 },
            },
          }),
    },
  },
});
