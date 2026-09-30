/**
 * A workflow step that pipes must not be able to report a success it did not have — #290.
 *
 * The case worth the file: a pipeline's exit status is its **last** command's. `node release-target.mjs … |
 * tee target.json` therefore reports `tee`'s success whatever the resolver decided. `agentkit@0.3.5` was
 * tagged on a main still declaring `0.3.4`; the resolver refused it in a sentence naming both versions and
 * exited 1, the step went green anyway, and the release died three steps later as
 * `npm publish -w --provenance` — a message naming neither the tag, the version nor the package.
 *
 * Nothing about that was a resolver bug. `release-target.test.mjs` already covers the mismatch, and that test
 * passed the whole time. The defect was one missing line of shell, which no unit test could see, so the check
 * belongs here: against the YAML itself.
 *
 * Deliberately a rule over every workflow rather than an assertion about the one line that broke. The next
 * `| tee`, `| jq` or `| head` will be written by someone who never read #290.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");

/** Each `run:` block in a workflow, with its step name, kept as raw text — this is a shell check, not YAML. */
const runBlocks = (yaml) => {
  const blocks = [];
  const lines = yaml.split("\n");
  let name = "(unnamed)";
  for (let i = 0; i < lines.length; i += 1) {
    const named = /^\s*-?\s*name:\s*(.+?)\s*$/.exec(lines[i]);
    if (named) name = named[1];
    const run = /^(\s*)run:\s*\|/.exec(lines[i]);
    if (!run) continue;
    const indent = run[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      // A blank line inside a block keeps the block; a non-blank line at or below the key's indent ends it.
      if (line.trim() !== "" && (line.length - line.trimStart().length) <= indent) break;
      body.push(line);
    }
    blocks.push({ name, body: body.join("\n") });
  }
  return blocks;
};

const workflows = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

test("every piping run block sets pipefail, so a failure cannot be reported as a success", () => {
  assert.ok(workflows.length > 0, "no workflows found — the check would pass vacuously");
  const offenders = [];
  for (const file of workflows) {
    for (const { name, body } of runBlocks(readFileSync(join(WORKFLOWS, file), "utf8"))) {
      // Comments stripped first: a `|` inside prose is not a pipeline, and this file's own comments say "| tee".
      const shell = body
        .split("\n")
        .map((l) => l.replace(/(^|\s)#.*$/, ""))
        .join("\n");
      // A real pipe, not `||`, not a YAML block marker.
      const pipes = /[^|\s]\s*\|(?!\|)\s*[^|\s]/.test(shell);
      if (pipes && !/set\s+-[a-z]*o\s+pipefail|set\s+-o\s+pipefail/.test(shell)) {
        offenders.push(`${file} → "${name}"`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these steps pipe without \`set -o pipefail\`, so a failing command reports the last command's success:\n  ${offenders.join("\n  ")}`,
  );
});

test("the publish step quotes the workspace, so a blank cannot swallow the next flag", () => {
  // `npm publish -w ${{ … }}` with an empty value became `npm publish -w --provenance`, and npm reported
  // "No workspaces found: --workspace=--provenance" — true, and three steps from the cause.
  const release = readFileSync(join(WORKFLOWS, "release.yml"), "utf8");
  // Anchored to `npm publish -w`, and comment lines dropped first: this file's own prose says "npm publish".
  const command = release
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .find((l) => /npm publish\s+-w/.test(l));
  assert.ok(command, "no `npm publish -w` step found in release.yml");
  assert.match(command, /-w\s+"\$\{\{/, `the workspace argument must be quoted, got:\n${command}`);
});
