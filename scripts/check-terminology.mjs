#!/usr/bin/env node
/**
 * One word per concept — REQ-035 (#184), SPEC #200, AC-3 and AC-4.
 *
 * "A concept with two names in one codebase has two meanings by the end of the year." A glossary is a document,
 * and documents do not stop anybody typing the other word, so this reads `docs/22-glossary.md` and enforces it.
 *
 * ## The glossary is the configuration
 *
 * The tables in that file *are* the rules — parsed, not duplicated here. A list here and a table there, neither
 * derived from the other, is the shape this repository keeps finding defects in: two things that must agree with
 * nothing making them. Editing the glossary changes what the pipeline allows, which is the only arrangement
 * under which the two cannot drift.
 *
 * ## What it asserts
 *
 * 1. Every term the glossary marks as **ours** appears somewhere in the code or documentation with that exact
 *    spelling, and its code identifier exists. A glossary that documents a word nobody uses is a word we made up
 *    in a document.
 * 2. No **rejected spelling** appears outside the paths the glossary allows for it.
 * 3. The glossary's own tables are non-empty, and the rejected words appear *in the glossary itself*. Both are
 *    the same guard: a table that lost its rows would make every rule vacuous and the check would go green.
 *
 * ## Why the rejected list is deliberately short
 *
 * Precision is the whole value. `workflow` is not on it although *flow* is our noun, because the word also means
 * a GitHub Actions workflow and a ShareFlow workflow, and a rule that fires 337 times on correct prose is a rule
 * somebody deletes within a week. The glossary states this; it is repeated here because the temptation to add a
 * fuzzy rule arrives later, when this comment is what is left of the reasoning.
 *
 * Exit codes: 0 clean, 1 a violation, 2 the check could not run. Never zero for "could not tell".
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GLOSSARY = "docs/22-glossary.md";

/** Where prose and code that we can actually edit live. */
const ROOTS = [
  "backend/src",
  "frontend/src",
  "shareflow/src",
  "examples/src",
  "services",
  "docs",
  "website/content",
  "evals",
  "scripts",
  "README.md",
];

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", ".claude", ".docusaurus", "coverage", "plan.archive"]);
const EXTENSIONS = [".ts", ".tsx", ".md", ".mjs"];

/**
 * History, excluded on purpose.
 *
 * `CHANGELOG.md` is generated from commit subjects, and a rejected word in one cannot be edited without
 * rewriting published history — so including it would make this check permanently red, and a check that can only
 * fail is a check people learn to ignore.
 */
const SKIP_FILES = new Set(["CHANGELOG.md", GLOSSARY]);

/**
 * The rule and its test have to name the words they forbid.
 *
 * Not an exemption anyone else gets: these two files are the enforcement, and one of them plants a rejected word
 * on purpose to prove the check catches it. Everything else in the repository is in scope.
 */
const SKIP_PREFIX = "scripts/check-terminology";

/**
 * Parse one markdown table out of a section, by heading.
 *
 * Rows only — the header and the `|---|` separator are dropped. Returns the cells with surrounding backticks and
 * whitespace stripped, because the glossary is written for a reader first.
 */
export const tableUnder = (markdown, heading) => {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return [];
  const rows = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith("## ")) break;
    if (!line.startsWith("|")) continue;
    if (/^\|[\s|:-]+\|$/.test(line)) continue;
    const cells = line
      .slice(1, line.endsWith("|") ? -1 : undefined)
      .split("|")
      .map((cell) => cell.trim());
    // The header row names its own columns; every real row's first cell is a term.
    if (/^(Term|Rejected)$/i.test(cells[0] ?? "")) continue;
    rows.push(cells);
  }
  return rows;
};

/** `` `CapabilityMap` `` → `CapabilityMap`; an em dash means "no identifier". */
export const identifier = (cell) => {
  const match = /`([A-Za-z_$][\w$]*)`/.exec(cell ?? "");
  return match ? match[1] : null;
};

/** `` `docs/`, `scripts/` `` → the two prefixes; an em dash means nowhere. */
export const allowedPaths = (cell) => [...(cell ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1]);

