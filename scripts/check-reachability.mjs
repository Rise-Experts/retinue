#!/usr/bin/env node
/**
 * The reachability guard: a capability the platform ships must be *connected to something*.
 *
 *   node scripts/check-reachability.mjs
 *
 * Four features turned out to be built, tested and unreachable — citations (#165), questions (#163),
 * usage recording (#166) and thread compaction (#169). That is a pattern, not four accidents, and the pattern has
 * one cause: **every test verifies a piece in isolation and nothing verifies that a piece is plugged in.**
 *
 * Each of the four looked finished from every angle a test could see. `createCitationEmitter` had unit tests and
 * an access check. `question.requested` was in the event union and the worker turned it into
 * `waiting-for-question`. `DurableWorkerDeps.usage` was a documented optional dependency. `compactThread` had a
 * conformance-backed store underneath it. What none of them had was a caller — and "has no caller" is invisible
 * to a suite that calls everything itself.
 *
 * ## What this checks
 *
 * Two questions, and they are different:
 *
 * 1. **Is every declared capability consumed?** `CAPABILITIES` names each one, the symbol that produces it, and
 *    where it must be referenced from. A capability with no reference and no exemption is a build failure.
 *
 * 2. **Is every run event emitted?** `RUN_EVENT_TYPES` is a closed union that the worker, the reducer, the
 *    telemetry span map and the frontend all switch over exhaustively — so an event nobody *produces* passes
 *    every exhaustiveness check in the codebase while being unreachable. That is exactly how #163 hid.
 *
 * ## Why the reference host counts as the consumer
 *
 * Most of these are host-facing on purpose: the platform ships a capability and an application wires it. So
 * "referenced from `backend/src`" is the wrong test — the emitter is *meant* to be called from outside. The right
 * test is that the **reference host actually exercises it**, because a capability the reference host cannot use
 * is a capability no host can use. `examples/` exists for that, and this makes it load-bearing rather than
 * decorative.
 *
 * ## What this does not catch
 *
 * A ledger catches what it names, and nothing else. Sabotaging this guard proved the point twice:
 *
 * - Deleting a wiring call while leaving its **import** in place passed, until imports stopped counting as use.
 *   An import is not a use, and "symbol present, wiring gone" is precisely the state being hunted.
 * - Unwiring the compaction *trigger* passed, because the platform function underneath was still called — by the
 *   wrapper that nothing then called. One layer of unreachability had replaced another. So both the platform
 *   symbol and the wiring site are named.
 *
 * Neither of those is a flaw to be fixed by cleverness; they are the shape of the tool. The mitigation is that
 * adding a capability means adding a line, and this file is short enough to read.
 *
 * ## Why a ledger rather than "find unused exports"
 *
 * An unused-export scan over a library is almost all false positives: every public type and helper exists for a
 * caller outside the repository. A declared list is the honest shape — the same choice `REGISTERED_PORTS` makes
 * for the conformance suite. Adding a capability means adding a line, and forgetting to is the failure this
 * catches.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/**
 * Where a capability may be consumed from.
 *
 * - `platform` — wired inside `backend/src`, so a host gets it without doing anything.
 * - `entrypoint` — wired by the shipped host commands in `backend/src/server`, so a documented deployment gets it.
 * - `host` — wired by an application; the reference host in `examples/src` is the proof it can be.
 */
const SCOPES = {
  platform: ["backend/src"],
  entrypoint: ["backend/src/server"],
  host: ["examples/src", "examples/scripts"],
};

/**
 * A capability naming a scope that does not exist is a mistake in the ledger, not a finding about the code.
 *
 * Without this the lookup yields an empty path list and the capability reports as unreachable — which is the
 * safe direction, but the message reads "nothing in  references X" with a blank where the directory should be,
 * and sends the reader looking for a wiring bug that is not there. Cost me a detour on #185.
 */
const assertScopesExist = (capabilities, scopes) => {
  const unknown = capabilities.filter((c) => scopes[c.scope] === undefined);
  if (unknown.length === 0) return;
  console.error("✗ capabilities naming a scope that does not exist:");
  for (const c of unknown) console.error(`  - ${c.name}: scope "${c.scope}" (known: ${Object.keys(scopes).join(", ")})`);
  process.exit(1);
};

/**
 * Every capability whose whole value is being connected to something.
 *
 * Deliberately not "every export". A type, a validator or a pure helper is complete on its own; these are the
 * things that do nothing at all unless something calls them, which is the class that went missing four times.
 */
