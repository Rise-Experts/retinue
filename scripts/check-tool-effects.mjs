#!/usr/bin/env node
/**
 * A tool whose name says it writes must not be classified as a read — REQ-047 (#206), task #214, AC-10.
 *
 * `effect` drives the approval gate and the idempotency requirement. Setting it to `read` on a tool that writes
 * skips both, and **nothing else in the build can notice**: `read` is a valid value, and the compiler has no
 * idea what the function does. Across the twenty-one toolkit packages `docs/23-tool-catalogue.md` plans, some
 * contributed, one mistyped field is a destructive call that never asked anybody.
 *
 * `confirms()` and `destroys()` make the safe thing shorter to write than the unsafe thing. This catches the case
 * where somebody wrote `defineTool` anyway.
 *
 * ## What it cannot catch, stated rather than implied
 *
 * A verb list is a heuristic. `resolve_ticket` closes a ticket and looks like a read; `get_export` might trigger
 * one. This catches the overwhelmingly common shape — an imperative verb in the name — and misses anything
 * named obliquely. It is a floor, not a proof, and it is worth having because the common shape is common.
 *
 * Exit codes: 0 clean, 1 a misclassified tool, 2 the check could not run.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where tools are defined. Toolkit packages are added here as they land. */
const ROOTS = ["backend/src/tools", "backend/src/knowledge", "shareflow/src/tools", "tools"];

/**
 * Verbs that mean a side effect, in the imperative form a tool name takes.
 *
 * Extendable, and the list lives here rather than in a doc so a change to it is a change to the check.
 */
export const WRITE_VERBS = [
  "create", "update", "delete", "remove", "send", "publish", "post", "merge", "archive",
  "upload", "write", "set", "add", "insert", "patch", "put", "close", "cancel", "approve",
  "assign", "invite", "revoke", "reset", "retry", "schedule", "transition", "comment", "reply",
];

/**
 * Deliberate exceptions, each with a reason.
 *
 * The pattern `check-boundaries` and `check-terminology` already use: an exemption is allowed and has to be
 * argued for in writing, so the decision survives the person who made it.
 */
export const EXEMPT = new Map([
  ["add_citations", "internal-write to this run's own parts; nothing leaves the tenant and there is nothing to approve"],
  ["set_session_state", "internal-write to the run's own scratch state, bounded by its own size ceiling"],
]);

/**
 * Verbs that mean the opposite, and win when they lead.
 *
 * `get_post_metrics` contains "post" and is a read; `validate_publish` contains "publish" and validates without
 * publishing. A leading read verb settles it, and without this rule the check fires on both — which is the
 * false-positive shape that gets a check deleted.
 */
export const READ_VERBS = [
  "get", "list", "search", "read", "fetch", "find", "describe", "count", "validate", "check", "preview", "query",
  // `propose_post_angles` returns suggestions and says "Writes nothing" in its own description — "post" there is
  // a noun. Verified against the implementation rather than exempted, because an exemption would have recorded
  // the symptom and left the rule wrong for the next `propose_*` tool.
  "propose", "suggest",
];

/**
 * Whether a name claims a side effect.
 *
 * **Segments 0 and 1**, not just the first. The first version checked only the leading segment, and the whole
 * catalogue convention is `<vendor>_<verb>_<object>` — so `github_create_issue` sailed straight past it. The
 * check was therefore doing nothing at all for the twenty-one toolkit packages it exists to protect, and passed
 * with the same count before and after the first one was added. That is what caught it.
 *
 * Segments 0 and 1 rather than every segment, because `get_post_metrics` has "post" at index 1 and is a read —
 * handled by READ_VERBS — while `owner_repo_delete_thing` is not a shape anybody writes.
 */
const looksLikeAWrite = (name) => {
  const segments = name.split("_");
  if (segments[0] !== undefined && READ_VERBS.includes(segments[0])) return false;
  return segments.slice(0, 2).some((segment) => WRITE_VERBS.includes(segment));
};

