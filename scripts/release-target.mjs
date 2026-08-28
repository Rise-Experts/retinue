#!/usr/bin/env node
/**
 * Which package a tag releases, and at which version — SPEC #193.
 *
 * #193 requires **independent versions per package**: "a client-only fix should not bump the runtime, and a
 * shared version teaches consumers that every release affects them." A single `v0.1.0` tag cannot express that —
 * it either releases everything or leaves the workflow guessing — so a release tag names its package:
 *
 *   agentkit@0.1.0        the runtime
 *   react@0.1.0           the client
 *   agentkit@0.2.0-next.1 a prerelease, published under the `next` dist-tag
 *
 * The first release is therefore two tags, which is the honest shape rather than a coordinated one pretending to
 * be independent.
 *
 * ## Why the tag is checked against the manifest
 *
 * A tag is a string a person typed. `agentkit@0.1.1` against a manifest that still says `0.1.0` publishes a
 * version nobody wrote, with the previous version's contents — and npm accepts it, because the version comes
 * from the manifest and the tag is just a name. That mismatch is silent everywhere except here.
 *
 * Usage:
 *   node scripts/release-target.mjs <tag>          # prints the workspace name, for the workflow
 *   node scripts/release-target.mjs <tag> --json   # the whole resolution
 *
 * Exit codes: 0 resolved and consistent, 1 the tag is not a release or disagrees with the manifest.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The short name in a tag, and the workspace it means.
 *
 * Short names rather than the scoped package name, because `@retinue/agentkit@0.1.0` as a git tag has two `@`
 * and reads as a typo. Only these two ship: `shareflow` is our own integration and publishing it would publish a
 * customer's domain model, and `examples` is a demonstration whose dependencies are deliberately loose. The
 * `server` and `tools` packages #193 lists no longer exist — #196 merged the host into the runtime and the
 * first-party tools are the `./tools` subpath (#188), so the shipping set is two packages, not four.
 */
export const RELEASABLE = {
  agentkit: { workspace: "@retinue/agentkit", dir: "backend" },
  react: { workspace: "@retinue/react", dir: "frontend" },
  // Toolkits, versioned independently of the runtime — the whole reason they are separate packages is that a
  // vendor API change must not be a runtime release.
  "tools-confluence": { workspace: "@retinue/tools-confluence", dir: "tools/confluence" },
  "tools-github": { workspace: "@retinue/tools-github", dir: "tools/github" },
  "tools-jira": { workspace: "@retinue/tools-jira", dir: "tools/jira" },
  "tools-slack": { workspace: "@retinue/tools-slack", dir: "tools/slack" },
  "tools-search": { workspace: "@retinue/tools-search", dir: "tools/search" },
};

const TAG = /^(?:refs\/tags\/)?([a-z][a-z0-9-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** The dist-tag a version implies. A prerelease must never land on `latest`, which is the mistake that reaches people who never opted in. */
export const distTag = (version) => (version.includes("-") ? "next" : "latest");

/**
 * Resolve a tag, or explain why it is not a release.
 *
 * Returns `{ ok: true, … }` or `{ ok: false, problem }`. The manifest is read through `readManifest` so the
 * resolution is testable without a checkout.
 */
export const resolveTag = (tag, readManifest) => {
  const match = TAG.exec(tag ?? "");
  if (!match) {
    return {
      ok: false,
      problem:
        `\`${tag ?? "unset"}\` is not a release tag. The form is \`<package>@<version>\` — ` +
        `${Object.keys(RELEASABLE).join(", ")} — for example \`agentkit@0.1.0\`.`,
    };
  }
  const [, name, version] = match;
  const target = RELEASABLE[name];
  if (!target) {
    return {
      ok: false,
      problem:
        `\`${name}\` is not a package this repository publishes. Releasable: ${Object.keys(RELEASABLE).join(", ")}. ` +
        `\`shareflow\` and \`examples\` are deliberately not published.`,
    };
  }

  let manifest;
  try {
    manifest = readManifest(target.dir);
  } catch (error) {
    return { ok: false, problem: `cannot read ${target.dir}/package.json: ${error.message}` };
  }

  if (manifest.version !== version) {
    return {
      ok: false,
      problem:
        `the tag says ${version} and ${target.dir}/package.json says ${manifest.version}. npm takes the version ` +
        `from the manifest, so this would publish ${manifest.version} under a tag naming ${version} — or fail as ` +
        `already-published, which is the luckier outcome. Bump the manifest, or fix the tag.`,
    };
  }
  if (manifest.private) {
    return { ok: false, problem: `${manifest.name} is \`private: true\`, so it cannot be published` };
  }

  return { ok: true, name, version, distTag: distTag(version), ...target };
};

const main = (argv) => {
  const tag = argv.find((argument) => !argument.startsWith("--"));
  const outcome = resolveTag(tag, (dir) => JSON.parse(readFileSync(`${dir}/package.json`, "utf8")));
  if (!outcome.ok) {
    console.error(`✗ ${outcome.problem}`);
    return 1;
  }
  console.log(argv.includes("--json") ? JSON.stringify(outcome) : outcome.workspace);
  return 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
