/**
 * Proves a release tag resolves to exactly one package at exactly the version its manifest declares.
 *
 * The case worth the file: npm takes the version from `package.json` and treats the git tag as a name. So
 * `agentkit@0.1.1` over a manifest saying `0.1.0` publishes `0.1.0` under a tag claiming `0.1.1` — or fails as
 * already-published, which is the luckier of the two outcomes. Nothing else in the pipeline compares them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { distTag, RELEASABLE, resolveTag } from "./release-target.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const manifests = { backend: { name: "@retinue/agentkit", version: "0.1.0" }, frontend: { name: "@retinue/react", version: "0.1.0" } };
const read = (dir) => manifests[dir];

test("a well-formed tag resolves to a workspace, with or without the refs/tags prefix", () => {
  assert.deepEqual(resolveTag("agentkit@0.1.0", read), {
    ok: true, name: "agentkit", version: "0.1.0", distTag: "latest", workspace: "@retinue/agentkit", dir: "backend",
  });
  assert.equal(resolveTag("refs/tags/react@0.1.0", read).workspace, "@retinue/react");
});

test("a prerelease goes to `next`, never `latest`", () => {
  // The one mistake in this area that reaches people who never opted in.
  assert.equal(distTag("0.2.0-next.1"), "next");
  assert.equal(distTag("0.1.0"), "latest");
});

test("a tag whose version disagrees with the manifest is refused", () => {
  const outcome = resolveTag("agentkit@0.1.1", read);
  assert.equal(outcome.ok, false);
  assert.match(outcome.problem, /tag says 0\.1\.1 and backend\/package\.json says 0\.1\.0/);
});

test("a package we deliberately do not publish is refused by name", () => {
  const outcome = resolveTag("shareflow@0.1.0", read);
  assert.equal(outcome.ok, false);
  assert.match(outcome.problem, /deliberately not published/);
});

test("the old `v0.1.0` shape is refused with the form spelled out", () => {
  const outcome = resolveTag("v0.1.0", read);
  assert.equal(outcome.ok, false);
  assert.match(outcome.problem, /<package>@<version>/);
});

test("a private manifest cannot be released even by a correct tag", () => {
  const outcome = resolveTag("agentkit@0.1.0", () => ({ name: "@retinue/agentkit", version: "0.1.0", private: true }));
  assert.equal(outcome.ok, false);
  assert.match(outcome.problem, /private: true/);
});

test("an unreadable manifest is a refusal, not a crash", () => {
  const outcome = resolveTag("agentkit@0.1.0", () => { throw new Error("ENOENT"); });
  assert.equal(outcome.ok, false);
  assert.match(outcome.problem, /cannot read backend\/package\.json/);
});

test("exactly the shipping packages are releasable, and no more", () => {
  /**
   * #196 merged the host into the runtime and #188's tools are the `./tools` subpath, so #193's four-package
   * table was two. #214 adds the first sibling toolkit, which is versioned independently — the whole reason
   * toolkits are separate packages is that a vendor API change must not be a runtime release.
   *
   * Exact rather than "contains", and it has now failed twice for the right reason: a package added to the
   * release path is a decision, and this is where it gets noticed.
   */
  /**
   * Derived from the workspaces, not from a list somebody typed — and the change is the point.
   *
   * This assertion used to be `deepEqual(Object.keys(RELEASABLE), [ …fifteen names… ])`, and its docstring said
   * it had "failed twice for the right reason". It had. What it could never do is notice the opposite mistake:
   * a **publishable package with no release target**. `tools-azure`, `tools-browser`, `tools-email` and
   * `tools-scrape` were all added to the repository, all shipped `private: false`, and none of them could be
   * released — a tag naming any of them was refused, and nothing failed, because the list and the assertion
   * were the same hand-maintained list agreeing with itself.
   *
   * So the comparison is now against the filesystem: every workspace that is not `private` must have a target,
   * and every target must be a workspace. The count stays, because a glob that matched nothing would satisfy
   * both directions.
   */
  const publishable = [];
  for (const dir of ["", "tools"]) {
    const base = resolve(HERE, "..", dir);
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      const manifest = join(base, entry.name, "package.json");
      if (!existsSync(manifest)) continue;
      const parsed = JSON.parse(readFileSync(manifest, "utf8"));
      if (parsed.private === true || typeof parsed.name !== "string") continue;
      publishable.push(parsed.name.split("/")[1]);
    }
  }

  const targets = Object.values(RELEASABLE).map((t) => t.workspace.split("/")[1]);
  assert.deepEqual(
    [...publishable].sort(),
    [...targets].sort(),
    "every publishable workspace needs a release target, and every target a workspace",
  );
  // Nineteen today. A glob that matched nothing would pass both directions above.
  assert.equal(publishable.length, 19);

  /**
   * Every composite project the root build must reach — the second wiring these four were missing.
   *
   * `tools/azure`, `browser`, `email` and `scrape` were added to the repository and wired into **nothing**:
   * no release target, and no root `tsconfig` reference, so `tsc -b` never built them. The local gate passed
   * for months because stale `dist/` directories existed on one machine; a clean `npm ci` in CI produced
   * `TS2307: Cannot find module '@retinue/tools-azure' or its corresponding type declarations` and failed a
   * release that had already been tagged.
   *
   * That is the failure `publish-guard.mjs` is written about, arriving from the other direction: not an
   * unreproducible artefact, but a green check that only reproduces on the machine it was run on. So the
   * reference list is compared against the projects rather than maintained beside them.
   */
  const composite = [];
  for (const dir of ["", "tools", "services"]) {
    const base = resolve(HERE, "..", dir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      const config = join(base, entry.name, "tsconfig.json");
      if (!existsSync(config)) continue;
      // Comments are legal in a tsconfig and this one has them.
      const parsed = JSON.parse(readFileSync(config, "utf8").replace(/^\s*\/\/.*$/gm, ""));
      if (parsed.compilerOptions?.composite !== true) continue;
      composite.push([dir, entry.name].filter(Boolean).join("/"));
    }
  }

  const root = JSON.parse(readFileSync(resolve(HERE, "../tsconfig.json"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  const referenced = (root.references ?? []).map((r) => r.path.replace(/^\.\//, ""));
  assert.deepEqual(
    [...composite].sort(),
    [...referenced].sort(),
    "every composite project must be a root reference, or `tsc -b` never builds it and only a stale dist hides that",
  );
  assert.ok(composite.length >= 20, `expected the scan to find the projects, found ${composite.length}`);

  /**
   * What `examples` imports must be a declared dependency **and** a project reference.
   *
   * The third and fourth wirings the four toolkits were missing, and the ones that actually failed the
   * release: `examples/tsconfig.json` referenced 14 projects and imported 18, so `tsc -b` compiled `examples`
   * before `tools/azure`, `email`, `google` and `scrape` had produced a `.d.ts` — `TS2307`, on a clean
   * checkout only. Their `package.json` ranges were `"*"` rather than a version, which is how they were
   * declared without ever being built.
   *
   * Derived from the imports rather than a list, and from `from "…"` specifically: `@retinue/tools-browser`
   * appears in `toolkits.ts` only inside a comment recording that it is *deliberately* not wired, because it
   * needs a `BrowserDriver` the package does not ship. A scan that counted mentions would demand a dependency
   * on it and quietly reverse that decision.
   */
  const exampleSrc = resolve(HERE, "../examples/src");
  const imported = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      for (const m of readFileSync(full, "utf8").matchAll(/from\s+"(@retinue\/[a-z0-9-]+)"/g)) {
        imported.add(m[1]);
      }
    }
  };
  walk(exampleSrc);

  const exampleManifest = JSON.parse(readFileSync(resolve(HERE, "../examples/package.json"), "utf8"));
  const declared = { ...exampleManifest.dependencies, ...exampleManifest.devDependencies };
  const exampleRefs = JSON.parse(
    readFileSync(resolve(HERE, "../examples/tsconfig.json"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
  ).references.map((r) => r.path);

  const DIR_OF = Object.fromEntries(Object.values(RELEASABLE).map((t) => [t.workspace, t.dir]));
  for (const name of [...imported].sort()) {
    const range = declared[name];
    assert.ok(range, `examples imports ${name} and does not declare it`);
    // `"*"` is what let four packages be declared without ever being built. A real range is what makes npm
    // link the workspace and what tells a reader which version this example is written against.
    assert.notEqual(range, "*", `examples declares ${name} as "*" — use a version range`);
    const dir = DIR_OF[name];
    if (dir === undefined) continue; // not a releasable workspace (agentkit's own subpaths, etc.)
    assert.ok(
      exampleRefs.includes(`../${dir}`),
      `examples imports ${name} without a project reference to ../${dir}, so tsc -b may compile it first`,
    );
  }
  assert.ok(imported.size >= 15, `expected the import scan to find the toolkits, found ${imported.size}`);

  // And the directory each target names has to be the one the manifest is actually in.
  for (const [short, target] of Object.entries(RELEASABLE)) {
    const manifest = JSON.parse(readFileSync(resolve(HERE, "..", target.dir, "package.json"), "utf8"));
    assert.equal(manifest.name, target.workspace, `${short} points at ${target.dir}`);
  }
});
