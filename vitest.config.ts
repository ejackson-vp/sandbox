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
  resolve: {
    // `@x402s/shared/<entry>` is a package export, so it resolves to
    // `shared/dist`, and the coverage report scored the `shared/src` file those
    // property tests actually exercise as untested. The durable-call protocol
    // (shared/src/durable, 100 lines) is covered by
    // tests/property/durable-external.test.ts and read 0%.
    //
    // Pointing the specifier at the source entry instead makes the report
    // measure the file the test drives. `sdk` is deliberately not aliased:
    // cli-args.test.ts imports the built package on purpose, because the CLI
    // resolves @x402s/sdk to sdk/dist and an instanceof check needs the same
    // class identity the shipped build has.
    alias: [
      { find: /^@x402s\/shared$/, replacement: resolve(import.meta.dirname, "shared/src/index.ts") },
      {
        find: /^@x402s\/shared\/(.+)$/,
        replacement: resolve(import.meta.dirname, "shared/src/entries/$1.ts"),
      },
    ],
  },
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
      // Floors, not targets. A drop fails `npm run test:coverage` instead of
      // only shrinking a number nobody watches, and a per-module floor names
      // the module that regressed rather than hiding it in a repo average.
      //
      // Each is ~4 points under its current total. They climb with the
      // coverage plan (see CONTRIBUTING.md): `sdk` and `api` are low because
      // their client and wiring code is only reached by the integration suite,
      // which is not in this run yet.
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
    },
  },
});
