/**
 * Proves the publish guard refuses everything except a tagged release, and — the half that is easy to get
 * backwards — allows a dry run.
 *
 * Tested as a pure decision rather than by running `npm publish`, deliberately. The honest end-to-end test of
 * "a workstation publish is refused" *publishes the package if the guard is wrong*, and there is a
 * publish-capable token in the developer's `~/.npmrc`. So the two halves are verified separately: this file
 * proves the decision, and `npm publish --dry-run` proves npm invokes it as `prepublishOnly`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isDryRun, refusal, RELEASE_WORKFLOW } from "./publish-guard.mjs";

const RELEASE = { GITHUB_ACTIONS: "true", GITHUB_REF: "refs/tags/agentkit@0.1.0", GITHUB_WORKFLOW: "Release" };

test("importing this module does not refuse the test process", () => {
  // Without the entry guard, importing ran the check, decided (correctly) that a test runner is a workstation,
  // and exited 1 before any assertion ran. Third script in this repository to need it.
  assert.ok(true);
});

test("a tagged release in the release workflow is allowed", () => {
  assert.equal(refusal(RELEASE), null);
  assert.equal(refusal({ ...RELEASE, GITHUB_REF: "refs/tags/react@0.2.0-next.1" }), null);
});

test("a workstation is refused, and the message says what to do instead", () => {
  const problem = refusal({});
  assert.match(problem, /not running in GitHub Actions/);
  assert.match(problem, /git tag agentkit@0\.1\.0/);
});

test("a dry run is allowed anywhere, because refusing it would mean shipping to inspect", () => {
  assert.equal(isDryRun({ npm_config_dry_run: "true" }), true);
  assert.equal(refusal({ npm_config_dry_run: "true" }), null);
  // Read from the environment, not argv: `prepublishOnly` does not receive the publish command's arguments, and
  // a first version that checked argv allowed every real publish it was asked about.
  assert.equal(isDryRun({}), false);
});

test("CI on a branch is refused — a publish needs an immutable name to point at", () => {
  const problem = refusal({ ...RELEASE, GITHUB_REF: "refs/heads/main" });
  assert.match(problem, /not a `<package>@<version>` tag/);
});

test("the old `v0.1.0` tag shape is refused, since it does not say which package it releases", () => {
  assert.ok(refusal({ ...RELEASE, GITHUB_REF: "refs/tags/v0.1.0" }));
  assert.ok(refusal({ ...RELEASE, GITHUB_REF: "refs/tags/agentkit@nightly" }));
});

test("another workflow holding the credential cannot publish", () => {
  const problem = refusal({ ...RELEASE, GITHUB_WORKFLOW: "CI" });
  assert.match(problem, /not `Release`/);
});

test("the workflow this guard allows is the workflow that exists", () => {
  // The guard matches on `GITHUB_WORKFLOW`, which is the workflow's `name:`. Rename one without the other and
  // the guard refuses the release built to satisfy it — on a tag push, which is the least convenient moment to
  // find a string mismatch.
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const name = /^name:\s*(.+)$/m.exec(workflow);
  assert.ok(name, "release.yml has no top-level `name:`");
  assert.equal(name[1].trim(), RELEASE_WORKFLOW);
});

test("the escape hatch is named in the refusal rather than honoured", () => {
  // A variable that turns the guard off would be the guard's own bypass, findable by anyone who reads the source
  // while in a hurry. Naming it and refusing anyway is the only version of this that means something.
  const problem = refusal({ ...RELEASE, RETINUE_ALLOW_LOCAL_PUBLISH: "1" });
  assert.match(problem, /does not do anything/);
});
