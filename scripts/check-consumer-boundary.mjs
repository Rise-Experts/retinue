#!/usr/bin/env node
/**
 * The boundary, as a consumer actually meets it — REQ-042 (#191), SPEC #195, AC-1.
 *
 * "The platform consumes the runtime as a published dependency, and the boundary is verified by a build that
 * fails on a deep import."
 *
 * ## Why this is not the same check as `check-boundaries.mjs`
 *
 * `check-boundaries.mjs` reads this repository's source and enforces which layer may import which. It cannot
 * see the thing #195 is actually worried about, because the risk is not inside this tree — it is a *different
 * codebase* reaching past the `exports` map into `dist/`. Nothing in this workspace's rules applies over there.
 *
 * And the `exports` map is the whole argument. #195 recommends the platform live in a separate repository and
 * consume the published package, on the reasoning that a boundary is real only when crossing it is impossible
 * rather than discouraged. That reasoning is worth exactly as much as the enforcement behind it, and until now
 * nothing had ever tried a deep import and watched it fail. An `exports` map is easy to believe in and easy to
 * get wrong: one `"./*": "./dist/*"` fallback, added to unblock somebody, and every internal module is public
 * API forever, with no error anywhere to say so.
 *
 * ## Why it packs a tarball instead of importing from the workspace
 *
 * A workspace consumer resolves through a symlink into `backend/`, where `src/` exists, the whole tree is
 * readable, and `dist/` is whatever was last built. That is not what a consumer gets. `npm pack` produces the
 * actual artifact — `files` globs applied, nothing else present — and the checks below run against *that*, which
 * is why they can also catch an entry point the globs silently dropped. An `exports` map pointing at a file the
 * tarball does not contain is the failure mode where every test in this repository passes and the package is
 * broken for everyone who installs it.
 *
 * ## Why both shipping packages, and not only the runtime
 *
 * It checked `@retinue/agentkit` alone at first, and `@retinue/react` was found — by hand, while adding a
 * licence — to be shipping 32 sourcemaps whose `sources` pointed at `../src/*.ts` files the tarball did not
 * contain. Strictly worse than shipping no maps: a consumer's debugger tries to load them and appears broken.
 * A check that covers one of two published packages reads, in a green pipeline, as covering both.
 *
 * ## What is asserted, per package
 *
 * 1. Every subpath in `exports` resolves and loads from the extracted tarball. Loads, not "the file exists":
 *    an entry whose transitive imports are missing throws at import and would ship.
 * 2. Every subpath typechecks from a consumer whose only knowledge of the package is `node_modules`.
 * 3. A deep import fails, **and fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`** — the boundary refusing it, not the
 *    file happening to be absent. Those two are indistinguishable in a red exit code and only one is the
 *    guarantee.
 * 4. A deep import fails to *typecheck*, which is the form the platform's build would actually hit.
 * 5. The tarball contains no `src/` and no sourcemaps, because a consumer who can read the sources will read
 *    them, and then the internals are the API in practice whatever the map says.
 * 6. The tarball contains `LICENSE`, `README.md` and `package.json`. npm includes those three whatever `files`
 *    says, so this is a check on npm's behaviour rather than ours — which is the point: the licence is what
 *    makes the package usable at all, and a manifest claiming `Apache-2.0` over a tarball with no licence text
 *    fails somebody's compliance review rather than ours.
 *
 * ## Offline by construction
 *
 * The consumer's third-party dependencies are symlinked from this workspace rather than installed. `npm install`
 * in a temporary directory would need the network, and a gate that fails when the registry is slow is a gate
 * people learn to skip. The symlinks are also honest: they are the same package versions the tarball declares.
 *
 * Usage: node scripts/check-consumer-boundary.mjs [--keep]
 * Exit codes: 0 the boundary holds, 1 it does not, 2 the check could not run.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * Every package that ships, with the deep imports each must refuse.
 *
 * The deep list per package is chosen for ways somebody would actually reach. `dist/index.js` is the honest
 * shortcut — the file is right there and it works in the workspace. `src/…` is what an editor's auto-import
 * offers while two repositories sit in one checkout. `internal` is the name a codebase gives a private entry
 * once someone has asked for one. `adapters` is the half-path: a real subpath is `./adapters/postgres`, and the
 * parent must not resolve to anything. `@retinue/react/hooks` is the same shape — plausible, and not a subpath.
 */
