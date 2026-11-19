/**
 * Bundle the server into one file.
 *
 * The workspace packages (`@x402s/sdk`, `@x402s/shared`) are private and never
 * published, so a tarball that depended on them would install and then fail at
 * its first import. Bundling them in leaves only the two packages that really
 * are on npm: the MCP SDK and zod.
 *
 * They stay external rather than bundled because the MCP SDK resolves its
 * transport and schema helpers at runtime, and a bundle that inlines those is a
 * bundle that breaks when a client loads it from a different working directory.
 *
 * The shebang comes from `src/index.ts`, which esbuild carries into the bundle;
 * adding one here as well produced a file with two and Node refused to parse it.
 */
import { rmSync } from "node:fs";
import { build } from "esbuild";

// Start from empty: a tsc run leaves per-module `.js` and `.d.ts` files behind,
// and npm would publish them next to the bundle.
rmSync("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/*", "zod"],
  sourcemap: false,
  logLevel: "warning",
});
