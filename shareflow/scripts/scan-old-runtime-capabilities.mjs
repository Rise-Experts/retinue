/**
 * Extract the old runtime's capability surface from its source — REQ-041 AC-1 (#190).
 *
 * The inventory in `src/inventory/capabilities.ts` is a set of claims about another repository. Before this
 * script existed they were **unverifiable claims**, and the first run of it found that most of them named
 * nothing: entries for `post_writer`, `publish_guard`, `campaigns.create`, cron `publish_due_posts` and
 * `POST /webhooks/:platform/comments`, none of which exist in `social_integgration`. An inventory that
 * validates cleanly while describing a runtime that is not there is worse than no inventory — it is the
 * "did not look" that reads as "clean", one level up from the reference scan that taught the lesson.
 *
 * So the inventory is no longer written from memory. This reads the real thing:
 *
 * - `ai_backend/app/assistant/tools.py`   — every `@tool()` and whether it is confirmation-gated
 * - `ai_backend/app/assistant/{agent,studio,specialists}.py`, `factory.py` — which agent carries which tools
 * - `ai_backend/app/main.py`              — the HTTP surface, which is a capability surface too
 * - `ai_backend/skills/`                  — the instruction sets, for AC-5
 * - `web/src/app/api/**` (webhooks)       — inbound paths nobody shadows
 * - `supabase/migrations/*.sql`           — `cron.schedule` calls, which is where the scheduled work actually is
 *
 * ## Why every extractor has a minimum
 *
 * A regex that stops matching after an upstream refactor reports **zero**, and zero old capabilities means an
 * inventory covering all of them. That failure is silent and it points the wrong way, so each extractor
 * declares the smallest count that could be true and the scan **refuses** below it. Same for a missing file:
 * exit 2 for "could not scan", never a smaller manifest.
 *
 * Read-only by construction: it opens files and prints. `social_integgration` is a separate repository and,
 * per the runbook, a separate reviewed change.
 *
 * Usage:
 *   node scripts/scan-old-runtime-capabilities.mjs [--root <path>] [--json]
 *   node scripts/scan-old-runtime-capabilities.mjs --write src/inventory/old-runtime.ts
 *   node scripts/scan-old-runtime-capabilities.mjs --check      # committed snapshot vs the live source
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const asJson = args.includes("--json");
const check = args.includes("--check");
const writeTo = flag("write");

/**
 * Where the old runtime is, found rather than assumed.
 *
 * A single hard-coded default is what made the reference scan in `scan-old-runtime.mjs` unrunnable on this
 * machine: it resolved one directory too far up, landed on a `social_integgration` that holds only `supabase`,
 * and died with "configured roots do not exist" — the right refusal for the wrong reason, and its docstring
 * then generalised the local misconfiguration into a claim that the paths do not exist anywhere.
 *
 * So the candidates are tried in order and the first one carrying the marker wins. When none does, the error
 * lists every path tried, because "I looked in these three places" is actionable where "not found" is not.
 */
const MARKER = "ai_backend/app/assistant/tools.py";
/**
 * An explicit path is the **only** candidate when one is given.
 *
 * Falling through from a named `--root` to a guessed sibling was a real defect and the test above caught it:
 * the scan silently read a different checkout from the one the operator asked for, and reported success. For a
 * script whose whole output is "this is what the old runtime is", answering about the wrong repository is worse
 * than answering "not found".
 */
const explicit = flag("root") ?? process.env.RETINUE_OLD_RUNTIME_ROOT;
const CANDIDATES =
  explicit !== undefined
    ? [explicit]
    : [
        resolve(import.meta.dirname, "../../..", "social_integgration"),
        resolve(import.meta.dirname, "../../../..", "social_integgration"),
      ];

