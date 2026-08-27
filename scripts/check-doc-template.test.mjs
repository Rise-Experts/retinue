/**
 * Proves the template checker's two parsers and its ordering rule.
 *
 * The rule lives in `docs/25-doc-page-template.md`, so the parser that reads it is the part that can silently
 * stop enforcing anything: a table that changes shape yields no headings, and a checker with no headings passes
 * every page. Both directions are tested.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EXEMPT, headingsIn, offTemplate, requiredFrom } from "./check-doc-template.mjs";

test("the required sections are read from the template's own table, in order", () => {
  const required = requiredFrom(readFileSync("docs/25-doc-page-template.md", "utf8"));
  assert.deepEqual(required, [
    "## Tools",
    "## Wire it up",
    "## Credentials and scopes",
    "## Behaviour worth knowing",
    "## Limits",
  ]);
});

test("a table that changed shape yields nothing rather than a shorter rule", () => {
  // The failure worth catching: a parser that quietly finds fewer headings turns into a checker that passes
  // pages it should fail. `null` makes the caller exit 2 instead.
  assert.equal(requiredFrom("## Required sections\n\nno table here\n"), null);
  assert.equal(requiredFrom("# A document with no such section"), null);
});

test("only level-two headings count", () => {
  assert.deepEqual(headingsIn("# Title\n## One\n### Deeper\n## Two\n"), ["## One", "## Two"]);
});

test("a missing section is named, not counted", () => {
  const { missing } = offTemplate(["## Tools", "## Limits"], ["## Tools"]);
  assert.deepEqual(missing, ["## Limits"]);
});

test("the right sections in the wrong order is also off-template", () => {
  // Presence is not the whole rule. A page with all five in a different order still costs the reader the
  // orientation the template exists to remove.
  const { missing, misordered } = offTemplate(["## Tools", "## Limits"], ["## Limits", "## Tools"]);
  assert.deepEqual(missing, []);
  assert.equal(misordered, true);
});

test("a page that follows the template passes both halves", () => {
  const { missing, misordered } = offTemplate(["## Tools", "## Limits"], ["## Tools", "## Extra", "## Limits"]);
  assert.deepEqual(missing, []);
  assert.equal(misordered, false);
});

test("every exemption is a named page, not a pattern", () => {
  /**
   * A pattern is how an off-template tool page acquires an exemption by accident: "a guide that does not look
   * like a tool page" is a rule that stops covering the next tool page somebody writes as a guide.
   *
   * Exact, and it failed when the list grew — which is what an exact list is for.
   */
  assert.deepEqual([...EXEMPT], [
    "overview.md",
    "build-an-agent.md",
    "persistent-memory.md",
    "approvals-and-safety.md",
  ]);
});
