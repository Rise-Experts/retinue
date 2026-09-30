/**
 * Copies `docs/` into the package, so an installed agentkit can serve its own documentation — #291.
 *
 * ## Why a copy at all
 *
 * npm publishes a directory. `docs/` is a **sibling** of `backend/`, not a child, and `files` cannot reach
 * outside the package root — so the choice is to copy the documentation in at pack time or to ship a
 * documentation server with no documentation.
 *
 * ## Why into `dist/`
 *
 * The obvious destination is `backend/docs/`, and it is wrong in a way worth writing down. Two checks in this
 * repository walk the tree for markdown — `check-terminology.mjs` and `check-doc-imports.mjs` — and neither
 * skips a directory called `docs`. A copy there means every document is scanned **twice**: the terminology
 * count silently doubles, and a stale copy left by an interrupted pack keeps doing it until someone deletes a
 * directory they do not remember creating.
 *
 * `dist/` is already in those checks' `SKIP_DIRS`, already in `.gitignore`, and already removed by `clean`. A
 * copy is a build artifact, so putting it where the build artifacts live is what it was all along — and every
 * question about stale copies and cleanup answers itself.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, "..", "docs");
const TARGET = resolve(HERE, "..", "backend", "dist", "docs");

/** Markdown only. A docs root holding a stray binary should not put it in a published tarball. */
const isDoc = (name) => /\.mdx?$/i.test(name);

const count = (dir) => {
  let n = 0;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) n += count(path);
    else if (isDoc(entry)) n += 1;
  }
  return n;
};

if (!existsSync(SOURCE)) {
  // A publish that silently shipped no documentation would look exactly like a successful one.
  console.error(`✗ no documentation at ${relative(process.cwd(), SOURCE)} — nothing to copy, and the package would ship a documentation server with no documentation.`);
  process.exit(1);
}

// Removed first, so a document deleted upstream cannot survive in the tarball as a file nothing updates.
rmSync(TARGET, { recursive: true, force: true });
mkdirSync(TARGET, { recursive: true });
cpSync(SOURCE, TARGET, { recursive: true, filter: (from) => statSync(from).isDirectory() || isDoc(from) });

const copied = count(TARGET);
if (copied === 0) {
  console.error("✗ copied no documents. The filter matched nothing, which is a bug here, not an empty corpus.");
  process.exit(1);
}
// stderr, not stdout: this runs as `prepack`, and `npm pack --json` parses stdout. A success line there is
// invalid JSON, which breaks exactly the tooling that would verify this script's own work.
console.error(`✓ ${copied} document(s) copied into ${relative(process.cwd(), TARGET)}`);
