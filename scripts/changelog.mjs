#!/usr/bin/env node
/**
 * The changelog, from the commits — REQ-040 (#189).
 *
 * Generated rather than written at release time, and the reason is not convenience. A changelog composed
 * afterwards records what somebody remembers mattering, which is reliably not the same set as what changed: the
 * fix nobody was proud of is the one a consumer needed to read about.
 *
 * Reads `git log` between two refs, groups by conventional-commit type, and links each entry to its issue. An
 * entry a reader does not believe can be checked in one click, which is the property that makes a generated
 * changelog worth more than a curated one.
 *
 * Usage:
 *   node scripts/changelog.mjs                    # unreleased: since the last tag, or the whole history
 *   node scripts/changelog.mjs --from v0.1.0 --to HEAD --version 0.2.0
 *
 * Exit codes: 0 wrote a changelog, 2 could not read the history. Never zero for "nothing found" — see below.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const REPO = "https://github.com/Rise-Experts/retinue";

/**
 * Conventional-commit types, in the order a reader cares about them.
 *
 * `Deprecated` is its own section even though no commit type maps to it, because the deprecation policy promises
 * one — a `feat!` or a `refactor` that deprecates something writes `Deprecated:` in its body, and the generator
 * lifts it. A section that only appears when a commit remembers to say so would be a section that is usually
 * absent and therefore untrusted.
 */
const SECTIONS = [
  ["feat", "Added"],
  ["fix", "Fixed"],
  ["perf", "Performance"],
  ["refactor", "Changed"],
  ["docs", "Documentation"],
  ["test", "Tests"],
  ["build", "Build"],
  ["ci", "CI"],
  ["chore", "Chores"],
];

let from = arg("from");
if (from === undefined) {
  try {
    // stderr swallowed: with no tags yet, `describe` prints "fatal: No names found" and that is the expected
    // answer rather than a problem to show somebody.
    from = execFileSync("git", ["describe", "--tags", "--abbrev=0"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    // No tags yet, which is the current state: the whole history is the first release's changelog.
    from = undefined;
  }
}
const to = arg("to") ?? "HEAD";
const range = from === undefined ? to : `${from}..${to}`;

let lines;
try {
  // `%x1f` between fields and `%x1e` between records: a commit subject can contain anything, including the
  // characters a naive delimiter would use.
  lines = git(["log", range, "--no-merges", "--pretty=format:%H%x1f%s%x1f%b%x1e"])
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean);
} catch (error) {
  console.error(`✗ cannot read git history for ${range}: ${String(error.message).split("\n")[0]}`);
  process.exit(2);
}

if (lines.length === 0) {
  // Not a failure and not a silent success: an empty range is a fact worth printing, because the usual cause is
  // a wrong `--from` rather than a quiet fortnight.
  console.error(`✗ no commits in ${range} — check the range; an empty changelog is almost always a wrong ref`);
  process.exit(2);
}

const entries = new Map(SECTIONS.map(([type]) => [type, []]));
const deprecations = [];
const breaking = [];
let unclassified = 0;

for (const record of lines) {
  const [hash, subject, body = ""] = record.split("\x1f");
  const match = /^(\w+)(\([^)]*\))?(!)?:\s*(.+)$/.exec(subject ?? "");
  if (match === null) {
    unclassified += 1;
    continue;
  }
  const [, type, scope, bang, description] = match;
  /**
   * `#123`, and not `#234b7e`.
   *
   * The first version matched `/#(\d+)/` and linked issue **234** for a commit about brand colours, because
   * `#234b7e` is a hex colour and its first three characters are digits. A changelog entry pointing at an
   * unrelated issue is worse than one pointing at nothing: a reader follows it and is misled rather than
   * unhelped. The lookahead requires the digits to end the token.
   */
  const issue = /#(\d+)(?![\w-])/.exec(`${description} ${body}`);
  const link = issue === null ? "" : ` ([#${issue[1]}](${REPO}/issues/${issue[1]}))`;
  const text = `${scope === undefined ? "" : `**${scope.slice(1, -1)}**: `}${description.replace(/\s*\(#\d+\)\s*$/, "")}${link} \`${hash?.slice(0, 8)}\``;

  if (bang === "!" || /^BREAKING CHANGE:/m.test(body)) breaking.push(text);
  for (const line of body.split("\n")) {
    const deprecated = /^Deprecated:\s*(.+)$/.exec(line.trim());
    if (deprecated !== null) deprecations.push(`${deprecated[1]}${link}`);
  }
  (entries.get(type) ?? entries.set(type, []).get(type)).push(text);
}

const version = arg("version");
const heading = version === undefined ? "## Unreleased" : `## ${version} — ${git(["log", "-1", "--format=%cs", to])}`;

const out = [heading, ""];
if (breaking.length > 0) {
  // First, always. A consumer scanning for "will this break me" should not have to read past the features.
  out.push("### Breaking", "", ...breaking.map((e) => `- ${e}`), "");
}
if (deprecations.length > 0) {
  out.push("### Deprecated", "", ...deprecations.map((e) => `- ${e}`), "");
}
for (const [type, title] of SECTIONS) {
  const items = entries.get(type) ?? [];
  if (items.length === 0) continue;
  out.push(`### ${title}`, "", ...items.map((e) => `- ${e}`), "");
}
if (unclassified > 0) {
  /**
   * Reported in the file itself, not only on stderr.
   *
   * A commit whose subject has no type is a commit missing from the changelog, and the person who would notice
   * is the reader rather than whoever ran the script. Hiding the count would make a partial changelog look
   * complete.
   */
  out.push(`_${unclassified} commit(s) had no conventional-commit type and are not listed above._`, "");
}

const path = arg("out") ?? "CHANGELOG.md";
writeFileSync(path, `${out.join("\n")}\n`);
console.log(`✓ ${path}: ${lines.length - unclassified} of ${lines.length} commits across ${range || "all history"}`);
if (unclassified > 0) console.log(`  ${unclassified} had no type and are listed as a count, not hidden`);
