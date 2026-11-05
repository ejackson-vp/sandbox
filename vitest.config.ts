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
  },
});
