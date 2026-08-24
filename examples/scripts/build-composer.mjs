/**
 * Bundles the composer into `public/composer.js` — #179.
 *
 * The page is served as a file, so the browser gets one script and no import map. It is written to `public/` and
 * **not committed**: a checked-in bundle drifts from its source silently, and the source is right here.
 *
 * `--watch` for development. Nothing else builds this, so a stale bundle would otherwise survive an edit.
 */

import { build, context } from "esbuild";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const options = {
  entryPoints: [resolve(root, "dist/composer/index.js")],
  bundle: true,
  // An IIFE with a `globalName`, which is esbuild's own mechanism for "expose the exports as a global".
  format: "iife",
  globalName: "AgentkitComposer",
  target: "es2022",
  minify: true,
  sourcemap: true,
  outfile: resolve(root, "public/composer.js"),
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("composer: watching");
} else {
  const result = await build(options);
  if (result.errors.length > 0) process.exit(1);
}