/**
 * Tool declarations in a source file: the name, and the effect if one is stated.
 *
 * Text rather than the type system, because the question is about a *string literal* somebody typed. A
 * declaration wrapped in `confirms()` or `destroys()` cannot state an effect at all — the type forbids it — so
 * those are recognised by the wrapper and never flagged.
 */
export const declarationsIn = (source) => {
  const found = [];

  // `confirms({ name: "x" … })` / `destroys({ … })` — classification comes from the wrapper and the type forbids
  // stating an effect, so these can never be misclassified.
  for (const match of source.matchAll(/\b(confirms|destroys)\s*\(\s*\{[\s\S]{0,400}?name:\s*"([a-z][a-z0-9_]*)"/g)) {
    const [, wrapper, name] = match;
    // A window forward from the name for `category:`. The wrapper decides the other three, always:
    // `confirms()` sets approval `always` and requires a key, `destroys()` the same plus `destructive`,
    // and the type forbids a caller restating any of them. So they are known, not parsed.
    const from = match.index ?? 0;
    found.push({
      name,
      effect: wrapper === "destroys" ? "destructive" : "external-write",
      via: wrapper,
      category: /category:\s*"([a-z-]+)"/.exec(source.slice(from, from + 800))?.[1],
      approvalPolicy: "always",
      requiresIdempotencyKey: true,
    });
  }

  /**
   * Everything else: each `name: "…"`, then the nearest `effect:` before the *next* declaration.
   *
   * Imperative rather than one regex. The regex version used a lazy window with a `(?=name:|$)` lookahead, which
   * fails outright when two declarations are further apart than the window — so it found **nothing** in
   * `shareflow/src/tools/publishing.ts` and the check reported a clean scan of 27 files with zero tools examined.
   * A check that passes having examined nothing is the failure this repository keeps finding, and it found it
   * here first.
   */
  const names = [...source.matchAll(/name:\s*"([a-z][a-z0-9_]*)"/g)];
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i][1];
    if (found.some((f) => f.name === name)) continue;
    const from = names[i].index ?? 0;
    const to = names[i + 1]?.index ?? source.length;
    const body = source.slice(from, to);
    const effect = /effect:\s*"([a-z-]+)"/.exec(body)?.[1];
    found.push({
      name,
      effect: effect ?? "read",
      via: effect ? "explicit" : "default",
      category: /category:\s*"([a-z-]+)"/.exec(body)?.[1],
      approvalPolicy: /approvalPolicy:\s*"([a-z-]+)"/.exec(body)?.[1],
      // Tri-state, not a boolean. `undefined` means the field is absent, which is how a *correct* tool is
      // written — the effect derives it. Collapsing absent to `false` reported all four existing publishing
      // tools as overriding it, which is the "check fires on correct code" shape.
      requiresIdempotencyKey: /requiresIdempotencyKey:\s*(true|false)/.exec(body)?.[1] === "true"
        ? true
        : /requiresIdempotencyKey:\s*false/.test(body)
          ? false
          : undefined,
    });
  }
  return found;
};

/**
 * A `| `name` | … |` table under a `###` heading in the catalogue.
 *
 * From the heading to the next heading, not to the next blank line. The first version stopped at `\n\n` and so
 * captured the *paragraph* between the heading and the table — an empty parse, caught by the floor in `main()`
 * rather than by silently asserting nothing about ten ungated tools.
 */
export const tableUnder = (markdown, heading) => {
  const start = markdown.indexOf(`### ${heading}`);
  if (start === -1) return [];
  const rest = markdown.slice(start + 1);
  const end = rest.search(/\n#{1,3} /);
  const rows = [];
  for (const line of rest.slice(0, end === -1 ? undefined : end).split("\n")) {
    // The header and separator rows have no backticked identifier in cell 0, which is what excludes them.
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2) continue;
    // A tool name, or a package wildcard like `tools-github/*` — see `scopeOf`.
    const name = /^`([a-z][a-z0-9_]*|[a-z][a-z0-9-]*\/\*)`$/.exec(cells[0])?.[1];
    if (name === undefined) continue;
    rows.push({ name, cells });
  }
  return rows;
};

