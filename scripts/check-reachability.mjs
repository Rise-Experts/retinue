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
 * 3. **Is every field of a consumer-authored definition read?** Task #245. `AgentManifest` declared twelve
 *    fields and five of them — `responseFormat`, `toolPolicy`, `skillPolicy`, `contextProviderIds`,
 *    `authorizationPolicyId` — were read by nothing, having shipped that way in 0.2.0. A field is neither a
 *    capability nor an event, so questions 1 and 2 both passed over them; `toolPolicy.excluded` reads as a
 *    security control and enforced nothing. Five fields is not five accidents, it is the same class again in a
 *    place the ledger did not look.
 *
 *    Two shapes make a dead field look alive, and both had to be closed:
 *
 *    - **Its own default counts as a read.** `defineAgent` sets `responseFormat: { kind: "text" }`, so the very
 *      function that makes a field inert also references it. Hence `definers`: files whose mention never counts.
 *    - **A test asserting the default counts as a read.** `agent.test.ts` asserts `m.toolPolicy` equals the
 *      default — a test that passes forever whether or not anything interprets the field. Tests were already
 *      excluded from the file walk, which closes this one for free, and there is a fixture test to keep it shut.
 *
 *    A **read** means a property access — `manifest.limits`, not `limits:` in an object literal. Constructing a
 *    value with a field set is not interpreting it, which is precisely what the five inert fields did.
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
 * The field check has a third, known limitation: a property access is matched by name, so a field called `id`,
 * `name` or `version` matches accesses on every unrelated object in the tree and can never fail. That errs
 * toward passing, which is the wrong direction for a guard — but the alternative is a type-aware analysis, and
 * the failure mode being hunted has never been a generically-named field. Nobody names a policy field `id`. The
 * distinctive names are the ones that go dead, and those are matched exactly.
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
  /**
   * Platform **or** reference host — for question 3.
   *
   * A manifest policy field is host-interpreted by design: `DefaultEngineDeps` hands the manifest to
   * `buildTools`, `systemPrompt` and `resolveModel`, so a host reading `toolPolicy` there is the intended
   * design and must count as a read. Scoping the field check to `platform` alone would report a correctly
   * host-wired field as dead, which is the false alarm that gets a check deleted rather than fixed.
   */
  definition: ["backend/src", "examples/src", "examples/scripts"],
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
    name: "filesystem tools",
    symbol: "filesystem:",
    scope: "host",
    file: "examples/src/index.ts",
    why: "#215 — fs_read/fs_list/fs_search exist only when a root is wired, and a scope nothing supplies is three tools nobody can reach.",
  },
  {
    name: "sandbox for shell_exec",
    symbol: "createDockerSandbox",
    scope: "host",
    file: "examples/src/index.ts",
    why: "#215 — shell_exec needs a sandbox wired *and* the shell capability declared; a port with no adapter in any host is a tool that can never run.",
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
    /**
     * `platform`, not `host`, since #188 — and the move is the improvement rather than a relaxation.
     *
     * The policy was reachable only from MCP endpoint registration, which an operator configures once. A tool
     * whose URL the *model* chooses is the case it matters most for, and nothing exercised it there. #176 fixed
     * that by having the example apply the policy in its own fetcher, so the guard tracked the *host*: the
     * platform offering a policy nobody applied was the failure.
     *
     * The first-party tool library removed the requirement to remember. Every outbound tool now goes through
     * `toolkit/http.ts`, which applies the policy before any request, so an application gets it by using the
     * tools rather than by reimplementing them — and the example deleted its own fetcher. Tracking this at host
     * scope now would demand that every host keep a copy of the thing the platform does for it.
     */
    scope: "platform",
    why: "#176, #188 — every outbound tool applies the egress policy, and applies the same one.",
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
  {
    name: "the first-party tool library",
    symbol: "createStandardToolProvider",
    scope: "host",
    /**
     * Fifteen tools with tests and no registration would be the largest instance of this defect yet, and the
     * most plausible: a tool library reads as finished the moment it compiles, because nothing about an unused
     * provider looks wrong. The symbol tracked is the *provider*, not any individual tool — a provider that is
     * built and never listed is the failure, and once it is listed the registry is what decides the rest.
     */
    why: "#188 — the kit shipped zero tools; a library nothing registers ships zero tools with extra steps.",
  },
  {
    name: "duplicate tool-name detection",
    symbol: "duplicate-tool-name",
    scope: "platform",
    /**
     * Reachable means the registry can actually emit it. The check was added because a second first-party
     * provider became possible (#188) and `findAuthorized` takes the first match — so a shadowed tool executed
     * as whichever provider was registered first, with its effect classification and therefore its approval
     * requirement silently replaced.
     */
    why: "#188 — two providers offering one name must be refused loudly, not resolved by registration order.",
  },
  {
    name: "attachments reaching the model",
    symbol: "createAttachmentResolver",
    scope: "host",
    /**
     * The capability #185 is about, tracked at the point it was missing.
     *
     * `ImagePart`, `FilePart` and `InputModality` all existed and were tested; the bridge to the provider took a
     * string. So an attachment was stored, authorized, rendered and billed for, and the model was sent a turn
     * that did not mention it. Tracking the *resolver* rather than the parts is deliberate: parts being present
     * is what was true the whole time it was broken.
     */
    why: "#185 — an attachment the platform accepted must reach the model, through the same file authorization as a tool read.",
  },
  {
    name: "durable flows",
    symbol: "createFlowRunner",
    scope: "host",
    /**
     * A workflow engine with tests and no host is the largest possible instance of this defect, and the most
     * plausible: an interpreter reads as finished the moment its tests pass, because nothing about an unused
     * runner looks wrong. The symbol tracked is the *runner* rather than `advance` — a pure function is easy to
     * exercise from a test and prove nothing about, which is exactly the trap.
     */
    why: "#187 — a flow engine nothing runs is a library, and the buyer is a developer rather than a business.",
  },
  {
    name: "teams",
    symbol: "compileTeam",
    scope: "host",
    /**
     * Tracked separately from flows even though a team *is* a flow, because the compilation is the part that can
     * be built and left unreachable on its own: the interpreter would keep passing its tests while no host ever
     * turned a team into a flow to run.
     */
    why: "#186 — work divided between agents is the first question a buyer asks; a compiler nobody calls answers it on paper.",
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

/**
 * Definition types a consumer authors, whose every field must be read by something — question 3.
 *
 * `definers` is the mechanism that makes this work: the type's own declaration and the `define*` factory that
 * fills in defaults both mention every field, and neither interprets any of them. Without excluding them the
 * check passes on exactly the state it exists to find.
 *
 * `exempt` is for a field the check should not fail on. Each entry carries a reason, because an exemption list
 * without reasons is a place to hide things rather than a record of decisions — and an empty reason is itself a
 * failure, so "written down" is structural rather than conventional.
 *
 * Two kinds, and the difference matters:
 *
 * - A **string** means accepted by design: the field is genuinely declaration-only — persisted, returned over an
 *   API, rendered by a host. Nothing to do.
 * - `{ defect, issue }` means **a known defect with a filed fix**. The guard still passes, so `main` stays
 *   green, but it prints the field and the issue on every run. A silent exemption would turn this ledger into
 *   the hiding place it was built to prevent; a loud one is a standing reminder that shrinks as the issues
 *   close. Closing the issue means deleting the entry, and the check then holds the field for real.
 */
const DECLARED_TYPES = [
  {
    type: "AgentManifest",
    file: "backend/src/agents/index.ts",
    scope: "definition",
    definers: ["backend/src/agents/index.ts", "backend/src/agents/define.ts"],
    exempt: {
      id: "Identity. Read as `run.agentId` and by the persistence mapping, never as `manifest.id`.",
      version: "Identity. A run records `agentVersion` so editing an agent never rewrites history; the manifest's copy is written, not interpreted.",
      name: "Display. Rendered by a host and returned over GraphQL.",
      description: "Display. Same.",
      toolPolicy: {
        defect: "No interpreter ships anywhere, including the reference host. `excluded` reads as a security control and enforces nothing",
        issue: 244,
      },
      skillPolicy: { defect: "No interpreter ships anywhere", issue: 244 },
      authorizationPolicyId: { defect: "No interpreter ships anywhere", issue: 244 },
      contextProviderIds: { defect: "No interpreter ships anywhere", issue: 244 },
    },
  },
];

const SOURCE_DIRS = ["backend/src", "server/src", "examples/src", "examples/scripts"];

/**
 * Not shipped, so not a consumer.
 *
 * `src/testing/**` is excluded from the published build — it is the conformance harness, which *calls* everything
 * by design. Counting it would make this guard pass on the strength of the very suite whose blind spot it exists
 * to cover: `run.checkpointed` has a producer in a conformance fixture and none in the runtime.
 */
export const isTest = (path) =>
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
   * Declared definition types whose fields must be read — question 3. Each entry is
   * `{ type, fields, scope, definers, exempt }`; `fields` is passed in already parsed so the analysis stays
   * pure and testable against fixtures.
   */
  declaredTypes = [],
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

  for (const declared of declaredTypes) {
    if (declared.fields.length === 0) {
      // A type whose fields could not be parsed reports success having checked nothing — the failure mode this
      // guard's own `requireEvents` exists to prevent, in a second place.
      failures.push(
        `${declared.type}: no fields parsed from ${declared.file} — the type was renamed or moved, and the ` +
          `field check would pass having examined nothing`,
      );
      continue;
    }

    const definers = declared.definers ?? [];
    const readable = stripped.filter(
      (f) =>
        (scopes[declared.scope] ?? []).some((dir) => f.path.startsWith(dir)) &&
        !definers.includes(f.path) &&
        // Filtered here as well as in the walk, so the property holds regardless of what a caller passed in.
        // `agent.test.ts` asserts `m.toolPolicy` equals its default — a read that proves nothing interprets it,
        // and a guard that depended on the caller to exclude it would be one refactor from accepting it.
        !isTest(f.path),
    );

    for (const [field, reason] of Object.entries(declared.exempt ?? {})) {
      if (typeof reason === "string" && reason.trim() !== "") continue;
      if (
        reason !== null &&
        typeof reason === "object" &&
        typeof reason.defect === "string" &&
        reason.defect.trim() !== "" &&
        Number.isInteger(reason.issue)
      )
        continue;
      failures.push(
        `${declared.type}.${field} is exempt with no reason — an exemption list without reasons is a place to ` +
          `hide a dead field rather than a record of a decision. Use a string for accepted-by-design, or ` +
          `{ defect, issue } for a known defect with a filed fix`,
      );
    }

    for (const field of declared.fields) {
      if (declared.exempt !== undefined && field in declared.exempt) continue;
      // A property access, not a mention. `limits:` in an object literal constructs a value; `x.limits` reads
      // one, and only the read means something interprets the field.
      const access = new RegExp(`\\.${field}\\b`);
      if (readable.some((f) => access.test(f.code))) continue;
      failures.push(
        `${declared.type}.${field} is declared and never read: nothing in ` +
          `${(scopes[declared.scope] ?? []).join(" or ")} accesses \`.${field}\`, so a consumer setting it ` +
          `gets no behaviour and no error` +
          `\n      Either interpret it, delete it, or exempt it with a reason.`,
      );
    }
  }

  return failures;
};

/**
 * The field names of an `export type X = { ... }` block.
 *
 * Brace-counted rather than regex-terminated, because a field whose type is itself an object literal would end
 * the match early and silently shorten the list — a parser that reports four fields of twelve is a check that
 * passes having looked at a third of them.
 */
export const parseFields = (source, typeName) => {
  const start = source.indexOf(`export type ${typeName} = {`);
  if (start === -1) return [];
  let depth = 0;
  let end = start;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = source.slice(start, end);
  return [...body.matchAll(/^\s*(?:readonly\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\??\s*:/gm)].map((m) => m[1]);
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
  assertScopesExist(DECLARED_TYPES, SCOPES);
  const declaredTypes = DECLARED_TYPES.map((declared) => ({
    ...declared,
    fields: parseFields(readFileSync(resolve(ROOT, declared.file), "utf8"), declared.type),
  }));
  const failures = analyse({
    files,
    capabilities: CAPABILITIES,
    eventTypes,
    exemptEvents: EVENT_PRODUCER_EXEMPTIONS,
    declaredTypes,
    requireEvents: true,
  });

  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length} unreachable ${failures.length === 1 ? "thing" : "things"}:\n`);
    for (const failure of failures) console.error(`  - ${failure}\n`);
    console.error(
      `A capability with no consumer is not a feature. Either wire it, or add it to the exemption list with a\n` +
        `reason — the point is that the decision is written down.\n`,
    );
    process.exit(1);
  }

  const checkedFields = declaredTypes.reduce(
    (n, d) => n + d.fields.filter((f) => !(d.exempt !== undefined && f in d.exempt)).length,
    0,
  );
  console.log(
    `✓ ${CAPABILITIES.length} capabilities wired, ${eventTypes.length} run events emitted, ` +
      `${checkedFields} declared field(s) read across ${declaredTypes.length} definition type(s)`,
  );

  // Printed every run, deliberately. A known defect that stops being mentioned is a known defect that becomes
  // furniture — the same reason `check:catalogue` prints its not-yet-built count instead of swallowing it.
  const defects = declaredTypes.flatMap((d) =>
    Object.entries(d.exempt ?? {})
      .filter(([, r]) => r !== null && typeof r === "object")
      .map(([field, r]) => `${d.type}.${field} (#${r.issue}): ${r.defect}`),
  );
  if (defects.length > 0) {
    console.log(
      `\n  ${defects.length} field(s) exempt as known defects — the guard passes, the defect stands:`,
    );
    for (const d of defects) console.log(`  · ${d}`);
    console.log("  Closing the issue means deleting the entry, and the field is then held for real.");
  }
}
