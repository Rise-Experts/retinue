/**
 * Proves a release tag resolves to exactly one package at exactly the version its manifest declares.
 *
 * The case worth the file: npm takes the version from `package.json` and treats the git tag as a name. So
 * `agentkit@0.1.1` over a manifest saying `0.1.0` publishes `0.1.0` under a tag claiming `0.1.1` — or fails as
 * already-published, which is the luckier of the two outcomes. Nothing else in the pipeline compares them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { distTag, RELEASABLE, resolveTag } from "./release-target.mjs";

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
  assert.deepEqual(Object.keys(RELEASABLE), ["agentkit", "react", "tools-github", "tools-slack", "tools-search"]);
});