let root;
for (const candidate of CANDIDATES) {
  try {
    await stat(join(resolve(candidate), MARKER));
    root = resolve(candidate);
    break;
  } catch {
    // Next candidate. A directory that exists but does not carry the marker is not the old runtime — which is
    // exactly the case the decoy checkout produces.
  }
}
if (root === undefined) {
  console.error("✗ the old runtime is not at any path tried, so nothing can be extracted");
  console.error(`  marker: ${MARKER}`);
  for (const candidate of CANDIDATES) console.error(`  tried:  ${resolve(candidate)}`);
  console.error("  fix:    pass --root <path> or set RETINUE_OLD_RUNTIME_ROOT");
  process.exit(2);
}
const SNAPSHOT = resolve(import.meta.dirname, "../src/inventory/old-runtime.ts");

const die = (message, detail) => {
  if (asJson) console.log(JSON.stringify({ ok: false, error: message, ...detail }, null, 2));
  else {
    console.error(`✗ ${message}`);
    for (const [k, v] of Object.entries(detail ?? {})) {
      console.error(`  ${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
    }
  }
  // 2, not 1: a caller reading only the exit code has to be able to tell "could not scan" from "scanned and
  // found a divergence". The first is a broken invocation; the second is information.
  process.exit(2);
};

const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const read = async (rel) => {
  const path = join(root, rel);
  if (!(await exists(path))) {
    die("a source the inventory is derived from is not here, so nothing can be extracted", {
      looked: path,
      fix: "pass --root <path> or set RETINUE_OLD_RUNTIME_ROOT",
    });
  }
  return readFile(path, "utf8");
};

/**
 * The identifiers inside the next balanced `[ … ]` after `from`.
 *
 * Balanced rather than a greedy match to the next `]`, because a tools list contains no nesting today and
 * would silently truncate at the first inner bracket the day it does. Comments are stripped first so a name
 * mentioned in prose is not read as a member.
 */
const bracketedIdentifiers = (src, from) => {
  const open = src.indexOf("[", from);
  if (open === -1) return [];
  let depth = 0;
  let close = -1;
  for (let at = open; at < src.length; at += 1) {
    if (src[at] === "[") depth += 1;
    else if (src[at] === "]") {
      depth -= 1;
      if (depth === 0) {
        close = at;
        break;
      }
    }
  }
  if (close === -1) return [];
  return src
    .slice(open + 1, close)
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join(",")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^[A-Za-z_]\w*$/.test(part));
};

const lineOf = (src, index) => src.slice(0, index).split("\n").length;

/** Nothing below this could be true of a live product, so a smaller count means the extractor broke. */
const MINIMUMS = { tools: 25, agents: 8, routes: 10, skills: 5, webhooks: 3, scheduled: 1 };

const short = (rel, src, index) => `${rel}:${lineOf(src, index)}`;

// ---- tools ------------------------------------------------------------------------------------------------

const TOOLS_FILE = "ai_backend/app/assistant/tools.py";
const toolsSrc = await read(TOOLS_FILE);

/**
 * `confirmationStated` records what the decorator *says*, and the derived flag is separate.
 *
 * A bare `@tool()` is not the same fact as `@tool(requires_confirmation=False)`, and flattening them would
 * hide that half the surface never stated it. The default is not mine to assume either: the old runtime's own
 * test reads it as `getattr(fn, "requires_confirmation", False)`
 * (`ai_backend/tests/assistant/test_factory_and_studio.py`), so absent means False **by its own reading**, and
 * that citation is what makes the derived value evidence rather than a guess.
 */
const tools = [...toolsSrc.matchAll(/@tool\(([^)]*)\)\s*\n\s*(?:async\s+)?def\s+(\w+)\s*\(/g)].map((m) => {
  const stated = /requires_confirmation\s*=\s*(True|False)/.exec(m[1]);
  return {
    name: m[2],
    confirmationStated: stated === null ? "absent" : stated[1] === "True" ? "true" : "false",
    requiresConfirmation: stated !== null && stated[1] === "True",
    source: short(TOOLS_FILE, toolsSrc, m.index),
  };
});

const TOOL_NAMES = new Set(tools.map((t) => t.name));

// ---- agents -----------------------------------------------------------------------------------------------

/**
 * Which agent carries which tools, because the composition is part of the contract.
 *
 * Six specialists behind a coordinating team is a different product from one agent with every tool, even when
 * the tool lists match exactly — and that difference produces *identical write sets* on every run where the
 * routing happened to land in the same place. AC-5 calls this "prompts and instructions"; the tool-to-agent
 * assignment is the part of it that can be extracted rather than read.
 */
const agents = [];

const AGENT_FILE = "ai_backend/app/assistant/agent.py";
const agentSrc = await read(AGENT_FILE);
for (const m of agentSrc.matchAll(/id="([\w-]+)"/g)) {
  const list = bracketedIdentifiers(agentSrc, agentSrc.indexOf("tools=", m.index));
  if (list.length === 0) continue;
  agents.push({
    id: m[1],
    kind: "generalist",
    tools: list.filter((name) => TOOL_NAMES.has(name)),
    source: short(AGENT_FILE, agentSrc, m.index),
  });
}

const SPECIALISTS_FILE = "ai_backend/app/assistant/specialists.py";
const specialistsSrc = await read(SPECIALISTS_FILE);
for (const m of specialistsSrc.matchAll(/_base\(\s*\n?\s*"([\w-]+)",\s*\n?\s*"([^"]+)",/g)) {
  agents.push({
    id: m[1],
    kind: "specialist",
    tools: bracketedIdentifiers(specialistsSrc, specialistsSrc.indexOf("tools=", m.index)).filter((name) =>
      TOOL_NAMES.has(name),
    ),
    source: short(SPECIALISTS_FILE, specialistsSrc, m.index),
  });
}
for (const m of specialistsSrc.matchAll(/Team\(\s*\n\s*id="([\w-]+)"/g)) {
  agents.push({
    id: m[1],
    kind: "team",
    // A team's own tool list is empty; its members carry them. Recorded as such rather than omitted, so the
    // difference between "a team with no tools" and "an agent we failed to parse" stays visible.
    tools: [],
    source: short(SPECIALISTS_FILE, specialistsSrc, m.index),
  });
}

const STUDIO_FILE = "ai_backend/app/assistant/studio.py";
const studioSrc = await read(STUDIO_FILE);
const FACTORY_FILE = "ai_backend/app/assistant/factory.py";
const factorySrc = await read(FACTORY_FILE);
const studioId = /id="(chorus-studio)"/.exec(factorySrc);
if (studioId !== null) {
  agents.push({
    id: studioId[1],
    kind: "generalist",
    tools: bracketedIdentifiers(studioSrc, studioSrc.indexOf("return [")).filter((name) => TOOL_NAMES.has(name)),
    source: short(FACTORY_FILE, factorySrc, studioId.index),
  });
}

// ---- HTTP routes ------------------------------------------------------------------------------------------

const MAIN_FILE = "ai_backend/app/main.py";
const mainSrc = await read(MAIN_FILE);
const routes = [...mainSrc.matchAll(/@app\.(get|post|put|patch|delete)\(\s*\n?\s*"([^"]+)"/g)].map((m) => ({
  method: m[1].toUpperCase(),
  path: m[2],
  source: short(MAIN_FILE, mainSrc, m.index),
}));

// ---- skills -----------------------------------------------------------------------------------------------

const SKILLS_DIR = "ai_backend/skills";
if (!(await exists(join(root, SKILLS_DIR)))) {
  die("the old runtime's skills directory is not here, so AC-5's instruction sets cannot be enumerated", {
    looked: join(root, SKILLS_DIR),
  });
}
const skills = [];
for (const entry of await readdir(join(root, SKILLS_DIR), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  // A directory without SKILL.md is not a skill. Requiring the file is what stops a stray folder inflating
  // the count and making the instruction mapping look more complete than it is.
  if (await exists(join(root, SKILLS_DIR, entry.name, "SKILL.md"))) {
    skills.push({ name: entry.name, source: `${SKILLS_DIR}/${entry.name}/SKILL.md` });
  }
}
skills.sort((a, b) => a.name.localeCompare(b.name));

// ---- webhooks ---------------------------------------------------------------------------------------------

/**
 * Inbound paths, which are the ones no shadow run ever produces.
 *
 * They live in the Next app rather than `ai_backend` — a fact the previous inventory got wrong in the other
 * direction, naming a `POST /webhooks/:platform/comments` on the Python service that does not exist. Found by
 * walking the route tree rather than listed, so a new one cannot arrive uninventoried.
 */
const API_DIR = "web/src/app/api";
if (!(await exists(join(root, API_DIR)))) {
  die("the web app's route tree is not here, so inbound webhook paths cannot be enumerated", {
    looked: join(root, API_DIR),
  });
}
const webhooks = [];
const walkRoutes = async (dir) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkRoutes(path);
      continue;
    }
    if (entry.name !== "route.ts" && entry.name !== "route.tsx") continue;
    const rel = relative(join(root, API_DIR), dir).split("/");
    if (!rel.some((segment) => segment === "webhooks" || segment === "webhook")) continue;
    const src = await readFile(path, "utf8");
    const methods = [...src.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map(
      (m) => m[1],
    );
    webhooks.push({
      path: `/api/${rel.join("/")}`,
      methods: methods.sort(),
      source: relative(root, path),
    });
  }
};
await walkRoutes(join(root, API_DIR));
webhooks.sort((a, b) => a.path.localeCompare(b.path));

// ---- scheduled work ---------------------------------------------------------------------------------------

/**
 * `cron.schedule` calls in the migrations, which is where the scheduled work is.
 *
 * Read from the migrations rather than from `cron.job` in a database: a live table says what one machine
 * happens to have, and the inventory has to be reviewable from the repository. Later `cron.unschedule` of the
 * same name wins, so a job that was removed is not reported as live.
 */
const MIGRATIONS_DIR = "supabase/migrations";
if (!(await exists(join(root, MIGRATIONS_DIR)))) {
  die("the migrations directory is not here, so scheduled work cannot be enumerated", {
    looked: join(root, MIGRATIONS_DIR),
  });
}
const scheduled = new Map();
const migrations = (await readdir(join(root, MIGRATIONS_DIR))).filter((f) => f.endsWith(".sql")).sort();
for (const file of migrations) {
  const src = await readFile(join(root, MIGRATIONS_DIR, file), "utf8");
  for (const m of src.matchAll(/cron\.schedule\(\s*\n?\s*'([^']+)',\s*\n?\s*'([^']+)',\s*\n?\s*\$cron\$([\s\S]*?)\$cron\$/g)) {
    scheduled.set(m[1], {
      job: m[1],
      schedule: m[2],
      command: m[3].trim(),
      source: `${MIGRATIONS_DIR}/${file}:${lineOf(src, m.index)}`,
    });
  }
  for (const m of src.matchAll(/cron\.unschedule\(\s*'([^']+)'\s*\)/g)) {
    // Only when nothing re-schedules it later in the same file: the sweep migration unschedules then
    // reschedules under one name so a re-run cannot leave two behind.
    const rescheduled = new RegExp(`cron\\.schedule\\(\\s*\\n?\\s*'${m[1]}'`).test(src.slice(m.index));
    if (!rescheduled) scheduled.delete(m[1]);
  }
}

// ---- the manifest -----------------------------------------------------------------------------------------

const manifest = {
  repository: "social_integgration",
  tools,
  agents,
  routes,
  skills,
  webhooks,
  scheduled: [...scheduled.values()].sort((a, b) => a.job.localeCompare(b.job)),
};

const counts = {
  tools: tools.length,
  agents: agents.length,
  routes: routes.length,
  skills: skills.length,
  webhooks: webhooks.length,
  scheduled: manifest.scheduled.length,
};

const tooFew = Object.entries(MINIMUMS).filter(([key, minimum]) => counts[key] < minimum);
if (tooFew.length > 0) {
  die("an extractor found fewer than could possibly be true, so the source moved and the scan is wrong", {
    found: tooFew.map(([key]) => `${key}=${counts[key]}`),
    expectedAtLeast: tooFew.map(([key, minimum]) => `${key}>=${minimum}`),
    why: "a zero here would mean an old runtime with no capabilities, and an inventory covering all of them",
    fix: "update the extractor in this script against the current source, then re-run --write",
  });
}

// ---- output -----------------------------------------------------------------------------------------------

const HEADER = `/**
 * The old runtime's capability surface, extracted from its source — REQ-041 AC-1 (#190).
 *
 * **Generated. Do not edit.** Produced by \`scripts/scan-old-runtime-capabilities.mjs --write\`, which reads
 * \`social_integgration\` and refuses rather than reporting a smaller old runtime when it cannot.
 *
 * Committed so the inventory tests run without that repository checked out, and so a change to the old runtime
 * arrives as a **reviewable diff** instead of silently widening the gap the inventory claims to have closed.
 * \`npm run scan:old-runtime-capabilities -- --check\` fails when this file and the source disagree.
 */

import type { OldRuntimeManifest } from "./manifest.js";

export const OLD_RUNTIME_MANIFEST: OldRuntimeManifest = `;

const asModule = `${HEADER}${JSON.stringify(manifest, null, 2)} as const;\n`;

if (check) {
  if (!(await exists(SNAPSHOT))) die("no committed snapshot to check against", { looked: SNAPSHOT });
  const committed = await readFile(SNAPSHOT, "utf8");
  const of = (text) => {
    const at = text.indexOf("= {");
    return at === -1 ? null : text.slice(at + 2).replace(/\s*as const;\s*$/, "");
  };
  const a = of(committed);
  const b = of(asModule);
  if (a === null) die("the committed snapshot is not in the expected shape", { path: SNAPSHOT });
  if (JSON.stringify(JSON.parse(a)) !== JSON.stringify(JSON.parse(b))) {
    console.error("✗ the committed old-runtime manifest and the live source disagree");
    console.error(`  regenerate: node scripts/scan-old-runtime-capabilities.mjs --write`);
    console.error(`  counts now: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    // 1, not 2: this one scanned fine. The old runtime changed and the inventory has not caught up.
    process.exit(1);
  }
  console.log("✓ the committed old-runtime manifest matches the source");
  process.exit(0);
}

if (writeTo !== undefined) {
  const path = resolve(import.meta.dirname, "..", writeTo);
  await writeFile(path, asModule, "utf8");
  console.log(`✓ wrote ${relative(process.cwd(), path)}`);
  console.log(`  ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  process.exit(0);
}

if (asJson) {
  console.log(JSON.stringify({ ok: true, repository: root, counts, ...manifest }, null, 2));
  process.exit(0);
}

console.log(`Old runtime at ${root}`);
for (const [key, value] of Object.entries(counts)) console.log(`  ${key.padEnd(10)} ${value}`);
console.log("");
console.log("Confirmation-gated tools (the ones whose approval must survive the migration):");
for (const tool of tools.filter((t) => t.requiresConfirmation)) console.log(`  ${tool.name}  (${tool.source})`);
console.log("");
console.log("Scheduled work:");
for (const job of manifest.scheduled) console.log(`  ${job.job}  ${job.schedule}  ${job.command}`);
console.log("");
console.log("Inbound webhooks:");
for (const hook of webhooks) console.log(`  ${hook.methods.join("/")} ${hook.path}`);
