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
            thresholds: {
              lines: 65,
              branches: 58,
              functions: 62,
              "shared/src/**": { lines: 84, branches: 78, functions: 90 },
              "cli/src/**": { lines: 90, branches: 85, functions: 78 },
              "controller/src/**": { lines: 67, branches: 57, functions: 65 },
              "api/src/**": { lines: 42, branches: 42, functions: 28 },
              "sdk/src/**": { lines: 35, branches: 26, functions: 37 },
            },
          }),
    },
  },
});