/**
 * Whether the tool reaches outside this system at all. The floor's subject.
 */
const GATED = new Set(["external-write", "destructive"]);

/**
 * Which publishable unit a source file belongs to, so the floor can be excused per package.
 *
 * Twenty-one toolkits are planned and most of them are all writes — `tools-github` alone contributes twenty.
 * Twenty rows each saying "a repository write is not a broadcast" is not a record anybody reads, and an
 * unreadable table is the state a check gets deleted from. So a package may be excused once, with one reason.
 *
 * The safeguard is in `publishingProblems`: a package that contributes **any** row to the publishing table
 * cannot hold a wildcard. `tools-x` has to name its tools individually, and a broadcast tool added to it later
 * is a floor failure — while `tools-github`, which has no public-broadcast surface at all, says so once.
 */
export const scopeOf = (file) => {
  const parts = file.split("/");
  if (parts[0] === "tools" && parts[1] !== undefined) return `tools-${parts[1]}`;
  if (parts[0] === "backend") return "agentkit";
  return parts[0] ?? "unknown";
};

/**
 * #228: publishing does not get its own `ToolEffect`, and this is what took its place.
 *
 * Two lists in `docs/23`, and three assertions:
 *
 * 1. **The floor.** Every `external-write` or `destructive` tool appears in one of the two lists. This is the
 *    part that makes the rest airtight — publicness is not a function of the effect *or* the category
 *    (`reply_to_comment` is a public reply in the `engagement` category), so a name- or category-based rule
 *    would miss a broadcast tool whose author chose differently. Requiring every outward write to be triaged
 *    cannot be escaped by choosing a label.
 * 2. **The declared effect matches the document**, so the two cannot describe different tools.
 * 3. **The derivation was not overridden.** `defineTool` derives `approvalPolicy: "always"` and
 *    `requiresIdempotencyKey: true` from those two effects, so the pairing holds by construction and the only
 *    way to break it is an explicit `approvalPolicy: "never"` beside a publishing effect. That is what this
 *    looks for — not the *absence* of the fields, which is the normal and correct way to write one.
 *
 * Tools that are specified but not yet built are checked against the document only. Five of the six planned
 * packages are unwritten, and binding the specification is the point: the constraint is in force when
 * `tools-x` lands, rather than being added afterwards by somebody who has to notice it is missing.
 */
export const publishingProblems = (publishing, exempt, declared) => {
  const problems = [];
  const byName = new Map(declared.map((tool) => [tool.name, tool]));
  const expected = new Map(publishing.map((row) => [row.name, row.cells[2]?.replaceAll("`", "")]));

  for (const [name, effect] of expected) {
    const tool = byName.get(name);
    if (tool === undefined) continue; // Not built yet — specified, and not further verifiable.
    if (!GATED.has(effect)) {
      problems.push(`docs/23 lists ${name} as publishing with effect "${effect}" — must be external-write or destructive`);
    }
    if (tool.effect !== effect) {
      problems.push(`${name} declares effect "${tool.effect}" and docs/23 says "${effect}"`);
    }
    if (tool.approvalPolicy !== undefined && tool.approvalPolicy !== "always") {
      problems.push(
        `${name} publishes publicly and overrides the derived approval policy with "${tool.approvalPolicy}" — ` +
          "remove the override and the effect alone gives it `always`",
      );
    }
    if (tool.requiresIdempotencyKey === false) {
      problems.push(`${name} publishes publicly and overrides requiresIdempotencyKey to false — a retry would post twice`);
    }
  }

  const named = new Set([...expected.keys(), ...exempt.filter((row) => !row.name.endsWith("/*")).map((row) => row.name)]);
  const wildcards = new Set(exempt.filter((row) => row.name.endsWith("/*")).map((row) => row.name.slice(0, -2)));

  // A package cannot both publish and be excused wholesale — that is the loophole the wildcard would otherwise
  // open, and it is the one that matters, because the packages with a publishing surface are the risky ones.
  for (const row of publishing) {
    const scope = row.cells[1]?.replaceAll("`", "");
    if (scope !== undefined && wildcards.has(scope)) {
      problems.push(
        `docs/23 excuses all of ${scope} with a wildcard and also lists ${row.name} as publishing — a package ` +
          "with a publishing surface must name its outward writes individually",
      );
    }
  }

  for (const tool of declared) {
    if (!GATED.has(tool.effect) || named.has(tool.name)) continue;
    if (tool.scope !== undefined && wildcards.has(tool.scope)) continue;
    problems.push(
      `${tool.name} is "${tool.effect}" and appears in neither list in docs/23 — add it to "The publishing ` +
        'tools" if it reaches strangers, or to "External writes that are not publishing" with the reason ' +
        `(a whole package can be excused once, as \`${tool.scope ?? "package"}/*\`, if none of it broadcasts)`,
    );
  }
  return problems;
};

