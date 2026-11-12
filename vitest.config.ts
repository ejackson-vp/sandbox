import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Vite does not rewrite TypeScript's `./foo.js` specifiers to `./foo.ts`.
 * This tiny plugin does, so tests can import source files directly.
 */
const tsSpecifierPlugin = {
  name: "ts-specifier",
  enforce: "pre" as const,
  resolveId(source: string, importer?: string) {
    if (!importer) return null;
    if (!source.startsWith(".") || !source.endsWith(".js")) return null;
    const candidate = resolve(dirname(importer), source.replace(/\.js$/, ".ts"));
    return existsSync(candidate) ? candidate : null;
  },
};

export default defineConfig({
  plugins: [tsSpecifierPlugin],
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
      // A floor under the badge, so a drop fails the build instead of only
      // shrinking a number nobody watches. Set ~4 points below the current
      // totals (59.4 / 52.6 / 53.2) to leave room for normal movement.
      thresholds: {
        lines: 55,
        branches: 45,
        functions: 45,
      },
    },
  },
});
