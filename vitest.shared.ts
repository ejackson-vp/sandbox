/**
 * Configuration both vitest runs share.
 *
 * Two files use this: `vitest.config.ts` for the suites that need Postgres, and
 * `vitest.security.config.ts` for the cluster-backed isolation suite. The
 * plugin and the alias have to be identical or a test in one run resolves a
 * different module than the same test in the other, which is exactly the class
 * of difference that produced the coverage blind spot this repo just fixed.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Vite does not rewrite TypeScript's `./foo.js` specifiers to `./foo.ts`.
 * This tiny plugin does, so tests can import source files directly.
 */
export const tsSpecifierPlugin = {
  name: "ts-specifier",
  enforce: "pre" as const,
  resolveId(source: string, importer?: string) {
    if (!importer) return null;
    if (!source.startsWith(".") || !source.endsWith(".js")) return null;
    const candidate = resolve(dirname(importer), source.replace(/\.js$/, ".ts"));
    return existsSync(candidate) ? candidate : null;
  },
};

const root = resolve(import.meta.dirname);

export const resolveConfig = {
  // `@x402s/shared/<entry>` is a package export, so it resolves to
  // `shared/dist`, and the coverage report scored the `shared/src` file those
  // property tests actually exercise as untested. The durable-call protocol
  // (shared/src/durable, 100 lines) is covered by
  // tests/property/durable-external.test.ts and read 0%.
  //
  // Pointing the specifier at the source entry instead makes the report measure
  // the file the test drives. `sdk` is deliberately not aliased: cli-args.test.ts
  // imports the built package on purpose, because the CLI resolves @x402s/sdk to
  // sdk/dist and an instanceof check needs the same class identity the shipped
  // build has.
  alias: [
    { find: /^@x402s\/shared$/, replacement: resolve(root, "shared/src/index.ts") },
    { find: /^@x402s\/shared\/(.+)$/, replacement: resolve(root, "shared/src/entries/$1.ts") },
  ],
};