const CAPABILITIES = [
  {
    name: "citation emission",
    symbol: "createCitationEmitter",
    scope: "host",
    why: "#165 — the emitter, parts, renderer and graders all existed with no path between them.",
  },
  {
    name: "engine citation wiring",
    symbol: "citations:",
    scope: "host",
    file: "examples/src/index.ts",
    why: "#165 — the engine's optional citation emitter has to actually be passed.",
  },
  {
    name: "question parking",
    symbol: "questionPending",
    scope: "host",
    why: "#163 — a tool must be able to park its run on a question; nothing could emit question.requested.",
  },
  {
    name: "engine question resumption wiring",
    symbol: "questions: questionServiceFor",
    scope: "host",
    file: "examples/src/index.ts",
    why: "#163 — without the engine's questions dep, an answered question is invisible and the model asks again.",
  },
  {
    name: "answered-question resumption",
    symbol: "findAnsweredQuestion",
    scope: "platform",
    why: "#163 — approvals had a resume path and questions had none, so the model asked again.",
  },
  {
    name: "usage recording",
    symbol: "createUsageRecorder",
    scope: "entrypoint",
    why: "#166 — no deployment recorded usage, so the quota guard could never fire.",
  },
  {
    name: "thread compaction",
    symbol: "compactThread",
    scope: "host",
    why: "#169 — nothing summarised a long thread, so history was only ever truncated.",
  },
  {
    name: "compaction trigger",
    symbol: "compactConversation",
    scope: "host",
    file: "examples/src/server.ts",
    /**
     * The *trigger*, not the mechanism.
     *
     * Found by sabotaging this guard: unwiring the trigger left `compactThread` still called — by the wrapper
     * that nothing then called. One layer of unreachability replaced another and the guard passed, because a
     * ledger only ever catches what it names. So the wiring site is named as well as the platform symbol.
     */
    why: "#169 — a compaction path nothing calls is the same bug one layer up.",
  },
  {
    name: "assistant turn persistence",
    symbol: "messages:",
    scope: "entrypoint",
    file: "backend/src/server/cli-worker.ts",
    why: "#157 — the worker's message store has to be wired or the agent has amnesia between runs.",
  },
  {
    name: "realtime publishing",
    symbol: "createRedisRealtimePublisher",
    scope: "entrypoint",
    why: "#161 — the worker command published to a hard-coded no-op, so no client ever saw a token.",
  },
  {
    name: "prompt budgeting",
    symbol: "assemblePrompt",
    scope: "host",
    why: "#168 — gathering sections without assembling them means nothing decides what fits.",
  },
  {
    name: "principal memory retrieval",
    symbol: "createPrincipalMemoryProvider",
    scope: "host",
    why: "#164 — durable cross-conversation memory, replacing a hand-rolled in-process map.",
  },
  {
    name: "run identity",
    symbol: "principalId: context.principalId",
    scope: "host",
    file: "examples/src/server.ts",
    why: "#164 — a run with no principal forces every worker to invent one.",
  },
  {
    name: "usage rollups",
    symbol: "createPostgresUsageRollupStore",
    scope: "host",
    why: "#166 — without rollups the spend panel has totals and no chart.",
  },
  {
    name: "approval misconfiguration reporting",
    symbol: "onMisconfiguration",
    scope: "host",
    why: "#162 — a tool that can never run should say so once, not refuse identically per call.",
  },
  {
    name: "skill resolution",
    symbol: "createSkillResolver",
    scope: "host",
    why: "#171 — the resolver, tracker, limits and store adapters all existed with nothing using them.",
  },
  {
    name: "per-run skill tracking",
    symbol: "createRunSkillTracker",
    scope: "host",
    /**
     * The tracker specifically, not just the resolver.
     *
     * The resolver loads a body; the tracker is what bounds how many a run may load and records which versions
     * it followed. Wiring only the resolver would leave both guarantees off while looking wired.
     */
    why: "#171 — without it maxLoadedPerRun never binds and no run records which skill versions it used.",
  },
  {
    name: "MCP tool import",
    symbol: "createMcpToolProvider",
    scope: "host",
    why: "#173 — the provider took an injectable client precisely so a host would wire one, and none did.",
  },
  {
    name: "MCP connection lifecycle",
    symbol: "closeExampleMcp",
    scope: "host",
    /**
     * The close, specifically. An MCP client over stdio owns a child process, so a shutdown that forgets it
     * leaves an orphan per restart — and the API host restarts often enough that the pile is easy to miss.
     */
    why: "#173 — a spawned MCP server must be closed on shutdown, not orphaned.",
  },
  {
    name: "quota enforcement",
    symbol: "createQuotaGuard",
    scope: "host",
    /**
     * `ResolverDeps.quota` is optional and nothing wired it, so a deployment with limits configured had no
     * limits — `assertAdmitted` was never called. #166 made the ledger non-empty; without this the guard still
     * had nothing consulting it.
     */
    why: "#175 — a configured spend limit that nothing checks is not a limit.",
  },
  {
    name: "configurable spend limits",
    symbol: "createStoredLimitResolver",
    scope: "host",
    why: "#175 — limits must come from a store an admin can change, not from a hardcoded value.",
  },
  {
    name: "HTTP egress policy",
    symbol: "validateHttpEgress",
    scope: "host",
    /**
     * The policy was reachable only from MCP endpoint registration, which an operator configures once. A tool
     * whose URL the *model* chooses is the case it matters most for, and nothing exercised it there.
     */
    why: "#176 — an outbound tool must apply the egress policy, not reimplement it.",
  },
  {
    name: "context inspection",
    symbol: "inspectAssembledPrompt",
    scope: "host",
    why: "#168 — context utilization is unanswerable if nothing inspects the assembled prompt.",
  },
  {
    name: "capability declaration",
    symbol: "resolveCapabilities",
    scope: "host",
    /**
     * The guard for the guard. This module exists because six capabilities were built, tested and wired to
     * nothing — so a capability *checker* that no host calls would be the joke writing itself.
     */
    why: "#198 — a host must declare what it enables, and be held to it; unchecked, the declaration is decoration.",
  },
  {
    name: "turn modality gating",
    symbol: "modelModalities",
    scope: "platform",
    /**
     * The exact shape this guard exists for. `ImagePart`, `FilePart` and `InputModality` were all present and
     * tested, and the bridge to the provider took a string — so an attachment was stored, authorized, rendered
     * and billed for, then never mentioned to the model. Correct, tested and unreachable, in the core turn loop.
     *
     * Tracked on the engine→bridge wiring rather than on the mapper: the mapper is called from inside the same
     * file and would count as reached even if nothing upstream ever passed it a part. What actually breaks is
     * the engine forgetting to say what the model accepts.
     */
    why: "#185 — an attachment the platform accepted must reach the model, and a model that cannot take one must refuse rather than be sent it silently.",
  },
];

