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
  for (const [, wrapper, name] of source.matchAll(/\b(confirms|destroys)\s*\(\s*\{[\s\S]{0,400}?name:\s*"([a-z][a-z0-9_]*)"/g)) {
    found.push({ name, effect: wrapper === "destroys" ? "destructive" : "external-write", via: wrapper });
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
    found.push({ name, effect: effect ?? "read", via: effect ? "explicit" : "default" });
  }
  return found;
};

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
  let checked = 0;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const declaration of declarationsIn(source)) {
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

  console.log(`✓ ${checked} write-named tool(s) are classified as writes across ${files.length} files, ${EXEMPT.size} exempt`);
  return 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