/**
 * A phrase, matched as words rather than as a substring.
 *
 * `crew` must not fire on "screw", and it must fire on "crews" — so the boundaries are explicit and a trailing
 * `s` is optional. Internal spaces become `\s+`, so a phrase broken across a line wrap is still caught: prose
 * wraps, and a rule that a line break defeats is a rule that fails exactly where prose is longest.
 */
export const phrasePattern = (phrase) =>
  new RegExp(`\\b${phrase.trim().split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")}s?\\b`, "gi");

const walk = (path, out = []) => {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return out;
  }
  if (stats.isFile()) {
    const skipped = SKIP_FILES.has(path) || path.startsWith(SKIP_PREFIX);
    if (EXTENSIONS.some((extension) => path.endsWith(extension)) && !skipped) out.push(path);
    return out;
  }
  for (const entry of readdirSync(path)) {
    if (SKIP_DIRS.has(entry)) continue;
    walk(join(path, entry), out);
  }
  return out;
};

const main = () => {
  let glossary;
  try {
    glossary = readFileSync(GLOSSARY, "utf8");
  } catch (error) {
    console.error(`✗ cannot read ${GLOSSARY}: ${error.message}`);
    console.error("  the glossary is this check's configuration; without it there are no rules to apply, and");
    console.error("  treating that as 'nothing to enforce' is how the check would go green having done nothing");
    return 2;
  }

  const ours = tableUnder(glossary, "Ours");
  const rejected = tableUnder(glossary, "Rejected spellings");
  if (ours.length < 3 || rejected.length < 3) {
    console.error(`✗ ${GLOSSARY} yielded ${ours.length} 'ours' rows and ${rejected.length} rejected rows`);
    console.error("  the tables are the rules. Too few means the format changed and this is enforcing nothing");
    return 2;
  }

  const files = ROOTS.flatMap((root) => walk(root));
  if (files.length < 50) {
    console.error(`✗ only ${files.length} files to scan — the roots are wrong, so a clean result means nothing`);
    return 2;
  }
  const sources = new Map(files.map((path) => [path, readFileSync(path, "utf8")]));

  const problems = [];

  // 1. A term that is ours must be a term we actually use.
  for (const row of ours) {
    const term = row[0];
    if (!term) continue;
    const pattern = phrasePattern(term);
    const used = [...sources.values()].some((source) => pattern.test(source));
    if (!used) {
      problems.push(
        `"${term}" is listed as ours and appears nowhere in the code or docs — either it is used under another` +
          ` spelling, which is the drift this file exists to catch, or it is a word invented in a document`,
      );
    }
    const name = identifier(row[1]);
    if (name) {
      const inCode = [...sources].some(
        ([path, source]) => (path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".mjs")) && source.includes(name),
      );
      if (!inCode) problems.push(`"${term}" claims the identifier \`${name}\`, which is not in the source`);
    }
  }

  // 2. A rejected spelling must appear only where the glossary allows it — and must appear in the glossary,
  //    or the row has quietly stopped meaning anything.
  for (const row of rejected) {
    const word = row[0];
    if (!word) continue;
    if (!phrasePattern(word).test(glossary)) {
      problems.push(`"${word}" is a rejected row whose own word is not in the glossary — the table is malformed`);
      continue;
    }
    const allowed = allowedPaths(row[2]);
    for (const [path, source] of sources) {
      if (allowed.some((prefix) => path.startsWith(prefix))) continue;
      const hits = [...source.matchAll(phrasePattern(word))];
      if (hits.length === 0) continue;
      const line = source.slice(0, hits[0].index).split("\n").length;
      problems.push(
        `${path}:${line} says "${hits[0][0]}" — rejected in favour of ${row[1] || "the glossary's term"}` +
          (hits.length > 1 ? ` (${hits.length} occurrences in this file)` : ""),
      );
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    console.error(`\n  ${problems.length} problem(s). Fix the prose, or change ${GLOSSARY} — it is the rules.`);
    return 1;
  }

  console.log(
    `✓ terminology holds: ${ours.length} terms of ours are in use, ${rejected.length} rejected spellings absent` +
      ` across ${files.length} files`,
  );
  return 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