/**
 * Run events whose producer is not in the scanned source, with the reason.
 *
 * Kept as data so an event becoming unreachable is a decision someone wrote down. An empty exemption list would
 * be ideal; an *undocumented* exemption is how #163 happened.
 */
const EVENT_PRODUCER_EXEMPTIONS = {
  // Produced by the reducer's own fold rather than emitted, so there is no `type: "..."` literal to find.
  // Listed because its absence from the scan is a property of how it is built, not of whether it works.
};

const SOURCE_DIRS = ["backend/src", "server/src", "examples/src", "examples/scripts"];

/**
 * Not shipped, so not a consumer.
 *
 * `src/testing/**` is excluded from the published build — it is the conformance harness, which *calls* everything
 * by design. Counting it would make this guard pass on the strength of the very suite whose blind spot it exists
 * to cover: `run.checkpointed` has a producer in a conformance fixture and none in the runtime.
 */
const isTest = (path) =>
  /\/__tests__\/|\.test\.[tm]?js$|\.test\.ts$/.test(path) || path.includes("src/testing/");

const walk = (dir) => {
  const out = [];
  const absolute = resolve(ROOT, dir);
  let entries;
  try {
    entries = readdirSync(absolute);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(absolute, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(relative(ROOT, full)));
      continue;
    }
    if (!/\.(ts|tsx|mjs)$/.test(entry)) continue;
    if (isTest(relative(ROOT, full))) continue;
    out.push(relative(ROOT, full));
  }
  return out;
};

/**
 * Strip comments **and import statements**, so only real use counts.
 *
 * Comments, because a capability named in prose is exactly the thing this guard exists to catch — the four
 * unreachable features were all described in detail by the code around them.
 *
 * Imports, because an import is not a use. Found by sabotaging this guard: deleting
 * `citations: createCitationEmitter(...)` from the example still passed, since the symbol was left in the import
 * list at the top of the file. A guard that accepts an unused import accepts precisely the state it is looking
 * for — the symbol present, the wiring gone.
 */
const stripComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    // `import ... from "..."` including multi-line braces, and bare `import "..."`.
    .replace(/^\s*import\s[\s\S]*?from\s*["'][^"']+["'];?/gm, "")
    .replace(/^\s*import\s+["'][^"']+["'];?/gm, "");

/**
 * The analysis, over already-read files — exported so it can be tested against fixtures.
 *
 * A guard nobody has watched fail is a guard nobody should trust. Sabotaging this one against the real tree found
 * two holes (imports counting as use, and one layer of unreachability masking another); the fixture tests below
 * are what keep those closed.
 */
export const analyse = ({
  files,
  capabilities,
  eventTypes,
  scopes = SCOPES,
  exemptEvents = {},
  /**
   * Whether an empty event list is itself a failure.
   *
   * On for the CLI: if `RUN_EVENT_TYPES` is renamed or moved, `parseEventTypes` returns nothing and the guard
   * would otherwise report success having checked no events at all — a guard that silently checks nothing is
   * worse than no guard, because it reports success. Off for callers checking capabilities alone.
   */
  requireEvents = false,
}) => {
  const failures = [];
  const stripped = files.map((f) => ({ path: f.path, code: stripComments(f.code) }));

  for (const capability of capabilities) {
    const allowed = capability.file
      ? stripped.filter((f) => f.path === capability.file)
      : stripped.filter((f) => (scopes[capability.scope] ?? []).some((dir) => f.path.startsWith(dir)));

    if (capability.file && allowed.length === 0) {
      failures.push(`${capability.name}: declared file ${capability.file} does not exist`);
      continue;
    }

    // The defining module does not count as a consumer: an export referenced only where it is declared is
    // precisely the unreachable case.
    const consumers = allowed.filter((f) => {
      if (!f.code.includes(capability.symbol)) return false;
      const declaresIt = new RegExp(
        `export (const|function|async function|type|interface) ${capability.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      ).test(f.code);
      return !declaresIt;
    });

    if (consumers.length === 0) {
      const where = capability.file ?? (scopes[capability.scope] ?? []).join(" or ");
      failures.push(
        `${capability.name} is unreachable: nothing in ${where} references \`${capability.symbol}\`` +
          `\n      ${capability.why ?? ""}`,
      );
    }
  }

  if (requireEvents && eventTypes.length === 0)
    failures.push("no event types to check — the guard would pass vacuously");

  for (const type of eventTypes) {
    if (type in exemptEvents) continue;
    // A producer writes the literal as a `type:` field. Searching for the bare string would match the worker's
    // and the reducer's *switches*, which is the trap: an event handled everywhere and emitted nowhere.
    const producers = stripped.filter((f) => new RegExp(`type:\\s*"${type.replace(".", "\\.")}"`).test(f.code));
    if (producers.length === 0) {
      failures.push(
        `run event "${type}" is never emitted: it is in RUN_EVENT_TYPES and handled by exhaustive switches, ` +
          `so every type check passes while nothing can produce it`,
      );
    }
  }

  return failures;
};

/** Parse the closed event union out of its source, since a `const` array is not importable from a .mjs guard. */
export const parseEventTypes = (source) => {
  const start = source.indexOf("RUN_EVENT_TYPES");
  if (start === -1) return [];
  const body = source.slice(start, source.indexOf("] as const", start));
  return [...body.matchAll(/"([a-z.-]+)"/g)].map((m) => m[1]);
};

/* ------------------------------------------------------------------ CLI */

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const files = SOURCE_DIRS.flatMap(walk).map((path) => ({
    path,
    code: readFileSync(resolve(ROOT, path), "utf8"),
  }));
  const eventTypes = parseEventTypes(readFileSync(resolve(ROOT, "backend/src/core/events.ts"), "utf8"));
  // Before the analysis, so a typo in the ledger is reported as a typo rather than as a wiring failure.
  assertScopesExist(CAPABILITIES, SCOPES);
  const failures = analyse({
    files,
    capabilities: CAPABILITIES,
    eventTypes,
    exemptEvents: EVENT_PRODUCER_EXEMPTIONS,
    requireEvents: true,
  });

  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length} unreachable ${failures.length === 1 ? "capability" : "capabilities"}:\n`);
    for (const failure of failures) console.error(`  - ${failure}\n`);
    console.error(
      `A capability with no consumer is not a feature. Either wire it, or add it to the exemption list with a\n` +
        `reason — the point is that the decision is written down.\n`,
    );
    process.exit(1);
  }

  console.log(`✓ ${CAPABILITIES.length} capabilities wired, ${eventTypes.length} run events emitted`);
}