export const PACKAGES = [
  {
    name: "@retinue/agentkit",
    dir: "backend",
    deep: [
      "dist/index.js",
      "dist/tools/library/http.js",
      // An adapter internal specifically, because #192's test steps name one: the SQL a Postgres adapter emits
      // is explicitly not API (`docs/19-versioning.md`), and that only holds if the module cannot be reached.
      "dist/adapters/postgres/flows.js",
      "dist/entries/flows.js",
      "src/index.ts",
      "src/runtime/worker.ts",
      "internal",
      "adapters",
    ],
  },
  {
    name: "@retinue/react",
    dir: "frontend",
    deep: ["dist/index.js", "dist/hooks/hooks.js", "src/client.ts", "hooks", "ui"],
  },
];

/** What npm ships whatever `files` says, and what a published package is unusable without. */
export const REQUIRED_ENTRIES = ["LICENSE", "README.md", "package.json"];

/** The subpaths a consumer is allowed, read from the manifest rather than listed twice. */
export const exportedSubpaths = (manifest, packageName) => {
  const map = manifest.exports;
  // A package with no `exports` map has exactly one entry point, and no boundary at all — which is a finding,
  // not a shape to paper over. Reported by the caller; here it is simply the root.
  if (!map) return [packageName];
  return Object.keys(map)
    // `./package.json` is exported on purpose — tooling reads it — but it is not a module to import.
    .filter((subpath) => subpath !== "./package.json")
    .map((subpath) => (subpath === "." ? packageName : `${packageName}/${subpath.replace(/^\.\//, "")}`));
};

/**
 * What a tarball may contain.
 *
 * Anything else is reported rather than ignored, because the interesting failures here are additions: a `src/`
 * that reappears when someone widens a glob, a `.map` that points at source the tarball does not carry.
 */
