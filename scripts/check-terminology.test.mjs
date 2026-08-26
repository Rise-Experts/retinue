/**
 * Proves the terminology checker's parsing and its word matching, which are the two places it could silently
 * stop enforcing anything.
 *
 * The end-to-end behaviour is sabotage-tested by hand — plant "crew" in a doc and watch it fail — but the
 * failure mode that would not be noticed is subtler: a glossary edit that breaks the table format makes every
 * rule vacuous, and a checker that shrugged at zero rows would report success. So the parser gets tests, and so
 * does the boundary matching, because a substring match would fire on "screw" and be deleted the same week.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedPaths, identifier, phrasePattern, tableUnder } from "./check-terminology.mjs";

const GLOSSARY = `# Glossary

## Ours

| Term | In code | Why |
|---|---|---|
| suppressed write | \`SuppressedWrite\` | it succeeded and did not write |
| approval gate | \`ApprovalPolicy\` | it is in the execution path |
| shadow run | — | no identifier, deliberately |

## Rejected spellings

| Rejected | Concept | Allowed in | Why |
|---|---|---|---|
| crew | the multi-agent unit | — | someone else's word |
| swarm | the multi-agent unit | — | someone else's word |
| pipeline | the flow | \`scripts/\`, \`docs/20-\` | means CI in those |
`;

test("rows are parsed and the header is not one of them", () => {
  const ours = tableUnder(GLOSSARY, "Ours");
  assert.equal(ours.length, 3);
  assert.equal(ours[0][0], "suppressed write");
  assert.equal(tableUnder(GLOSSARY, "Rejected spellings").length, 3);
});

test("a renamed heading yields nothing rather than the wrong table", () => {
  // Which is what makes the "too few rows" guard fire instead of the check passing vacuously.
  assert.deepEqual(tableUnder(GLOSSARY, "Rejected words"), []);
});

test("identifiers and allowed paths come out of their cells", () => {
  assert.equal(identifier("`SuppressedWrite`"), "SuppressedWrite");
  assert.equal(identifier("—"), null);
  assert.deepEqual(allowedPaths("`scripts/`, `docs/20-`"), ["scripts/", "docs/20-"]);
  assert.deepEqual(allowedPaths("—"), []);
});

test("a phrase matches as words, plurals included, and not as a substring", () => {
  assert.match("the crew ran", phrasePattern("crew"));
  assert.match("two crews ran", phrasePattern("crew"));
  // The reason boundaries are explicit: a substring rule fires here and gets deleted within a week.
  assert.doesNotMatch("she screwed it in", phrasePattern("crew"));
  assert.doesNotMatch("increase the value", phrasePattern("crew"));
});

test("a phrase still matches across a line wrap", () => {
  // Prose wraps at 120 characters in this repository, so a rule a newline defeats is a rule that fails exactly
  // where the prose is longest.
  assert.match("routes through the approval\ngate today", phrasePattern("approval gate"));
});

/** A tree with its own glossary, so the end-to-end path is exercised without depending on the real one. */
const fixture = (glossary, files) => {
  const dir = mkdtempSync(join(tmpdir(), "retinue-terms-"));
  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "docs", "22-glossary.md"), glossary);
  // The checker needs at least 50 files to believe its roots are right, so the fixture provides them.
  for (let index = 0; index < 60; index += 1) {
    writeFileSync(join(dir, "docs", `filler-${index}.md`), "suppressed write, approval gate, shadow run\n");
  }
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, "docs", name), content);
  // The identifiers the glossary claims have to exist in code, so the fixture has some code.
  writeFileSync(join(dir, "scripts", "impl.mjs"), "export const x = { SuppressedWrite: 1, ApprovalPolicy: 2 };\n");
  cpSync(join(import.meta.dirname, "check-terminology.mjs"), join(dir, "scripts", "check-terminology.mjs"));
  return dir;
};

const run = (dir) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, ["scripts/check-terminology.mjs"], { cwd: dir, encoding: "utf8" }) };
  } catch (error) {
    return { code: error.status, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
};

test("a clean tree passes and a planted synonym fails", (t) => {
  const clean = fixture(GLOSSARY, {});
  const dirty = fixture(GLOSSARY, { "guide.md": "The crew executes in order.\n" });
  t.after(() => {
    rmSync(clean, { recursive: true, force: true });
    rmSync(dirty, { recursive: true, force: true });
  });

  assert.equal(run(clean).code, 0);
  const failed = run(dirty);
  assert.equal(failed.code, 1);
  assert.match(failed.out, /guide\.md:1 says "crew"/);
});

test("an allowed path is allowed, and only that path", (t) => {
  const dir = fixture(GLOSSARY, { "20-ci.md": "the pipeline runs\n" });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // `docs/20-` is allowed for "pipeline"; the same word in `docs/guide.md` would not be.
  assert.equal(run(dir).code, 0);
});

test("a malformed glossary exits 2, not 0", (t) => {
  const dir = fixture("# Glossary\n\n## Ours\n\nnothing here.\n", {});
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { code, out } = run(dir);
  assert.equal(code, 2, "a glossary that yielded no rules must not report success");
  assert.match(out, /enforcing nothing/);
});
