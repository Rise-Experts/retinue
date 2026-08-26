#!/usr/bin/env node
/**
 * A publish happens from a tagged CI release, or it does not happen — REQ-040 (#189), SPEC #193, AC-3.
 *
 * "A `npm publish` from a laptop publishes an uncommitted working tree, and there is no way to tell afterwards."
 * That is the whole argument, and it is worth restating precisely, because the obvious reading is about
 * discipline and the real problem is about *evidence*: a tarball built on a workstation is a tarball nobody can
 * reproduce. The version number is permanent, the artefact is what consumers install forever, and the only
 * record of what went into it is one person's shell history.
 *
 * Wired as `prepublishOnly` on every package that can be published, so it is npm itself that refuses. A rule
 * written in a runbook is a rule that holds until somebody is in a hurry.
 *
 * ## Why this exists rather than `private: true`
 *
 * `private: true` refuses a publish everywhere, including the release. It was the right value while the scope
 * was unclaimed and the licence unchosen — both settled now (#184, #192) — and the moment it is removed the
 * package becomes publishable *from anywhere*, by anyone with a token. This guard is what replaces it: the
 * protection lands in the same commit that removes the other one, and `release-check.mjs` fails a publishable
 * package that has no guard, so the two cannot be separated later.
 *
 * ## What counts as a release
 *
 * All of it, not any of it:
 *
 *   - GitHub Actions is running it (`GITHUB_ACTIONS`), because that is where the build is reproducible from a
 *     commit and the logs are not on somebody's machine;
 *   - the ref is a **tag** matching `v*`, not a branch. A publish from a branch has no immutable name to point
 *     at afterwards: `main` moves, and "which commit is 0.1.0" becomes a question with no answer;
 *   - the workflow is the release workflow, so a publish cannot be smuggled into a test job that happens to have
 *     the token.
 *
 * A dry run is allowed anywhere. It uploads nothing, and refusing it would mean the only way to inspect what
 * would ship is to ship it.
 *
 * Exit codes: 0 allowed, 1 refused. There is no "could not tell" — an unrecognised environment is a
 * workstation.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The shape of a release tag, not its identity.
 *
 * `<package>@<version>` — `agentkit@0.1.0`, `react@0.2.0-next.1` — because #193 requires independent versions
 * per package and a single `v0.1.0` cannot express which package it releases. The *shape* is all this guard
 * checks; whether the name is a package we publish, and whether the version matches the manifest, is
 * `release-target.mjs`'s job inside the gate. Two files knowing the tag grammar would be one too many; two
 * files knowing different halves of the question is the split that keeps each one short.
 */
const TAG_PATTERN = /^refs\/tags\/[a-z][a-z0-9-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/**
 * The workflow allowed to publish, by name.
 *
 * Exported so the tests can compare it against `.github/workflows/release.yml`'s own `name:`. Two things that
 * must agree with nothing making them is the shape this repository keeps finding defects in — and the failure
 * here is quiet in the worst way: rename the workflow and the guard refuses the very release built to satisfy
 * it, on a tag push, which is the least convenient moment to discover a string mismatch.
 */
export const RELEASE_WORKFLOW = "Release";

/**
 * npm sets `npm_config_dry_run` for `--dry-run`.
 *
 * Read from the environment rather than from `process.argv`, because `prepublishOnly` is invoked by npm and does
 * not receive the publish command's arguments — a first version checked `argv` and allowed every real publish it
 * was asked about, which is the exact inverse of the intended behaviour.
 */
export const isDryRun = (env) => env.npm_config_dry_run === "true";

/**
 * Whether this environment is a release. Pure, so the decision is testable without a publish.
 *
 * Returns `null` when allowed, or the sentence explaining the refusal. A boolean would make every refusal read
 * the same, and "why did my publish fail" is the only question anybody asks here.
 */
export const refusal = (env) => {
  if (isDryRun(env)) return null;
  if (env.RETINUE_ALLOW_LOCAL_PUBLISH) {
    // Deliberately not an escape hatch that works: naming it in the refusal is the point. Somebody setting this
    // has decided to publish an unreproducible artefact, and they should have to say so to a person, not to an
    // environment variable.
    return (
      "RETINUE_ALLOW_LOCAL_PUBLISH is set, and it does not do anything. There is no local-publish switch: the " +
      "artefact would be unreproducible whatever the variable says. Tag a release instead."
    );
  }
  if (env.GITHUB_ACTIONS !== "true") {
    return (
      "not running in GitHub Actions. A publish from a workstation ships an unreproducible tarball built from " +
      "an unknown working tree, and the version number is permanent. Push a tag: " +
      "`git tag agentkit@0.1.0 && git push origin agentkit@0.1.0`."
    );
  }
  if (!TAG_PATTERN.test(env.GITHUB_REF ?? "")) {
    return (
      `the ref is \`${env.GITHUB_REF ?? "unset"}\`, not a \`<package>@<version>\` tag. A publish from a branch ` +
      "has no immutable " +
      "name to point at afterwards — `main` moves, and \"which commit is 0.1.0\" becomes unanswerable."
    );
  }
  if (env.GITHUB_WORKFLOW !== RELEASE_WORKFLOW) {
    return (
      `the workflow is \`${env.GITHUB_WORKFLOW ?? "unset"}\`, not \`${RELEASE_WORKFLOW}\`. A publish must not be ` +
      "reachable from a job that merely happens to hold the credential."
    );
  }
  return null;
};

/**
 * Only when npm invokes this as `prepublishOnly` — the third script in this repository to need the guard, so it
 * is now the default assumption rather than a discovery. Without it, the unit tests' import *refuses their own
 * process*: `refusal({})` is correct for a test runner, and the test run dies on exit 1 having asserted nothing.
 */
const main = () => {
  const problem = refusal(process.env);
  if (problem) {
    console.error(`✗ refusing to publish: ${problem}`);
    console.error("  see docs/19-versioning.md → 'Releasing'");
    return 1;
  }
  console.log(
    isDryRun(process.env)
      ? "· dry run: nothing is uploaded, so the guard allows it"
      : `✓ release: ${process.env.GITHUB_REF} in ${process.env.GITHUB_WORKFLOW}`,
  );
  return 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
