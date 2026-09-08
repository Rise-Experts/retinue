#!/usr/bin/env node
/**
 * Every specifier the built code reaches resolves in *this* `node_modules` -- REQ-041 (#190).
 *
 * The second half of the check `collect-runtime-imports.mjs` starts. That one runs in the image's
 * build stage, where TypeScript is installed; this one runs in the **runtime** stage, where it is not
 * -- and that is the whole point. The runtime stage installs production dependencies only, so it is
 * the only place that can answer "will this image be able to load the code it is about to run".
 *
 * **The failure it exists for.** The runtime declares `pg`, `ioredis`, `bullmq`, `graphql-yoga`,
 * `@whatwg-node/server` and six `@ai-sdk/*` providers as *optional* peers. Optional means npm installs
 * them only if something asks, and in the monorepo nothing has to: the root install hoists every
 * workspace's dependencies, so an app that imports `pg` without declaring it works locally and forever
 * -- until an image installs a subset. Both Dockerfiles claimed their `npm ci --omit=dev` caught that.
 * It does not: with `pg` deleted from `shareflow/package.json` the rebuilt image still resolved it,
 * because `bullmq` depends on `pg`. A guarantee that holds only while an unrelated package keeps a
 * dependency is not a guarantee, so this is where it lives now.
 *
 * Deliberately zero dependencies -- not even `typescript`. Anything it imported would have to be
 * installed in the runtime stage, which would make the check part of what it is checking.
 *
 * Usage: `node scripts/check-runtime-imports.mjs <imports.json>`
 * Exit codes: 0 everything resolves, 1 something does not, 2 the check could not run.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve as resolvePath } from "node:path";

/**
 * Resolution is attempted from the working directory, which is the app root in both images.
 *
 * `createRequire` rather than `import.meta.resolve`: the latter resolves relative to *this file*, and
 * this file may be copied anywhere in the image. A wrong base silently answers a different question --
 * "what could the script itself load" instead of "what can the app load" -- and would pass an image
 * whose app directory has none of it.
 */
export const resolverFrom = (cwd) => {
  const require = createRequire(resolvePath(cwd, "noop.js"));
  return (specifier) => {
    try {
      require.resolve(specifier);
      return null;
    } catch (error) {
      return error.code ?? error.message.split("\n")[0];
    }
  };
};

export const verify = (manifest, resolver) => {
  const failures = [];
  for (const specifier of manifest.specifiers) {
    const failure = resolver(specifier);
    if (failure !== null) failures.push({ specifier, failure, importer: manifest.firstImporter?.[specifier] });
  }
  return failures;
};

const main = () => {
  const path = process.argv[2];
  if (path === undefined) {
    console.error("check-runtime-imports: name the JSON file collect-runtime-imports.mjs wrote");
    process.exit(2);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`check-runtime-imports: cannot read ${path}: ${error.message}`);
    process.exit(2);
  }

  // A file with no specifiers must never pass. It is what a failed collection looks like, and passing
  // it would turn the whole check into decoration at exactly the moment it stopped working.
  if (!Array.isArray(manifest.specifiers) || manifest.specifiers.length === 0) {
    console.error(`check-runtime-imports: ${path} lists no specifiers -- the collection step failed`);
    process.exit(2);
  }

  const failures = verify(manifest, resolverFrom(process.cwd()));
  if (failures.length > 0) {
    for (const { specifier, failure, importer } of failures) {
      console.error(`check-runtime-imports: "${specifier}" does not resolve (${failure})`);
      if (importer !== undefined) console.error(`  imported by ${importer}`);
      console.error(`  Declare it in the application's package.json -- the runtime declares it as an optional peer,`);
      console.error(`  so nothing else will install it, and this image would fail when that code path runs.`);
    }
    process.exit(1);
  }

  console.log(
    `check-runtime-imports: ${manifest.specifiers.length} specifiers from ${manifest.files} built files -- all resolvable`,
  );
};

if (import.meta.url.endsWith(process.argv[1]?.split("/").pop() ?? " ")) main();