const CATALOGUE = "docs/23-tool-catalogue.md";

const walk = (path, out = []) => {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return out;
  }
  if (stats.isFile()) {
    if (path.endsWith(".ts") && !path.includes(".test.") && !path.includes("__tests__")) out.push(path);
    return out;
  }
  for (const entry of readdirSync(path)) {
    if (entry === "node_modules" || entry === "dist") continue;
    walk(join(path, entry), out);
  }
  return out;
};

const main = () => {
  const files = ROOTS.flatMap((root) => walk(root));
  if (files.length < 10) {
    console.error(`✗ only ${files.length} source files to scan — the roots are wrong, so a clean result means nothing`);
    return 2;
  }

  const problems = [];
  const declared = [];
  let checked = 0;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const declaration of declarationsIn(source)) {
      declared.push({ ...declaration, scope: scopeOf(file) });
      if (!looksLikeAWrite(declaration.name)) continue;
      checked += 1;
      if (declaration.effect !== "read") continue;
      if (EXEMPT.has(declaration.name)) continue;
      problems.push(
        `${file}: ${declaration.name} reads as a write and is classified "read"` +
          (declaration.via === "default" ? " (by default — no effect was stated)" : ""),
      );
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    console.error("\n  `read` means no approval gate and no idempotency key. Use `confirms()` or `destroys()`,");
    console.error("  or add an entry to EXEMPT in scripts/check-tool-effects.mjs with the reason.");
    return 1;
  }

  const catalogue = readFileSync(CATALOGUE, "utf8");
  const expected = tableUnder(catalogue, "The publishing tools");
  const exempt = tableUnder(catalogue, "External writes that are not publishing");
  if (expected.length === 0 || exempt.length === 0) {
    console.error(`✗ parsed ${expected.length} publishing and ${exempt.length} non-publishing tool(s) from ${CATALOGUE} —`);
    console.error("  a table moved or changed shape, and an empty expectation passes every assertion below it.");
    console.error("  Fix the parser, not the document.");
    return 2;
  }
  const problemsWithPublishing = publishingProblems(expected, exempt, declared);
  if (problemsWithPublishing.length > 0) {
    for (const problem of problemsWithPublishing) console.error(`✗ ${problem}`);
    console.error("\n  Publishing tools reach strangers under the operator's brand. #228 decided the effect stays");
    console.error("  `external-write`, and that the gated set is the exact list in docs/23 instead — because");
    console.error("  neither the effect nor the category sorts public from private. See the decision there.");
    return 1;
  }

  const built = expected.filter((row) => declared.some((tool) => tool.name === row.name)).length;
  const outward = declared.filter((tool) => GATED.has(tool.effect)).length;
  console.log(`✓ ${checked} write-named tool(s) are classified as writes across ${files.length} files, ${EXEMPT.size} exempt`);
  console.log(
    `✓ ${outward} outward write(s) all triaged in docs/23: ${expected.length} publishing specified ` +
      `(${built} built, gated, derivation intact), ${exempt.length} explicitly not`,
  );
  return 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
