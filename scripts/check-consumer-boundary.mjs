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
 * 6. The tarball contains `LICENSE`, `README.md` and `package.json`.
 * 7. **Every relative link in the shipped README resolves inside the tarball**, and every fenced `ts`/`tsx`
 *    block in it typechecks against the installed package. npm includes those three whatever `files`
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
 * ## `--published`
 *
 * Same checks, against the tarball the **registry** serves rather than the one `npm pack` builds here — #193
 * AC-6, "verified by an actual install, not by a build". One code path, because the only honest difference is
 * where the tarball comes from: `npm pack <name>@<version>` fetches the published artefact, and everything after
 * that is identical. A separate post-publish script would be a second implementation of the checks that matter
 * most, run least often.
 *
 * ## `--only <name>`
 *
 * Narrows the run to one package, and it is what the release workflow passes. Without it, `--published` checks
 * **every** shipping package against the registry — which compares today's expectations against artefacts
 * published at different times, and that is not a boundary check. It went red the first time it mattered: a
 * `tools-slack` release failed because `@retinue/agentkit@0.1.0` — published weeks earlier, before the
 * `guardrails` subpath existed and before the README was rewritten — does not satisfy the current checkout's
 * subpath list or link rules. Both facts were true and neither was about the release being verified.
 *
 * A release verifies what it just published. Version skew between the repository and *other* published packages
 * is a real thing to know about, and it is a different question from "is the thing I just shipped usable".
 *
 * Usage: node scripts/check-consumer-boundary.mjs [--keep] [--published] [--only <package>]
 * Exit codes: 0 the boundary holds, 1 it does not, 2 the check could not run.
 */

import { execFileSync, spawnSync } from "node:child_process";
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
  {
    name: "@retinue/tools-github",
    dir: "tools/github",
    deep: ["dist/index.js", "src/index.ts", "tools", "internal"],
  },
  {
    name: "@retinue/tools-slack",
    dir: "tools/slack",
    deep: ["dist/index.js", "src/index.ts", "tools", "internal"],
  },
  {
    name: "@retinue/tools-search",
    dir: "tools/search",
    deep: ["dist/index.js", "src/index.ts", "providers", "internal"],
  },
  {
    name: "@retinue/tools-jira",
    dir: "tools/jira",
    // `adf` is the module a consumer would most plausibly reach for — the converter is genuinely useful on its
    // own — which is exactly why it must not resolve as a subpath. It is re-exported from the root instead.
    deep: ["dist/index.js", "src/index.ts", "adf", "internal"],
  },
  {
    name: "@retinue/tools-confluence",
    dir: "tools/confluence",
    deep: ["dist/index.js", "src/index.ts", "storage", "internal"],
  },
  {
    name: "@retinue/tools-linear",
    dir: "tools/linear",
    deep: ["dist/index.js", "src/index.ts", "graphql", "internal"],
  },
  {
    name: "@retinue/tools-meta",
    dir: "tools/meta",
    deep: ["dist/index.js", "src/index.ts", "whatsapp", "internal"],
  },
  {
    name: "@retinue/tools-notion",
    dir: "tools/notion",
    // `blocks` is the module a consumer would most plausibly reach for, which is why it must not resolve.
    deep: ["dist/index.js", "src/index.ts", "blocks", "internal"],
  },
];

/**
 * Documentation whose samples are instructions rather than illustrations — task #217.
 *
 * See the note at the call site for why this is a list and not "every page under `website/content`".
 */
export const DOC_SAMPLE_ROOTS = ["website/content/getting-started", "website/content/integrations"];

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
 * Relative link targets in a markdown document — `](path)` and `src="path"`.
 *
 * The published README is read on npmjs.com, where the repository does not exist. A relative link there resolves
 * to nothing, and the reader's first act is a 404. This was not hypothetical: 14 of the 15 relative links in
 * `@retinue/agentkit`'s README were broken at 0.1.0, starting with the first line, which pointed at `../docs`.
 */