export const forbiddenTarballEntries = (paths) =>
  paths
    .map((path) => path.replace(/^package\//, ""))
    .filter((path) => path.length > 0)
    .filter((path) => path.startsWith("src/") || path.endsWith(".map"));

/** Which of the three files every published package needs are absent. */
export const missingTarballEntries = (paths) => {
  const present = new Set(paths.map((path) => path.replace(/^package\//, "")));
  return REQUIRED_ENTRIES.filter((entry) => !present.has(entry));
};

/**
 * Whether a deep import was stopped *by the boundary*.
 *
 * The distinction this makes is the point of the whole file. `ERR_MODULE_NOT_FOUND` means the specifier resolved
 * as far as a path and the path was empty — which is what would happen if the `exports` map were deleted and the
 * tarball merely happened not to contain that file. Accepting it would mean this check keeps passing after the
 * guarantee is gone.
 */
export const blockedByExports = (outcome) => outcome.code === "ERR_PACKAGE_PATH_NOT_EXPORTED";

const die = (message) => {
  console.error(`✗ ${message}`);
  process.exit(2);
};

const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });

/**
 * Everything below runs only when this file is the entry point.
 *
 * Not tidiness — the unit tests import the judgements above, and without this guard that import *ran the whole
 * check*, which then called `process.exit(0)` and ended the test process before a single assertion had been
 * evaluated. The run was green and had tested nothing. Exactly the defect this repository keeps finding, this
 * time inside the check written to find it.
 */
const main = () => {
  const work = mkdtempSync(join(tmpdir(), "retinue-consumer-"));
  const keep = process.argv.includes("--keep");

  let ok = true;
  const fail = (message, detail) => {
    console.error(`✗ ${message}`);
    if (detail) console.error(detail.replace(/^/gm, "    "));
    ok = false;
  };

  try {
    // ── one consumer, both packages: a directory whose only knowledge of them is `node_modules` ───────────────
    const consumer = join(work, "consumer");
    const modules = join(consumer, "node_modules");
    mkdirSync(join(modules, "@retinue"), { recursive: true });

    // Everything except `@retinue`: the workspace's own links would put `backend/src` back within reach and undo
    // the only thing being tested here.
    for (const entry of readdirSync(join(ROOT, "node_modules"))) {
      if (entry === "@retinue") continue;
      symlinkSync(join(ROOT, "node_modules", entry), join(modules, entry));
    }
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ name: "boundary-consumer", private: true, type: "module", version: "0.0.0" }, null, 2),
    );

    const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
    if (!existsSync(tsc)) die("typescript is not installed in this workspace, so the build half cannot be checked");

    const typecheck = (name, source) => {
      writeFileSync(join(consumer, `${name}.ts`), source);
      writeFileSync(
        join(consumer, `${name}.tsconfig.json`),
        JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              lib: ["ES2022", "DOM"],
              module: "NodeNext",
              moduleResolution: "NodeNext",
              jsx: "react-jsx",
              strict: true,
              skipLibCheck: true,
              noEmit: true,
              types: [],
            },
            files: [`${name}.ts`],
          },
          null,
          2,
        ),
      );
      try {
        run(process.execPath, [tsc, "-p", join(consumer, `${name}.tsconfig.json`)], { cwd: consumer });
        return { ok: true, output: "" };
      } catch (error) {
        return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
      }
    };

    const summaries = [];

    for (const shipped of PACKAGES) {
      const packageDir = join(ROOT, shipped.dir);
      if (!existsSync(join(packageDir, "dist"))) {
        die(`${shipped.dir}/dist is not built — run \`npm run build\`; this check is about the shipped artifact`);
      }

      const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
      const subpaths = exportedSubpaths(manifest, shipped.name);
      if (!manifest.exports) {
        fail(
          `${shipped.name} has no \`exports\` map, so every internal module is reachable`,
          "there is no boundary to check: a consumer can import any path in the tarball, and each one becomes\n" +
            "public API that a refactor breaks without anybody calling it a breaking change",
        );
      }
      const deepImports = shipped.deep.map((path) => `${shipped.name}/${path}`);

      let packed;
      try {
        const output = run("npm", ["pack", "-w", shipped.name, "--pack-destination", work, "--json"], { cwd: ROOT });
        packed = join(work, JSON.parse(output)[0].filename);
      } catch (error) {
        die(`npm pack ${shipped.name} failed: ${error.stderr || error.message}`);
      }

      const entries = run("tar", ["-tzf", packed]).trim().split("\n");
      const forbidden = forbiddenTarballEntries(entries);
      if (forbidden.length > 0) {
        fail(
          `${shipped.name} ships ${forbidden.length} file(s) it should not: ${forbidden.slice(0, 5).join(", ")}`,
          "sources make the internals readable, and readable internals become the API whichever subpaths the\n" +
            "exports map declares. A sourcemap whose sources are absent is worse than no sourcemap: the\n" +
            "consumer's debugger tries to load them and looks broken",
        );
      }
      const missing = missingTarballEntries(entries);
      if (missing.length > 0) {
        fail(
          `${shipped.name} ships no ${missing.join(", ")}`,
          "npm includes those whatever `files` says, so their absence means something stranger is wrong — and a\n" +
            `manifest claiming "${manifest.license}" over a tarball with no licence text fails a compliance\n` +
            "review rather than a test",
        );
      }

      // ── the artifact, installed ────────────────────────────────────────────────────────────────────────────
      const [, shortName] = shipped.name.split("/");
      run("tar", ["-xzf", packed, "-C", join(modules, "@retinue")]);
      run("mv", [join(modules, "@retinue", "package"), join(modules, "@retinue", shortName)]);

      // ── 1 & 3: what loads, and what is refused ─────────────────────────────────────────────────────────────
      const probeFile = join(consumer, `probe-${shortName}.mjs`);
      writeFileSync(
        probeFile,
        `const attempt = async (specifier) => {\n` +
          `  try {\n` +
          `    const module = await import(specifier);\n` +
          `    return { specifier, loaded: true, names: Object.keys(module).length };\n` +
          `  } catch (error) {\n` +
          `    return { specifier, loaded: false, code: error.code ?? null, message: error.message };\n` +
          `  }\n` +
          `};\n` +
          `const allowed = ${JSON.stringify(subpaths)};\n` +
          `const deep = ${JSON.stringify(deepImports)};\n` +
          `console.log(JSON.stringify({\n` +
          `  allowed: await Promise.all(allowed.map(attempt)),\n` +
          `  deep: await Promise.all(deep.map(attempt)),\n` +
          `}));\n`,
      );

      let probe;
      try {
        probe = JSON.parse(run(process.execPath, [probeFile], { cwd: consumer }));
      } catch (error) {
        die(`the consumer probe for ${shipped.name} did not run: ${error.stderr || error.message}`);
      }

      for (const outcome of probe.allowed) {
        if (!outcome.loaded) {
          fail(`${outcome.specifier} is exported but does not load: ${outcome.code ?? "no code"}`, outcome.message);
        }
      }

      for (const outcome of probe.deep) {
        if (outcome.loaded) {
          fail(
            `${outcome.specifier} loaded — the exports map does not close the boundary`,
            "a consumer can reach an internal module, so it is public API in practice and every refactor behind\n" +
              "it is a breaking change nobody will describe as one",
          );
        } else if (!blockedByExports(outcome)) {
          fail(
            `${outcome.specifier} failed with ${outcome.code ?? "no code"} rather than ERR_PACKAGE_PATH_NOT_EXPORTED`,
            "it was not the boundary that stopped it. That distinction is the guarantee: a missing file stops\n" +
              "being missing the moment somebody adds it, and then nothing is left refusing the import",
          );
        }
      }

      // ── 2 & 4: the same thing at build time, which is the form a consumer's CI would hit ───────────────────
      const legal = typecheck(
        `legal-${shortName}`,
        subpaths.map((specifier, index) => `import * as m${index} from "${specifier}";`).join("\n") +
          `\nexport const surface = [${subpaths.map((_, index) => `Object.keys(m${index}).length`).join(", ")}];\n`,
      );
      if (!legal.ok) {
        fail(
          `a consumer cannot typecheck against ${shipped.name}'s exported subpaths`,
          legal.output.trim() ||
            "no compiler output — which on its own means the types half of the package is unusable from outside",
        );
      }

      for (const specifier of deepImports) {
        const deep = typecheck(
          `deep-${shortName}`,
          `import * as reached from "${specifier}";\nexport const names = Object.keys(reached);\n`,
        );
        if (deep.ok) {
          fail(
            `${specifier} typechecks from a consumer — the build would not stop somebody reaching in`,
            "it is refused at import and the build says nothing, so the deep import is written, merged, and\n" +
              "found in production",
          );
        }
      }

      summaries.push(
        `${shipped.name}: ${subpaths.length} subpath(s) load and typecheck, ${deepImports.length} deep imports` +
          ` refused, ${entries.length} files shipped`,
      );
    }

    if (ok) {
      console.log(`✓ the boundary holds as installed, with no sources or sourcemaps and a licence in each:`);
      for (const summary of summaries) console.log(`  · ${summary}`);
    }
  } finally {
    if (keep) console.log(`\n  kept: ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }

  return ok ? 0 : 1;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
