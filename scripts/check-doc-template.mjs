#!/usr/bin/env node
/**
 * Every integration page has the same shape — REQ-048 (#207), task #217, AC-4.
 *
 * The required sections and their order come from `docs/25-doc-page-template.md`, not from a list in this file.
 * That is deliberate and it is the same arrangement `check:terminology` has with the glossary: the document a
 * human reads is the source of truth, so the rule and its explanation cannot drift apart. A checker with its own
 * private copy of the rule is a checker that eventually enforces something the documentation denies.
 *
 * Exit codes: 0 clean, 1 a page off-template, 2 the check could not run.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE = "docs/25-doc-page-template.md";

/**
 * Where the tool pages are.
 *
 * `guides/tools.md` is in here because it is a tool page in everything but its folder: it documents the kit's own
 * tools, and a reader arriving from an integration page should find the same five sections in the same order. A
 * template that covered only the pages that happened to be written after it was specified would be a template
 * for new pages, which is not what AC-4 asked for.
 */
const PAGE_DIRS = ["website/content/integrations", "website/content/guides"];

/**
 * The section index, exempt **by name**.
 *
 * Named here rather than pattern-matched, because "any page that does not look like a tool page" is how an
 * off-template page acquires an exemption by accident.
 */
export const EXEMPT = new Set([
  // The integrations section index: a list of the tool pages, not one of them.
  "overview.md",
  // Guides that are not about tools. Named individually, because "a guide that does not look like a tool page"
  // is how an off-template tool page acquires an exemption by accident.
  "build-an-agent.md",
  "persistent-memory.md",
  "approvals-and-safety.md",
]);

/** The required headings, read from the template's table in the order they appear there. */
export const requiredFrom = (markdown) => {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === "## Required sections");
  if (start === -1) return null;
  const headings = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index].trim();
    // Stop at the next section, so a later table cannot contribute rows.
    if (index > start && line.startsWith("## ")) break;
    const match = /^\|\s*`(## [^`]+)`\s*\|/.exec(line);
    if (match !== null) headings.push(match[1]);
  }
  return headings.length === 0 ? null : headings;
};

/** The `##` headings a page actually has, in order. Deeper headings are the page's own business. */
export const headingsIn = (markdown) =>
  markdown
    .split("\n")
    .filter((line) => /^##\s/.test(line))
    .map((line) => line.trim());

/**
 * Which required headings are missing, and whether the ones present are in the template's order.
 *
 * Order matters as much as presence: a page that has all five in a different order still costs the reader the
 * orientation the template exists to remove.
 */
export const offTemplate = (required, actual) => {
  const missing = required.filter((heading) => !actual.includes(heading));
  const present = required.filter((heading) => actual.includes(heading));
  const positions = present.map((heading) => actual.indexOf(heading));
  const ordered = positions.every((position, index) => index === 0 || position > positions[index - 1]);
  return { missing, misordered: !ordered };
};

const main = () => {
  let required;
  try {
    required = requiredFrom(readFileSync(TEMPLATE, "utf8"));
  } catch (error) {
    console.error(`✗ cannot read ${TEMPLATE}: ${error.message}`);
    console.error("  the template is the rule; without it this check has nothing to enforce, and treating that");
    console.error("  as 'nothing to do' is how a check passes having looked at nothing");
    return 2;
  }
  if (required === null) {
    console.error(`✗ ${TEMPLATE} has no readable "Required sections" table — the rule moved`);
    return 2;
  }

  const pages = [];
  for (const dir of PAGE_DIRS) {
    let names;
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
    } catch (error) {
      console.error(`✗ cannot read ${dir}: ${error.message}`);
      return 2;
    }
    for (const name of names) pages.push({ dir, name, path: `${dir}/${name}` });
  }

  const checked = pages.filter((page) => !EXEMPT.has(page.name));
  if (checked.length === 0) {
    console.error(`✗ every tool page is exempt, so this check examined nothing`);
    return 2;
  }

  const problems = [];
  for (const page of checked) {
    const { missing, misordered } = offTemplate(required, headingsIn(readFileSync(page.path, "utf8")));
    if (missing.length > 0) problems.push(`${page.path} is missing ${missing.join(", ")}`);
    if (misordered) problems.push(`${page.path} has the required sections out of the template's order`);
  }

  if (problems.length > 0) {
    console.error(`✗ ${problems.length} integration page(s) are off-template:`);
    for (const problem of problems) console.error(`  · ${problem}`);
    console.error(`  the shape is specified in ${TEMPLATE}. A reader learns it once and then reads every page`);
    console.error("  quickly; a page that deviates costs them that, and the section usually skipped is Limits");
    return 1;
  }

  console.log(
    `✓ ${checked.length} tool page(s) follow the ${required.length}-section template in ${TEMPLATE}` +
      ` (${pages.length - checked.length} exempt: ${[...EXEMPT].join(", ")})`,
  );
  return 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