export const relativeLinks = (markdown) => [
  ...[...markdown.matchAll(/\]\((?!https?:|mailto:|#)([^)\s]+)/g)].map((m) => m[1]),
  ...[...markdown.matchAll(/src="(?!https?:|data:)([^"]+)"/g)].map((m) => m[1]),
].map((target) => target.split("#")[0]).filter((target) => target.length > 0);

/** Which of those the tarball does not contain. `paths` is the extracted file list, package-prefix stripped. */
export const unresolvedLinks = (targets, paths) => {
  const present = new Set(paths);
  return [...new Set(targets)].filter((target) => !present.has(target.replace(/^\.\//, "")));
};

/**
 * Fenced code blocks, by language.
 *
 * Every `ts`/`tsx` block in a published README is typechecked against the installed package, because a README
 * example is the first code anybody runs and a snippet that no longer compiles is worse than no example: it
 * teaches an API that does not exist. A block that cannot compile standalone does not belong in a README.
 */
export const codeBlocks = (markdown) =>
  [...markdown.matchAll(/```(ts|tsx)\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1], code: m[2] }));

/**
 * Whether a deep import was stopped *by the boundary*.
 *
 * The distinction this makes is the point of the whole file. `ERR_MODULE_NOT_FOUND` means the specifier resolved
 * as far as a path and the path was empty — which is what would happen if the `exports` map were deleted and the
 * tarball merely happened not to contain that file. Accepting it would mean this check keeps passing after the
 * guarantee is gone.
 */
export const blockedByExports = (outcome) => outcome.code === "ERR_PACKAGE_PATH_NOT_EXPORTED";

/**
 * How long to wait for a just-published version to appear, and how often to ask.
 *
 * Three minutes because the observed lag ran to twenty for one package's *packument* while its version document
 * was served immediately — so this is not sized to the worst case, it is sized to the common one, and the
 * uncommon case now fails with a sentence naming the wait rather than with "nothing was verified".
 */
export const PUBLISH_WAIT_MS = 180_000;
export const PUBLISH_POLL_MS = 10_000;

/**
 * Sleep, synchronously, because everything around it is synchronous `execFileSync`.
 *
 * `Atomics.wait` on a throwaway buffer rather than a busy loop: a spin would burn a CI core for three minutes,
 * and making this one function async would mean threading a promise through a script whose whole shape is
 * sequential shell calls.
 */
export const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Verifying nothing is not passing.
 *
 * A rule rather than an inline condition, so it can be tested without a registry. The per-package 404 skip below
 * is correct on its own and wrong in aggregate: with every package skipped, this printed "the boundary holds"
 * having examined no artefact at all — success reported for an empty run, which is the failure mode this file
 * exists to catch, reproduced inside it ten minutes after the skip was added. In `--published` mode a release
 * has just published something, so at least one package must be there.
 */
export const verifiedNothing = (published, checked) => published && checked === 0;

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
  const published = process.argv.includes("--published");
  /**
   * The one package to check, when a caller names it. Accepts the workspace name (`@retinue/tools-slack`) or the
   * short form (`tools-slack`), because the release workflow has the first and a person typing it has the second.
   */
  const onlyAt = process.argv.indexOf("--only");
  const only = onlyAt === -1 ? null : process.argv[onlyAt + 1];
  if (onlyAt !== -1 && (only === undefined || only.startsWith("--"))) {
    die("--only needs a package name, for example --only @retinue/tools-slack");
  }
  const selected = only === null ? PACKAGES : PACKAGES.filter((shipped) => shipped.name === only || shipped.name === `@retinue/${only}`);
  if (only !== null && selected.length === 0) {
    die(
      `--only ${only} matches none of the shipping packages: ${PACKAGES.map((shipped) => shipped.name).join(", ")}`,
    );
  }

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

    /**
     * `types` is a parameter because the two things being typechecked live in different worlds.
     *
     * The subpath and deep-import probes use `types: []` on purpose: an ambient global can mask a missing export
     * and make a broken package look importable. A **README example** is different — it is Node code a reader
     * will paste into a Node project, and `process.env.GITHUB_TOKEN` is exactly how a host supplies a token. With
     * `types: []` the check failed on a correct example, which is the false-positive shape that gets a check
     * loosened until it catches nothing.
     */
    const typecheck = (name, source, lang = "ts", types = []) => {
      writeFileSync(join(consumer, `${name}.${lang}`), source);
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
              types,
            },
            files: [`${name}.${lang}`],
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
    const readmeSummary = [];
    const binSummary = [];
    const consumerSummary = [];
    const docsSummary = [];
    let checked = 0;

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

      /**
       * Nothing below here is needed for a package this run will not assert on.
       *
       * The install has to happen for every package — see `--only` — but the *registry* work does not: probing
       * and packing four unrelated versions during a release costs four round trips and, worse, fills the summary
       * with "not published yet" lines about packages nobody asked about. Placed after the manifest reads above
       * so a malformed manifest is still caught everywhere.
       */
      const asserting = selected.includes(shipped);

      /**
       * In `--published` mode, wait for the registry to catch up before deciding it is absent.
       *
       * The first version probed once and skipped on a 404, which was right for the case it was written for —
       * `agentkit@0.1.0`'s release running while `@retinue/react@0.1.0` did not exist. It was wrong for the case
       * that actually happened: a release publishes, this step runs seconds later, and the registry has not
       * propagated. `agentkit@0.2.0` published successfully and its own release went red with "nothing was
       * verified", which is the `verifiedNothing` guard doing its job for a timing reason. Earlier the same day
       * `@retinue/tools-github` took roughly twenty minutes to expose its packument while serving the version
       * document immediately, so this is not a narrow window.
       *
       * So: poll, and let the two outcomes stay distinct. When the caller named one package with `--only`, that
       * package **must** appear — it is the one just published, and skipping it is how a release reports success
       * having checked nothing. Unscoped, a genuinely absent version is still a loud skip.
       *
       * Only a 404 is retried. "The registry is unreachable" and "this version is not published" must not
       * collapse into the same answer.
       */
      if (published && asserting) {
        const deadline = Date.now() + PUBLISH_WAIT_MS;
        let seen = false;
        let lastOutput = "";
        for (;;) {
          try {
            run("npm", ["view", `${shipped.name}@${manifest.version}`, "version"], { cwd: ROOT });
            seen = true;
            break;
          } catch (error) {
            lastOutput = `${error.stdout ?? ""}${error.stderr ?? ""}`;
            if (!/E404|is not in this registry|No match(ing version)? found/i.test(lastOutput)) {
              die(`npm view ${shipped.name}@${manifest.version} failed for a reason other than 404: ${lastOutput.trim()}`);
            }
            if (Date.now() >= deadline) break;
            sleepSync(PUBLISH_POLL_MS);
          }
        }
        if (!seen) {
          if (only !== null) {
            fail(
              `${shipped.name}@${manifest.version} never appeared on the registry within ` +
                `${Math.round(PUBLISH_WAIT_MS / 1000)}s of being asked for`,
              "this run was scoped to that package with --only, so it is the one just published. A skip here\n" +
                "would be a release reporting success having verified nothing",
            );
            continue;
          }
          summaries.push(`${shipped.name}@${manifest.version}: not published yet — skipped (${lastOutput.trim().split("\n")[0]})`);
          continue;
        }
      }

      let packed;
      // `-w <name>` builds from this workspace; `<name>@<version>` fetches what the registry serves.
      const packArguments = published
        ? ["pack", `${shipped.name}@${manifest.version}`, "--pack-destination", work, "--json"]
        : ["pack", "-w", shipped.name, "--pack-destination", work, "--json"];
      try {
        const output = run("npm", packArguments, { cwd: ROOT });
        packed = join(work, JSON.parse(output)[0].filename);
      } catch (error) {
        /**
         * A package nobody is asserting on is skipped, not fatal.
         *
         * During a release only one package is under assertion; the others are installed so the consumer is
         * complete, and one whose version the registry does not have yet simply cannot be. Failing there would
         * make a runtime release red because a client published minutes later does not exist — the case the
         * original skip was written for, kept.
         */
        if (published && !asserting) {
          summaries.push(`${shipped.name}@${manifest.version}: not on the registry — not installed`);
          continue;
        }
        die(
          `npm pack ${published ? `${shipped.name}@${manifest.version} from the registry` : shipped.name} failed: ` +
            `${error.stderr || error.message}`,
        );
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

      /**
       * Installed for everyone, asserted for the one named — see `--only`.
       *
       * The install cannot be narrowed: `@retinue/tools-slack` imports `@retinue/agentkit`, so a consumer holding
       * only the toolkit cannot load it at all, and the check would report a boundary failure that is really a
       * missing peer. So the scratch consumer always gets every package — which is what a real consumer has — and
       * `--only` narrows what is *checked*.
       */
      if (!selected.includes(shipped)) continue;

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

      /**
       * ── 6a: the conformance suite catches a bad adapter — task #253 AC-2 ────────────────────────────────
       *
       * The README's headline is "Replaceable everything — one conformance suite held over all of them", and
       * `@retinue/agentkit/testing` is the export that makes that checkable rather than an invitation. But a
       * conformance suite nobody has watched **fail** has demonstrated nothing: an empty harness, a broken
       * import, an export that resolves to `undefined` — all of those "pass".
       *
       * So a throwaway package installs the tarball, implements `ConversationStore` badly in exactly the way
       * that matters, and the suite must reject it. The bug planted is the real one: `findById` ignoring
       * `tenantId`, which is the `AgentStore` leak #91 found — a method that accepted `TenantScope` and
       * destructured only the id.
       */
      if (shortName === "agentkit") {
        const specPath = join(consumer, "conformance-negative.test.ts");
        writeFileSync(
          specPath,
          [
            `import { conversationStoreConformance } from "@retinue/agentkit/testing";`,
            `/** Leaks across tenants: the exact shape of the #91 defect. */`,
            `const leaky = () => {`,
            `  const rows = new Map<string, any>();`,
            `  return {`,
            `    async create({ tenantId, id, title }: any) {`,
            `      const row = { id, tenantId, title, version: 1, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), deletedAt: null };`,
            `      rows.set(id, row);`,
            `      return row;`,
            `    },`,
            `    async findById({ id }: any) { return rows.get(id) ?? null; },`,
            `    async list() { return { items: [...rows.values()] }; },`,
            `    async update({ id, patch }: any) { const r = { ...rows.get(id), ...patch, version: rows.get(id).version + 1 }; rows.set(id, r); return r; },`,
            `    async softDelete({ id }: any) { rows.delete(id); },`,
            `  };`,
            `};`,
            `conversationStoreConformance(leaky as never);`,
          ].join("\n"),
        );
        /**
         * The positive control, and it is not optional.
         *
         * "Watched it fail" means nothing on its own: a broken import, a harness that throws on import, or an
         * export resolving to `undefined` would all make the negative run non-zero and look like a pass. So the
         * *correct* adapter must go through the same exported suite in the same scratch consumer and come back
         * green — AC-3, "the export is the same suite and not a reduced copy".
         */
        const positivePath = join(consumer, "conformance-positive.test.ts");
        writeFileSync(
          positivePath,
          [
            `import { conversationStoreConformance } from "@retinue/agentkit/testing";`,
            `import { createMemoryConversationStore } from "@retinue/agentkit/persistence";`,
            `conversationStoreConformance(() => createMemoryConversationStore());`,
          ].join("\n"),
        );

        const vitestBin = join(modules, "vitest", "vitest.mjs");
        if (!existsSync(vitestBin)) {
          fail(
            "vitest is not reachable from the scratch consumer, so the conformance negative test cannot run",
            "it is an optional peer of @retinue/agentkit and a devDependency of this workspace; the symlink\n" +
              "step should have provided it",
          );
        } else {
          const negative = spawnSync(process.execPath, [vitestBin, "run", "conformance-negative.test.ts"], {
            cwd: consumer,
            encoding: "utf8",
            env: { ...process.env, CI: "1" },
          });
          if (negative.status === 0) {
            fail(
              "the exported conformance suite PASSED a ConversationStore that leaks across tenants",
              "a suite nobody has watched fail has demonstrated nothing — this is the check that the export is\n" +
                "the real suite and not an empty or partially-resolved copy",
            );
          } else {
            const positive = spawnSync(process.execPath, [vitestBin, "run", "conformance-positive.test.ts"], {
              cwd: consumer,
              encoding: "utf8",
              env: { ...process.env, CI: "1" },
            });
            if (positive.status !== 0) {
              fail(
                "the exported conformance suite FAILED the built-in in-memory adapter",
                "so the negative result above means nothing — a broken import or an unresolved export would\n" +
                  "also have made it non-zero:\n" +
                  (positive.stdout || positive.stderr || "no output").split("\n").slice(-25).join("\n"),
              );
            } else {
              consumerSummary.push(
                "agentkit: exported conformance suite passes the in-memory adapter and rejects a cross-tenant leak",
              );
            }
          }
        }
      }

      /**
       * ── 6b: the `bin`, if the package declares one — task #252 AC-1 ──────────────────────────────────────
       *
       * Checked here rather than by running it in this repo, because the workspace hides exactly this class of
       * failure. The `tools-*@0.1.0` release proved it: a local check packs the *local* runtime, so an import
       * that only resolves against a sibling workspace passes locally and is broken for everyone who installs.
       * A `bin` is the same shape — a path into `dist` that `files` may not ship, or an entry that throws on a
       * command needing no configuration.
       */
      const bin = shipped.manifest?.bin ?? JSON.parse(readFileSync(join(modules, "@retinue", shortName, "package.json"), "utf8")).bin;
      if (bin !== undefined) {
        for (const [name, relative] of Object.entries(typeof bin === "string" ? { [shortName]: bin } : bin)) {
          const target = join(modules, "@retinue", shortName, relative);
          if (!existsSync(target)) {
            fail(
              `${shipped.name} declares bin "${name}" → ${relative}, which the tarball does not contain`,
              "the `files` field decides what ships; a bin pointing outside it installs a broken command",
            );
            continue;
          }
          // `--help` needs no database, no Redis and no configuration, so a non-zero exit here is the command
          // being broken rather than the environment being empty.
          const help = spawnSync(process.execPath, [target, "--help"], { cwd: consumer, encoding: "utf8" });
          if (help.status !== 0) {
            fail(
              `${shipped.name}'s bin "${name}" exited ${help.status} on --help`,
              (help.stderr || help.stdout || "no output").trim(),
            );
          }
          binSummary.push(`${shortName}: bin ${name} → ${relative} runs`);
        }
      }

      // ── 7: the README a consumer actually reads ───────────────────────────────────────────────────────────
      const readmePath = join(modules, "@retinue", shortName, "README.md");
      if (existsSync(readmePath)) {
        const readme = readFileSync(readmePath, "utf8");
        const stripped = entries.map((path) => path.replace(/^package\//, "")).filter(Boolean);
        const broken = unresolvedLinks(relativeLinks(readme), stripped);
        if (broken.length > 0) {
          fail(
            `${shipped.name}'s README has ${broken.length} relative link(s) that do not exist in the tarball:` +
              ` ${broken.slice(0, 6).join(", ")}`,
            "the README is read on npmjs.com, where this repository does not exist. Use an absolute URL — a\n" +
              "relative one is a 404 as the reader's first act",
          );
        }
        const blocks = codeBlocks(readme);
        if (blocks.length === 0) {
          fail(
            `${shipped.name}'s README has no \`ts\`/\`tsx\` example`,
            "the first screen of a package page is where somebody decides whether to keep reading",
          );
        }
        readmeSummary.push(`${shortName}: ${blocks.length} example(s) typecheck, ${relativeLinks(readme).length} relative link(s)`);
        blocks.forEach((block, index) => {
          const outcome = typecheck(`readme-${shortName}-${index}`, block.code, block.lang, ["node"]);
          if (!outcome.ok) {
            fail(
              `${shipped.name}'s README example #${index + 1} does not typecheck against the published package`,
              outcome.output.trim() || "no compiler output",
            );
          }
        });
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

      checked += 1;
      summaries.push(
        `${shipped.name}: ${subpaths.length} subpath(s) load and typecheck, ${deepImports.length} deep imports` +
          ` refused, ${entries.length} files shipped`,
      );
    }

    /**
     * The documentation's samples, typechecked the same way the READMEs are — REQ-048 (#207), task #217, AC-1.
     *
     * "Code that runs as written" is a claim, and this is the only thing that makes it one. A doc sample that no
     * longer compiles is worse than no sample: it teaches an API that does not exist, and the reader concludes
     * the package is broken rather than the page.
     *
     * **Scoped to the pages a newcomer follows**, and the scope is a decision rather than an omission. The
     * getting-started path and the integration pages are read as instructions — somebody pastes them into a
     * project. Concept pages illustrate a shape with a fragment: they legitimately reference a `deps` the reader
     * has already built, and rewriting them to compile standalone would make them worse to read. What keeps
     * *those* honest is `check:docs`, which resolves every import specifier in every page.
     */
    /**
     * The documentation's samples, only on a full run.
     *
     * They import several packages — a getting-started page uses the runtime, an integration page uses a toolkit
     * — so they need every package installed in the scratch consumer. A release scoped with `--only` installs
     * one, and the samples then fail to resolve the others: a correct-looking check failing for a reason that has
     * nothing to do with the release. The samples are a property of the repository's documentation and are
     * verified by `npm test` on every commit, which is the right place for them.
     */
    for (const dir of only === null ? DOC_SAMPLE_ROOTS : []) {
      const root = join(ROOT, dir);
      if (!existsSync(root)) {
        fail(`${dir} does not exist, so its samples were not checked`, "a moved directory silently checks nothing");
        continue;
      }
      for (const page of readdirSync(root).filter((name) => name.endsWith(".md")).sort()) {
        const markdown = readFileSync(join(root, page), "utf8");
        const blocks = codeBlocks(markdown);
        if (blocks.length === 0) continue;
        docsSummary.push(`${dir.replace("website/content/", "")}/${page}: ${blocks.length}`);
        /**
         * **Cumulatively**, because that is how the page is read.
         *
         * A tutorial's second block uses the `agent` its first block created. Typechecking each block alone
         * reported "cannot find name 'agent'" on eight correct samples — the false-positive shape that gets a
         * check deleted rather than fixed. Concatenating is also the stronger test: it is the file a reader ends
         * up with, so a block that redeclares a name or contradicts an earlier one now fails, and it should.
         */
        let cumulative = "";
        blocks.forEach((block, index) => {
          cumulative = cumulative === "" ? block.code : `${cumulative}\n${block.code}`;
          const name = `doc-${page.replace(/\.md$/, "")}-${index}`;
          const outcome = typecheck(name, cumulative, block.lang, ["node"]);
          if (!outcome.ok) {
            fail(
              `${dir}/${page} does not typecheck up to sample #${index + 1}`,
              outcome.output.trim() || "no compiler output",
            );
          }
        });
      }
    }

    if (verifiedNothing(published, checked)) {
      fail(
        "nothing was verified: no published package matched the versions in this checkout",
        "the release just published one of them, so either the publish did not take effect or the manifest\n" +
          "versions are not the ones released. Reporting success here would mean a green release that shipped\n" +
          "an artefact nobody looked at",
      );
    }

    if (ok) {
      console.log(
        `✓ the boundary holds as installed${published ? " from the registry" : ""}${only === null ? "" : ` for ${only}`},` +
          ` with no sources or sourcemaps and a licence in each:`,
      );
      for (const summary of summaries) console.log(`  · ${summary}`);
      for (const summary of readmeSummary) console.log(`  · README ${summary}`);
      for (const summary of binSummary) console.log(`  · ${summary}`);
      for (const summary of consumerSummary) console.log(`  · ${summary}`);
      for (const summary of docsSummary) console.log(`  · docs ${summary} sample(s) typecheck`);
    }
  } finally {
    if (keep) console.log(`\n  kept: ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }

  return ok ? 0 : 1;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
