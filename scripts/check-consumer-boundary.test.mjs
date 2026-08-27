/**
 * Proves the consumer-boundary checker's judgements, which are the part that can silently invert.
 *
 * The end-to-end script packs a tarball, extracts it and runs two compilers, so it is minutes rather than
 * milliseconds and cannot sensibly be a unit test. What is tested here is what it *decides* — because when this
 * check was first written it passed on the first attempt, and a sabotage (`"./*": "./dist/*"` in the exports map)
 * revealed that the deep imports then failed with `ERR_MODULE_NOT_FOUND`: the boundary was wide open and every
 * forbidden import still threw. A checker that accepted "it threw" would have called that a pass.
 *
 * So `blockedByExports` is the guarantee, and it gets a test of its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blockedByExports,
  exportedSubpaths,
  forbiddenTarballEntries,
  missingTarballEntries,
  PACKAGES,
  REQUIRED_ENTRIES,
  verifiedNothing,
  relativeLinks,
  unresolvedLinks,
  codeBlocks,
} from "./check-consumer-boundary.mjs";

test("importing this module does not run the check", () => {
  // The first version of this file had no such guard, so importing the script ran the whole check and then called
  // `process.exit(0)`: the test process ended before any assertion ran, and the suite was green having tested
  // nothing. If that regresses, this file stops reporting failures rather than reporting a failure.
  assert.ok(true, "reaching this line at all means the import returned instead of exiting");
});

test("only the exports map counts as having refused a deep import", () => {
  assert.equal(blockedByExports({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }), true);
  // The one that matters: the file simply was not there. Ship it tomorrow and nothing refuses the import.
  assert.equal(blockedByExports({ code: "ERR_MODULE_NOT_FOUND" }), false);
  assert.equal(blockedByExports({ code: null }), false);
  assert.equal(blockedByExports({}), false);
});

test("subpaths come from the manifest, and `.` becomes the bare specifier", () => {
  const subpaths = exportedSubpaths(
    { exports: { ".": {}, "./flows": {}, "./adapters/postgres": {}, "./package.json": "./package.json" } },
    "@retinue/agentkit",
  );
  assert.deepEqual(subpaths, [
    "@retinue/agentkit",
    "@retinue/agentkit/flows",
    "@retinue/agentkit/adapters/postgres",
  ]);
});

test("`./package.json` is exported deliberately and is not treated as a module", () => {
  assert.ok(!exportedSubpaths({ exports: { "./package.json": "./package.json" } }, "@retinue/agentkit").length);
});

test("a manifest with no exports map yields the root, and the caller treats that as a finding", () => {
  // Not an empty list: a package with no map has one entry point *and no boundary*, and returning nothing here
  // would make the load checks vacuous on exactly the package that needs them most.
  assert.deepEqual(exportedSubpaths({}, "@retinue/react"), ["@retinue/react"]);
});

test("the three files every published package needs are checked, and absence is reported", () => {
  assert.deepEqual(missingTarballEntries(["package/dist/index.js", "package/package.json"]), ["LICENSE", "README.md"]);
  assert.deepEqual(missingTarballEntries(REQUIRED_ENTRIES.map((entry) => `package/${entry}`)), []);
});

test("sources and sourcemaps are refused, compiled output is not", () => {
  const offenders = forbiddenTarballEntries([
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/index.js.map",
    "package/dist/index.d.ts.map",
    "package/src/index.ts",
    "package/README.md",
    "package/package.json",
    "package/",
  ]);
  assert.deepEqual(offenders, ["dist/index.js.map", "dist/index.d.ts.map", "src/index.ts"]);
});

test("an empty --published run is a failure, not a pass", () => {
  // The code said the opposite for ten minutes. The per-package 404 skip — needed because the first release is
  // two tags and the second package does not exist yet — is correct on its own and wrong in aggregate: with
  // every package skipped it printed "the boundary holds" having examined no artefact at all.
  assert.equal(verifiedNothing(true, 0), true, "a --published run that checked nothing must fail");
  assert.equal(verifiedNothing(true, 1), false);
  // Locally there is nothing to skip: every package is packed from this checkout, so zero means a real problem
  // that the per-package checks have already reported.
  assert.equal(verifiedNothing(false, 0), false);
});

test("relative links are found in both markdown and html form, and absolute ones ignored", () => {
  const md = [
    "[a](../docs/x.md) [b](./README.md) [c](https://example.com/y) [d](#anchor) [e](mailto:x@y.z)",
    '<img src="brand/mark.svg" /> <img src="https://cdn.example/logo.png" />',
    "[f](dist/index.js#L4)",
  ].join("\n");
  assert.deepEqual(relativeLinks(md), ["../docs/x.md", "./README.md", "dist/index.js", "brand/mark.svg"]);
});

test("a link is unresolved unless the tarball actually contains it", () => {
  // The defect this exists for: `../docs` in a published README, which resolves to nothing on npmjs.com.
  const files = ["README.md", "package.json", "dist/index.js"];
  assert.deepEqual(unresolvedLinks(["../docs/x.md", "./README.md", "dist/index.js"], files), ["../docs/x.md"]);
  assert.deepEqual(unresolvedLinks([], files), []);
});

test("ts and tsx blocks are extracted, other languages left alone", () => {
  const md = "```bash\nnpm i x\n```\n```ts\nconst a = 1;\n```\n```tsx\nconst b = <p />;\n```\n";
  assert.deepEqual(codeBlocks(md), [
    { lang: "ts", code: "const a = 1;\n" },
    { lang: "tsx", code: "const b = <p />;\n" },
  ]);
  // A shell block is not a compile target; extracting it would fail every README with an install line.
  assert.equal(codeBlocks("```bash\nnpm i\n```").length, 0);
});

test("every shipping package is covered, and each deep list has both halves of the risk", () => {
  // Both, because it checked only the runtime at first and `@retinue/react` was meanwhile shipping 32
  // sourcemaps pointing at sources it did not contain. A check covering one of two published packages reads,
  // in a green pipeline, as covering both.
  // Exact, not "contains": an accidental addition should fail here and be looked at, and a toolkit added
  // without consumer-boundary coverage would otherwise ship unchecked. #214 added the third deliberately.
  assert.deepEqual(PACKAGES.map((shipped) => shipped.name), [
    "@retinue/agentkit",
    "@retinue/react",
    "@retinue/tools-github",
  ]);
  for (const shipped of PACKAGES) {
    // A list of only-missing paths would pass against a package with no exports map at all, which is the state
    // this check exists to detect.
    assert.ok(shipped.deep.some((path) => path.startsWith("dist/")), `${shipped.name}: no path into the output`);
    assert.ok(shipped.deep.some((path) => path.startsWith("src/")), `${shipped.name}: no path into the sources`);
    assert.ok(shipped.deep.length >= 4, `${shipped.name}: too few deep imports to prove anything`);
  }
});
