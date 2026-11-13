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
      // ~4 points under its current total.
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
            // code fails here instead of quietly lowering the total. Measured
            // at the security-first branch (unit + property): global 77.5,
            // shared 91.0, cli 95.3, controller 80.4, api 58.4, sdk 52.2.
            // Every module added by that branch is at or above 90% lines.
            thresholds: {
              lines: 75,
              branches: 68,
              functions: 72,
              "shared/src/**": { lines: 89, branches: 84, functions: 94 },
              "cli/src/**": { lines: 93, branches: 88, functions: 83 },
              "controller/src/**": { lines: 78, branches: 69, functions: 76 },
              "api/src/**": { lines: 56, branches: 58, functions: 42 },
              "sdk/src/**": { lines: 50, branches: 35, functions: 48 },
            },
          }),
    },
  },
});
