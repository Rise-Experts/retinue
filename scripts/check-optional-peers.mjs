#!/usr/bin/env node
/**
 * An application declares every optional peer its deployment needs -- REQ-041 (#190).
 *
 * There are two different guarantees here, and conflating them is what produced two false claims in
 * two Dockerfiles:
 *
 *  1. **The image can load the code it runs.** Every specifier the built graph reaches resolves in the
 *     production install. That is a *resolution* question, it is answered inside the image, and
 *     `check-runtime-imports.mjs` answers it there.
 *  2. **Nothing is installed by luck.** The runtime declares `pg`, `ioredis`, `bullmq`, `graphql-yoga`,
 *     `@whatwg-node/server` and six `@ai-sdk/*` providers as *optional* peers -- optional meaning npm
 *     installs them only if something asks. The application is what has to ask. This is a *manifest*
 *     question, and no amount of resolving answers it.
 *
 * The distinction is not academic. `pg` was deleted from `shareflow/package.json` and the image still
 * built, still resolved `pg`, and still passed check (1) -- because `bullmq` depends on `pg` and
 * brought it along. Everything worked, on a dependency nobody had asked for, in a package that could
 * drop it in any minor release. This check is (2), and it is the one that fails on that.
 *
 * **Both halves are derived.** The peers come from the workspace manifests; the reached set comes from
 * walking the compiled graph; and the entry points come from parsing each app's own Dockerfile, so an
 * image that changes what it runs changes what is checked. Nothing here is a list to keep in step --
 * the previous attempt was a probe with fourteen specifiers typed into it, which is a test whose
 * expectation is the same hand-maintained list it checks.
 *
 * Exit codes: 0 clean, 1 an undeclared optional peer, 2 the check could not run.
 */

import { readdirSync, readFileSync } from "node:fs";

import { collect } from "./collect-runtime-imports.mjs";

/** The images this repo ships, each with the application whose manifest is answerable for it. */
export const IMAGES = [
  { dockerfile: "Dockerfile", app: "examples" },
  { dockerfile: "Dockerfile.shareflow", app: "shareflow" },
];

/**
 * What an image actually runs, read out of the Dockerfile.
 *
 * Two entry points, and both matter: `CMD` is the process, and `RETINUE_APP_MODULE` is the module that
 * process loads to get its wiring. Checking only the first misses everything the application imports;
 * checking only the second misses the host's own Postgres and Redis clients.
 */
export const entryPointsOf = (dockerfile) => {
  const appModule = /^ENV RETINUE_APP_MODULE=(\S+)/m.exec(dockerfile)?.[1];
  const cmd = /^CMD \[([^\]]+)\]/m.exec(dockerfile)?.[1];
  const out = [];
  if (appModule !== undefined) out.push(appModule.replace(/^file:\/\/\/app\//, ""));
  if (cmd !== undefined) {
    const argv = cmd.split(",").map((part) => part.trim().replace(/^"|"$/g, ""));
    // The script, not the interpreter: `["node", "backend/dist/server/cli.js"]`.
    const script = argv.find((part) => part.endsWith(".js") || part.endsWith(".mjs"));
    if (script !== undefined) out.push(script);
  }
  return out;
};

/** Optional peer dependencies declared by any workspace, as `package -> the workspaces that peer it`. */
export const optionalPeers = (workspaceDirs, readJson) => {
  const out = new Map();
  for (const dir of workspaceDirs) {
    const manifest = readJson(`${dir}/package.json`);
    if (manifest === null) continue;
    for (const [name, meta] of Object.entries(manifest.peerDependenciesMeta ?? {})) {
      if (meta?.optional !== true) continue;
      const owners = out.get(name) ?? new Set();
      owners.add(manifest.name ?? dir);
      out.set(name, owners);
    }
  }
  return out;
};

/** `@scope/name/sub` -> `@scope/name`; `name/sub` -> `name`. */
export const packageOf = (specifier) =>
  specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];

export const findUndeclared = (image, io) => {
  const dockerfile = io.readText(image.dockerfile);
  if (dockerfile === null) return { error: `${image.dockerfile} is unreadable` };

  const entries = entryPointsOf(dockerfile);
  if (entries.length === 0) {
    // Never "nothing to check": a Dockerfile whose CMD this cannot read is a Dockerfile whose image
    // is unchecked, and reporting success would be the wrong answer to the wrong question.
    return { error: `${image.dockerfile} names no entry point this check can read (CMD / RETINUE_APP_MODULE)` };
  }

  const manifest = io.readJson(`${image.app}/package.json`);
  if (manifest === null) return { error: `${image.app}/package.json is unreadable` };
  const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);

  let reached;
  try {
    reached = collect(entries, io);
  } catch (error) {
    return { error: `walking ${entries.join(", ")} failed: ${error.message}` };
  }

  const peers = optionalPeers(io.workspaceDirs(), io.readJson);
  const offences = [];
  for (const specifier of reached.specifiers.keys()) {
    const pkg = packageOf(specifier);
    if (declared.has(pkg)) continue;
    const owners = peers.get(pkg);
    if (owners === undefined) continue;
    offences.push({ pkg, owners: [...owners], importer: [...reached.specifiers.get(specifier)][0] });
  }
  return { offences, entries, files: reached.files };
};

const main = () => {
  const readJson = (path) => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  };
  const io = {
    readJson,
    readText: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    workspaceDirs: () => {
      const root = readJson("package.json");
      return (root?.workspaces ?? []).flatMap((pattern) =>
        pattern.endsWith("/*")
          ? readdirSync(pattern.slice(0, -2)).map((name) => `${pattern.slice(0, -2)}/${name}`)
          : [pattern],
      );
    },
  };

  let failed = false;
  for (const image of IMAGES) {
    const result = findUndeclared(image, io);
    if (result.error !== undefined) {
      console.error(`optional peers: ${result.error}`);
      process.exit(2);
    }
    for (const { pkg, owners, importer } of result.offences) {
      failed = true;
      console.error(`${image.app}/package.json does not declare "${pkg}", an optional peer of ${owners.join(", ")}.`);
      console.error(`  Reached from ${importer} via ${image.dockerfile}'s entry points.`);
      console.error(`  Optional means npm installs it only if something asks. It resolves today because a`);
      console.error(`  transitive dependency happens to bring it; the day that changes, ${image.app} breaks in`);
      console.error(`  production with no local signal. Declare it.`);
    }
    if (!failed) console.log(`optional peers: ${image.app} declares every peer reached from ${result.entries.join(" + ")}`);
  }

  if (failed) process.exit(1);
};

if (import.meta.url.endsWith(process.argv[1]?.split("/").pop() ?? " ")) main();
