/**
 * The example app module — #155.
 *
 * `AGENTKIT_APP_MODULE` must default-export `{ authenticate, deps, engine, buildContext }`, and until now no such
 * module existed anywhere: `node server/dist/cli.js` was a documented command with nothing to boot. This is that
 * module.
 *
 * **Composition only.** Every store, service, envelope and engine it wires already exists and is already tested.
 * Nothing here adds a platform capability, and anything that looks like a capability being added here is a bug —
 * it belongs in `backend/`.
 *
 * What it is *not*, stated because example code is what people copy:
 *
 * - **Not an auth reference.** `authenticate` reads headers, which is not authentication. It refuses to run
 *   without an explicit opt-in for that reason.
 * - **Not a deployment template.** One process, no TLS, no rate limiting, GraphiQL on.
 * - **Not a product UI.** The page is deliberately plain; see `public/index.html`.
 */

import {
  createAuthorizationPolicy,
  createBullMqJobDispatcher,
  createBullMqRunQueue,
  createDefaultEngine,
  defineDelegatingTool,
  createRedisLiveEventSource,
  EMPTY_RUN_STREAM_STATE,
  createPostgresApprovalGrantStore,
  createPostgresIdempotencyStore,
  createPostgresInteractionStore,
  createPostgresPrincipalMemoryStore,
  createPostgresRunEventLog,
  createPostgresSkillStore,
  createPostgresRunStore,
  createPostgresSessionStateStore,
  createPostgresUsageLimitStore,
  createPostgresUsageRollupStore,
  createPostgresUsageStore,
  createPostgresConversationStore,
  createApprovalGate,
  createApprovalService,
  computeModelCostMinorUnits,
  commitExtractedMemories,
  asId,
  assemblePrompt,
  createCitationEmitter,
  createPrincipalMemoryProvider,
  createRunSkillTracker,
  createSkillResolver,
  createQuestionService,
  createQuotaGuard,
  createStoredLimitResolver,
  questionPending,
  createRunApprovals,
  createToolRegistry,
  parseExecutionContext,
  reduceRunEvent,
} from "@agentkit/backend";
import type {
  ContextBudget,
  ContextInspection,
  QuestionSpec,
  AgentManifest,
  ExecutionContext,
  ModelTurnTool,
  ResolverDeps,
  Run,
  SqlExecutor,
  Tool,
  TransactionRunner,
  TurnMessage,
} from "@agentkit/backend";
import { Redis } from "ioredis";
import type { AgentkitConfig } from "@agentkit/server";
import { createDevAuthenticate } from "./auth.js";
import type { Authenticate } from "@agentkit/server";

/** One authenticator, built the first time a request needs it. */
let devAuth: Authenticate | undefined;
const authenticateOnce = (): Authenticate => (devAuth ??= createDevAuthenticate());
import { examplePricing, resolveExampleModel } from "./model.js";
import { questionSpecsFrom } from "./questions.js";
import { contextLimitFor, exampleContextBudget } from "./context-usage.js";
import { postgresBackend, postgresStores } from "./stores.js";
import type { ExampleBackend } from "./stores.js";
import { buildWorkerContext } from "./worker-context.js";
import { MAX_MEMORY_ENTRIES, NoteNotFound, createExampleTools } from "./tools.js";
import { exampleStore } from "./store.js";
import { exampleProviders } from "./providers.js";
import { ASSIGNED_SKILLS, EXAMPLE_SKILLS, renderSkillCatalogue } from "./skills.js";
import { DOCS_MCP_SERVER_ID, DOCS_MCP_TOOLS, createDocsMcpClient, createDocsMcpProvider } from "./mcp.js";
import { createFetchUrl } from "./fetch-url.js";
import { fileURLToPath } from "node:url";
import { exampleAgentManifest, exampleContextProviders } from "./agent.js";
import { EXCLUDED_EFFECTS, MODE_DESCRIPTIONS, type ConversationMode } from "./modes.js";
import { createModeStore } from "./mode-store.js";
import { conversationTurns, historyForModel } from "./history.js";

/** One store per process. The tools are a test surface; see the note in `tools.ts`. */
// The notebook lives in `./store.ts`, so the server shares this one instance rather than a second.
const store = exampleStore;
const impl = createExampleTools(store);

/** Exposed so a test can assert the ledger without reaching through the app module. */
export const exampleState = { store, impl };

/**
 * Roles.
 *
 * Two, because one role cannot demonstrate authorization at all. `editor` may publish; `viewer` may not — so
 * `filterTools` visibly removes `publish_note` from the catalogue rather than the tool failing at execution.
 * `requiresApproval` on the publish permission is what routes it through the HITL gate.
 */
/**
 * The tool names each role may see, split so the two lists cannot drift apart by editing one.
 *
 * They used to be two hand-maintained arrays, and adding a tool meant remembering both. `viewer` silently
 * missing a new read-only tool is the failure that shape invites, and it looks like the tool being broken.
 */
const FIRST_PARTY_TOOLS = ["remember", "recall", "list_notes", "search_notes", "calculate", "now", "ask_user", "load_skill", "fetch_url"] as const;

/** Only `editor` gets these: they change or share something. */
const WRITE_TOOLS = ["write_note", "share_note"] as const;

// The imported MCP tools come from `./mcp.ts`, derived from the administrator classification there.

const ROLES = [
  {
    roleId: "editor",
    permissions: [
      { action: "read", resourceType: "*" },
      { action: "write", resourceType: "*" },
      { action: "execute", resourceType: "tool" },
      { action: "publish", resourceType: "note", requiresApproval: true },
    ],
    tools: [...FIRST_PARTY_TOOLS, ...WRITE_TOOLS, ...DOCS_MCP_TOOLS],
  },
  {
    roleId: "viewer",
    permissions: [
      { action: "read", resourceType: "*" },
      { action: "execute", resourceType: "tool" },
    ],
    // No `write_note`, no `share_note`. `viewer` cannot *see* them in the catalogue, so the model never offers
    // something the person cannot do — which is a better experience than a refusal after asking.
    tools: [...FIRST_PARTY_TOOLS, ...DOCS_MCP_TOOLS],
  },
] as const;

const authorization = createAuthorizationPolicy({
  roles: ROLES as never,
  // Denials to stderr. The platform's own telemetry (#143) is the production answer; here the point is that a
  // refusal is *visible* while driving the example by hand, rather than looking like a tool that did nothing.
  audit: (event) => console.error(`[audit] ${event.kind} ${event.action} ${JSON.stringify(event.resource)}`),
});

/**
 * The tools, wrapped in the platform's delegating envelope so authorization, the approval gate and idempotency
 * all apply. The deterministic functions live in `tools.ts` and know nothing about any of that (R7).
 *
 * `inputSchema` is a plain JSON schema on each: the registry validates against it before the delegate is
 * reached, so a model that invents a field gets a validation error rather than a silent `undefined`.
 */
/**
 * The approval gate, shared by the tools **and** the registry.
 *
 * It has to be both, and that took two rounds to find. The delegating envelope consults it for a gated effect,
 * and the registry has its *own* fail-closed check — "if no approval check is wired, a policy/always tool is
 * refused rather than silently executed unapproved". Wiring only the envelope left the registry refusing every
 * call with `approval_required`, before and after the human decided.
 *
 * Both are right to fail closed. Two independent gates is not redundancy: the envelope guards a delegating tool
 * and the registry guards *every* tool including MCP ones that never pass through the envelope. What is missing
 * is a way to be told you have wired one and not the other — see the note filed on #158.
 */
const approvalGateFor = (backend: ExampleBackend) =>
  createApprovalGate({
    grants: backend.grants,
    // Without `interactions` the gate refuses every one-time ticket rather than trusting one, so a decided
    // approval would still never authorise its execution.
    interactions: backend.interactions,
  });

/**
 * Every tool provider the registry draws on — first-party plus MCP (#173).
 *
 * One list, so the API host and the worker offer the same tools. They must: the catalogue is filtered at the API
 * boundary *and* re-authorised in the worker, and a tool present in one and absent in the other would be a run
 * that is admitted and then cannot finish.
 *
 * The MCP client is a **singleton**, like the skill tracker and for a related reason: it owns a spawned child
 * process. A client per call would spawn a documentation server per turn and leave them running.
 */
let mcpClientSingleton: ReturnType<typeof createDocsMcpClient> | undefined;

/**
 * Where the MCP server is spawned from.
 *
 * `examples/` rather than the process cwd, because the worker and the API host are started from different places
 * and a relative command that resolves in one would fail in the other — the kind of difference that shows up as
 * "MCP works in the API and not the worker", which is a nasty thing to debug.
 */
const EXAMPLE_ROOT = fileURLToPath(new URL("..", import.meta.url));

export const exampleMcpClient = () => {
  mcpClientSingleton ??= createDocsMcpClient({ cwd: EXAMPLE_ROOT });
  return mcpClientSingleton;
};

/** Closes the spawned MCP server. Called on shutdown so a restart does not leave orphans behind. */
export const closeExampleMcp = async (): Promise<void> => {
  const client = mcpClientSingleton;
  mcpClientSingleton = undefined;
  await client?.close();
};

const exampleToolProviders = (backend: ExampleBackend) => [
  { id: "example.notes-tools", async listTools() { return buildTools(backend); } },
  /**
   * The MCP server's tools, arriving through the same registry as the first-party ones.
   *
   * That is the point of the whole bridge: an imported tool inherits authorization filtering, the approval gate,
   * idempotency keys and the audit trail, rather than sitting beside them with its own rules. It is namespaced
   * `mcp__agentkit-docs__*`, so a remote server cannot shadow `share_note` by naming its own tool that.
   */
  // No tenant here: the provider reads it from each request's context (#178).
  createDocsMcpProvider(exampleMcpClient()),
];

/**
 * The skill resolver, and the per-run tracker — #171.
 *
 * The resolver is built per call, like every other store here, so it shares the caller's executor. The **tracker
 * is not**: it holds the per-run load log in memory, and a fresh one per call would forget what the run had
 * already loaded — so `maxLoadedPerRun` would never bind and the audit record would always be empty. One instance
 * per process, keyed by run internally.
 *
 * That the tracker is stateful and the resolver is not is worth stating rather than discovering: it is the one
 * place in this app where a factory must not be called twice.
 */
const skillResolver = (backend: ExampleBackend) =>
  createSkillResolver({ builtIn: EXAMPLE_SKILLS, store: backend.skills });

let trackerSingleton: ReturnType<typeof createRunSkillTracker> | undefined;
const skillTracker = (backend: ExampleBackend) => {
  trackerSingleton ??= createRunSkillTracker({ resolver: skillResolver(backend) });
  return trackerSingleton;
};

/** The question service, for the `ask_user` tool. Built per call so it shares the caller's executor. */
const questionServiceFor = (backend: ExampleBackend) =>
  createQuestionService({
    interactions: backend.interactions,
    dispatcher: createBullMqJobDispatcher(createBullMqRunQueue({ url: process.env["AGENTKIT_REDIS_URL"] ?? "" })),
    runs: backend.runs,
  });

/**
 * One fetcher for the process, so the egress policy is decided in exactly one place.
 *
 * A per-call factory would be harmless today and would be the seam through which a second, looser policy
 * eventually appears — and a second SSRF defence is one that drifts from the first.
 */
const fetchUrl = createFetchUrl({});

/**
 * The tool registry, built from the shared providers — used by both the engine and the GraphQL surface.
 *
 * Exported because the memory composition needs one too, and the alternative was listing the providers again
 * there. Two registries over the same providers is fine — a registry holds no state — but two *provider lists*
 * would be two catalogues, and the one nobody looks at is the one that goes stale.
 */
export const exampleRegistry = (backend: ExampleBackend) =>
  createToolRegistry({
    providers: exampleToolProviders(backend),
    authorization,
    idempotency: backend.idempotency,
    // The registry's own fail-closed check. Without it every `policy`/`always` tool is refused, however the
    // envelope was configured — which is what made an approved share still fail (#162).
    approval: approvalGateFor(backend),
    onMisconfiguration: (report) => console.error(`[tools] ${JSON.stringify(report)}`),
  });

const buildTools = (backend: ExampleBackend): readonly Tool[] => {
  const idempotency = backend.idempotency;

  const deps = { authorization, idempotency, approvals: approvalGateFor(backend) };
  const str = (v: unknown): string => String(v ?? "");

  return [
    defineDelegatingTool(deps, {
      name: "remember",
      description: "Store a fact about this person for future conversations.",
      category: "assistant",
      effect: "read" as const,
      delegatesTo: "principalMemory.put",
      inputSchema: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] },
      /**
       * Durable, through `PrincipalMemoryStore` — the fix for a real bug.
       *
       * This used to write to an in-process `Map`, so a fact told in one conversation was gone in the next: the
       * map lived in the worker process, died with it, and the API host could not see it at all. It looked like
       * it worked, because within one worker's lifetime `recall` found what `remember` had put there.
       *
       * `commitExtractedMemories` rather than a bare `put`, because it is the platform's gate between model
       * output and durable storage: it trims, bounds the length, and dedupes against what is already stored by
       * normalized text. Without it, a person mentioning their country three times gets three memories, and the
       * retrieval budget fills with one repeated fact.
       */
      delegate: async (input: unknown, context: ExecutionContext) => {
        const fact = str((input as { fact?: unknown }).fact);
        const stored = await commitExtractedMemories(backend.principalMemory, {
          tenantId: context.tenantId,
          principalId: context.principalId,
          candidates: [{ text: fact }],
        });
        // Reported truthfully, including the no-op: told it was stored when it was a duplicate, the model
        // confirms something that did not happen, and repeats itself on the next turn.
        return stored.length > 0
          ? { remembered: stored[0]?.text, id: stored[0]?.id }
          : { remembered: null, reason: "already known, or empty" };
      },
    }),
    defineDelegatingTool(deps, {
      name: "recall",
      description: "List everything you remember about this person.",
      category: "assistant",
      effect: "read" as const,
      delegatesTo: "principalMemory.retrieve",
      inputSchema: { type: "object", properties: { about: { type: "string" } } },
      /**
       * Salience-ranked retrieval, optionally focused by `about`.
       *
       * The memory provider already puts the most salient entries in the prompt, so this tool is for when the
       * model wants to look for something specific — "what do I know about their travel preferences" — rather
       * than for every turn. `retrieve` skips disabled entries, which a raw `list` would happily return.
       */
      delegate: async (input: unknown, context: ExecutionContext) => {
        const about = str((input as { about?: unknown }).about);
        const entries = await backend.principalMemory.retrieve({
          tenantId: context.tenantId,
          principalId: context.principalId,
          ...(about === "" ? {} : { query: about }),
          limit: MAX_MEMORY_ENTRIES,
        });
        return { facts: entries.map((e) => e.text) };
      },
    }),
    defineDelegatingTool(deps, {
      name: "list_notes",
      description: "List the notes in the shared notebook.",
      category: "assistant",
      effect: "read" as const,
      delegatesTo: "exampleTools.listNotes",
      delegate: () => impl.listNotes(),
    }),
    defineDelegatingTool(deps, {
      name: "search_notes",
      description:
        "Search the notes and get back the specific passages that matched, with where each came from. Use " +
        "this rather than list_notes when answering a question about what the notes say — the answer will " +
        "carry citations the person can check.",
      category: "assistant",
      effect: "read" as const,
      delegatesTo: "exampleTools.searchNotes",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      /**
       * The tool that makes citations reachable — #155 AC-5, and what found #165.
       *
       * It returns the passages **and** a `citations` array the engine recognises. The candidates carry
       * `supports: []`: the engine fills that in with the claims the model actually writes, because the passage
       * is read before the sentence it supports exists.
       *
       * `authSubject` is the conversation, which is what the example's authorization policy understands. It is
       * required for a retrieval citation and its absence means the citation is withheld — failing closed,
       * because emitting an excerpt nobody authorised leaks the text and not just the source's existence.
       */
      delegate: (input: unknown, context: ExecutionContext) => {
        const query = str((input as { query?: unknown }).query);
        const passages = impl.searchNotes({ query });
        const retrievedAt = new Date().toISOString();
        return {
          // What the model reads: the passages, without the provenance bookkeeping.
          matches: passages.map((p) => ({ noteId: p.noteId, title: p.noteTitle, passage: p.excerpt })),
          citations: passages.map((p) => ({
            origin: {
              kind: "retrieval" as const,
              // `message`, because a note here is user-authored content inside the workspace. A real app would
              // say `file` or `artifact` — the point is that it is not `web`, so it gets an access check.
              sourceType: "message" as const,
              sourceId: p.noteId,
              chunkId: `${p.noteId}:${p.chunkIndex}`,
              chunkIndex: p.chunkIndex,
              locator: p.noteTitle,
            },
            excerpt: p.excerpt,
            retrievedAt,
            supports: [],
            authSubject: String(context.conversationId ?? ""),
          })),
        };
      },
    }),
    defineDelegatingTool(deps, {
      name: "write_note",
      description: "Add a note to the shared notebook.",
      category: "assistant",
      // `internal-write`, not `external-write`: a note stays inside the workspace, so it needs authorization
      // but not a human decision. Classifying it as external would put an approval in front of every note and
      // teach people to click through them.
      effect: "internal-write" as const,
      delegatesTo: "exampleTools.writeNote",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" }, body: { type: "string" } },
        required: ["title", "body"],
      },
      delegate: (input: unknown, context: ExecutionContext) =>
        impl.writeNote({
          title: str((input as { title?: unknown }).title),
          body: str((input as { body?: unknown }).body),
          author: String(context.principalId),
        }),
    }),
    defineDelegatingTool(deps, {
      name: "share_note",
      description: "Publish a note outside the workspace. Irreversible; requires human approval.",
      category: "assistant",
      // `external-write` is what puts this behind the approval gate. The *effect classification* does it, not a
      // flag at the call site, so a tool cannot opt out of its own gate.
      effect: "external-write" as const,
      delegatesTo: "exampleTools.shareNote",
      inputSchema: { type: "object", properties: { noteId: { type: "string" } }, required: ["noteId"] },
      delegate: (input: unknown, _context: ExecutionContext, details) =>
        impl.shareNote({
          noteId: str((input as { noteId?: unknown }).noteId),
          idempotencyKey: String(details.idempotencyKey),
        }),
      // Read-only, and it runs *before* the gate: never ask a person to approve something that cannot succeed.
      preflight: (input: unknown) => {
        const noteId = str((input as { noteId?: unknown }).noteId);
        if (!store.notes.has(noteId)) throw new NoteNotFound(noteId);
      },
    }),
    defineDelegatingTool(deps, {
      name: "calculate",
      description: "Evaluate an arithmetic expression (+ - * / and parentheses).",
      category: "assistant",
      effect: "read" as const,
      delegatesTo: "exampleTools.calculate",
      inputSchema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
      delegate: (input: unknown) =>
        impl.calculate({ expression: str((input as { expression?: unknown }).expression) }),
    }),
    /**
     * Ask the person a question with options — #155.
     *
     * The counterpart to the approval gate: an approval asks *may I do this*, and this asks *which of these*. It
     * routes through the platform's question interaction, so the run **suspends** the same way and resumes with
     * the answer in the model's history — durable across a worker restart, unlike anything the model could do by
     * simply writing a question in text and hoping.
     *
     * `multiple` and `allowOther` are the fields that make it usable: without them a client cannot tell "pick
     * one" from "pick several" from "or describe your own", and has to guess from the prompt.
     */
    defineDelegatingTool(deps, {
      name: "ask_user",
      description:
        "Ask the person one or more questions and wait for their answers. Use when a choice is genuinely " +
        "theirs to make rather than guessing. Provide options when there is a sensible short list. Ask " +
        "everything you need in ONE call: the person answers them together and the run resumes once.",
      category: "assistant",
      effect: "read" as const,
      delegatesTo: "questions.ask",
      /**
       * A **batch** of questions, not one.
       *
       * `PendingQuestion.questions` has always been a list and `answers` has always been keyed by `key`, so one
       * interaction can carry several questions and resume on one answer. The tool only ever created one, which
       * meant a model needing two answers called it twice — and the second call landed while the run was already
       * being parked for the first, leaving an orphaned pending question whose card reappeared after the first
       * was answered. Watched exactly that happen.
       *
       * One call, several questions, one resume. `questions` is the field; `question` is still accepted because
       * models trained on the older single-question shape will keep sending it.
       */
      inputSchema: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            description: "Ask everything at once. The person answers them together.",
            items: {
              type: "object",
              properties: {
                key: { type: "string", description: "Short identifier for this answer, e.g. 'channel'." },
                question: { type: "string" },
                options: { type: "array", items: { type: "string" } },
                multiple: { type: "boolean" },
                allowOther: { type: "boolean" },
              },
              required: ["question"],
            },
          },
          question: { type: "string", description: "Shorthand for a single question." },
          options: { type: "array", items: { type: "string" } },
          multiple: { type: "boolean" },
          allowOther: { type: "boolean" },
        },
      },
      /**
       * Raising the question is the *whole* effect, and it must suspend the run.
       *
       * The delegate stores the question and throws `questionPending`, because the answer does not exist yet:
       * the person has not seen it. A delegate that blocked waiting for a reply would hold a worker slot for as
       * long as a human takes to read, which is exactly what the durable runtime exists to avoid.
       *
       * **This is what found #163.** The first version returned a plain `{ status: "question_asked" }` object
       * and relied on the comment's claim that "the worker pauses the run on the `question.requested` event".
       * The worker does — but nothing in the platform emitted that event, so the question was stored durably,
       * the model was told it had asked, and the run went on and completed. The picker never appeared and the
       * answer, if anyone had given one, would have arrived for a run that was already over.
       */
      delegate: async (input: unknown, context: ExecutionContext) => {
        const specs = questionSpecsFrom(input);
        // An empty ask is a model mistake, not a question. Parking a run on nothing answerable would hang it.
        if (specs.length === 0) throw new Error("ask_user needs at least one question with a prompt");
        const question = await questionServiceFor(backend).ask(context, context.runId as never, specs);
        // Thrown, not returned. The engine reads the `question_pending` code, tells the model the run is
        // parked, and emits `question.requested` — which is what actually suspends it.
        throw questionPending(question);
      },
    }),
    defineDelegatingTool(deps, {
      name: "load_skill",
      description:
        "Load the full instructions for one of your skills. Use it when the task matches a skill's description " +
        "— the catalogue in your context lists only names, not the instructions themselves.",
      category: "assistant",
      effect: "read" as const,
      delegatesTo: "skills.loadBody",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      /**
       * The skill body, pinned to a version — #171.
       *
       * The version comes from the **catalogue**, not from the model. Letting the model name a version would let
       * it pin to an archived one, or to a number that never existed, and the error would arrive as a tool
       * failure mid-task. The catalogue is resolved from the store on every turn, so "the latest active version"
       * is a fact the platform establishes and the model simply gets.
       *
       * Through `createRunSkillTracker` rather than the resolver directly, because the tracker is what enforces
       * `maxLoadedPerRun` and records the load. Without it a model could pull every skill into context on every
       * turn, which is the cost this whole mechanism exists to avoid — and there would be no record of which
       * instructions a run actually followed.
       */
      delegate: async (input: unknown, context: ExecutionContext) => {
        const name = str((input as { name?: unknown }).name);
        const catalogue = await skillResolver(backend).listCatalog({
          tenantId: context.tenantId,
          assigned: ASSIGNED_SKILLS,
          allowTenantSkills: true,
        });
        const entry = catalogue.find((e) => e.name === name);
        // Named rather than silent: a model that asked for a skill it cannot have should learn which ones it can,
        // not receive an empty result it will interpret as "the skill said nothing".
        if (entry === undefined) {
          return {
            loaded: false,
            reason: `No skill named "${name}".`,
            available: catalogue.map((e) => e.name),
          };
        }
        const body = await skillTracker(backend).load({
          tenantId: String(context.tenantId),
          runId: String(context.runId ?? ""),
          name: entry.name,
          version: entry.version,
        });
        return { loaded: true, name: body.name, version: body.version, instructions: body.instructions };
      },
    }),
    defineDelegatingTool(deps, {
      name: "fetch_url",
      description:
        "Read a public web page and return its text. Use it when the answer is on a page the person names, or " +
        "one you found in a note. https only; private and internal addresses are refused.",
      category: "assistant",
      /**
       * `read`, and that is a real decision rather than a default.
       *
       * It reads; it changes nothing. But it *leaves the workspace*, which is the property the effect taxonomy
       * usually cares about — so the argument for `external-write` is that an outbound request is observable to
       * a third party, and someone might not want the agent visiting arbitrary URLs on their behalf.
       *
       * `read` wins because the effect classification drives **approval**, and an approval prompt on every page
       * load is a prompt people learn to click through — which would weaken the approval on `share_note`, where
       * it genuinely matters. The exposure is bounded by the egress policy instead, which is a control that
       * cannot be clicked through. A deployment that disagrees changes this line and gets approvals.
       */
      effect: "read" as const,
      delegatesTo: "fetchUrl",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string", description: "An absolute https:// URL." } },
        required: ["url"],
      },
      delegate: (input: unknown) => fetchUrl(str((input as { url?: unknown }).url)),
    }),
    defineDelegatingTool(deps, {
      name: "now",
      description: "The current date and time in ISO-8601.",
      category: "assistant",
      effect: "read" as const,
      delegatesTo: "exampleTools.now",
      delegate: () => impl.now(),
    }),
  ];
};



const app = {
  /**
   * Built on first use, not at import — #155 AC-7.
   *
   * Eager construction made the whole app module unimportable without the dev-auth flag, so a test or a second
   * composition could not reach `composeEngine`. The "refuses to start" guarantee moved to
   * `assertDevAuthEnabled`, which every runner calls before anything else — so the process still stops with a
   * message that says what is missing, rather than serving one request and then failing.
   */
  authenticate: ((request: Request) => authenticateOnce()(request)) as Authenticate,

  /**
   * What the configured model costs, so recorded usage can carry a price — #166.
   *
   * Resolves for the one model this app is configured with, and null for anything else: a resolver that priced
   * an unrecognised id with the configured model's rates would produce a confident figure about the wrong
   * model. Null means "unpriced", tokens are still recorded, and the panel simply shows no money.
   */
  pricing: {
    resolve: (modelId: string) => (modelId === resolveExampleModel().modelId ? examplePricing() : null),
  },

  deps({ config, sql, runner }: { config: AgentkitConfig; sql: SqlExecutor; runner?: TransactionRunner }): ResolverDeps {
    /**
     * The Postgres composition, assembled once — #155 AC-7.
     *
     * `deps` and `engine` used to build a dozen stores each from `sql`, which made the whole app module a
     * Postgres application. Threading a bundle instead is what lets the single-process mode reuse *this* wiring
     * rather than carry a copy — and a copy is how a difference creeps in unnoticed, which is the shape of both
     * #157 and #161.
     */
    const backend = postgresBackend(sql, createRedisLiveEventSource(new Redis(config.redisUrl)), runner);
    const runs = backend.runs;
    const interactions = backend.interactions;
    const grants = backend.grants;
    const eventLog = backend.eventLog;
    /**
     * Subscribe over **Redis**, not in process (#161).
     *
     * `createMemoryEventBus()` connects a publisher and a subscriber inside one process — and the worker is a
     * different process, deliberately. So a host on the memory bus can never hear anything the worker publishes,
     * which is half of why streaming did not work at all.
     *
     * A dedicated connection: a Redis client in subscriber mode rejects every other command, so it cannot be
     * shared with anything that publishes or runs the queue.
     */
    const subscriberConnection = new Redis(config.redisUrl);
    const live = createRedisLiveEventSource(subscriberConnection, {
      // Surfaced rather than silent. A dropped payload is safe — the durable log is the source of truth — but a
      // *stream* of drops means a malformed publisher or a stuck client, and neither should be invisible.
      onDropped: (reason, channel) => console.error(`[realtime] dropped (${reason}) on ${channel}`),
    });

    const queue = createBullMqRunQueue({ url: config.redisUrl });
    const dispatcher = createBullMqJobDispatcher(queue);

    const registry = createToolRegistry({
      providers: exampleToolProviders(backend),
      authorization,
      idempotency: backend.idempotency,
      // The registry's own fail-closed check. Without it every `policy`/`always` tool is refused, however the
      // envelope was configured — which is what made an approved share still fail.
      approval: approvalGateFor(backend),
      /**
       * #162, and this app is why it exists. Wiring only the envelope's gate left `share_note` refused with a
       * message identical to a legitimate "not approved", so the fix that changed nothing looked like a
       * platform bug — filed as #158, which was really this.
       *
       * Wired here even though the check above is present: it costs one line and it is the line that would
       * have said, on the first call, that the tool could never run.
       */
      onMisconfiguration: (report) => console.error(`[tools] ${JSON.stringify(report)}`),
    });

    return {
      conversations: createPostgresConversationStore(sql),
      runs,
      usage: createPostgresUsageStore(sql),
      /**
       * Rollups, so the usage panel has a chart rather than only totals — #155 AC-5.
       *
       * Optional in `ResolverDeps` and its absence is graceful: `usageReport` falls back to summing the ledger,
       * which gives correct totals and no buckets. That is a usable panel with no chart, and it is what this
       * example showed before — accurate, and a weak demonstration of the thing the AC asks for.
       *
       * The buckets are rebuilt on demand by `/api/usage` rather than by a scheduled job. A cron in an example
       * is a process someone has to know to start, and a chart that is empty until it runs looks like a bug.
       */
      rollups: createPostgresUsageRollupStore(sql),
      /**
       * Quota enforcement, driven by configured limits — #175.
       *
       * `quota` is optional in `ResolverDeps` and nothing wired it, so a deployment with limits configured had no
       * limits: `assertAdmitted` was never called. Wired here with the store-backed resolver, so an
       * administrator setting a limit through `/api/limits` changes behaviour on the next turn rather than
       * requiring a redeploy.
       *
       * The **admission** path specifically. A limit enforced mid-run leaves a half-written answer and a person
       * who has to guess whether to retry; refused at admission, nothing was started and nothing has to be
       * undone.
       */
      quota: createQuotaGuard({
        rollups: createPostgresUsageRollupStore(sql),
        resolveLimits: createStoredLimitResolver({ limits: createPostgresUsageLimitStore(sql) }),
        // Refusals and warnings to stderr, so driving the example by hand shows them. A deployment would use the
        // platform's telemetry (#143).
        observer: {
          onWarning: (context, warning) =>
            console.error(`[quota] warning ${String(context.principalId)}: ${warning.message}`),
          onRefusal: (context, refusal) =>
            console.error(`[quota] refused ${String(context.principalId)}: ${refusal.message}`),
        },
      }),
      toolRegistry: registry,
      // `runs` is passed to both services deliberately: without it an approved run is enqueued but stays in
      // `waiting-for-approval`, which `claim` will not accept — the bug the #144 load harness found.
      questions: createQuestionService({ interactions, dispatcher, runs }),
      approvals: createApprovalService({ interactions, grants, dispatcher, runs }),
      // One coordinator for the process, from the backend, and it is the lazy one — see `lazyCoordinator` in
      // `stores.ts`. Building a second one here meant two handles on the same run-slot table.
      coordinator: backend.coordinator,
      dispatcher,
      eventLog,
      live,
    };
  },

  engine({ sql }: { config: AgentkitConfig; sql: SqlExecutor }) {
    // The worker needs no realtime *source*, so it is absent rather than invented. It also gets no
    // `TransactionRunner`, which is why the backend's coordinator has to be the lazy one — see `stores.ts`.
    return composeEngine(postgresBackend(sql, { subscribe: () => { throw new Error("the worker does not subscribe"); } } as never));
  },

  buildContext: (run: Run) => buildWorkerContext(run),
};

/**
 * The agent, composed from ports — one wiring for both adapters (#155 AC-7).
 *
 * Everything below is adapter-agnostic: the manifest, the tools, the registry, the approval loop, the skills,
 * the modes, the context providers. That is the claim ports-and-adapters makes, and this function is where it
 * is finally load-bearing rather than asserted — the memory composition calls exactly this.
 */
export const composeEngine = (backend: ExampleBackend) => {
  {
    const modes = createModeStore({
      sessions: backend.sessions,
      grants: backend.grants,
    });
    const resolved = resolveExampleModel();
    const interactions = backend.interactions;
    const registry = createToolRegistry({
      providers: exampleToolProviders(backend),
      authorization,
      idempotency: backend.idempotency,
      // The registry's own fail-closed check. Without it every `policy`/`always` tool is refused, however the
      // envelope was configured — which is what made an approved share still fail.
      approval: approvalGateFor(backend),
      /**
       * #162, and this app is why it exists. Wiring only the envelope's gate left `share_note` refused with a
       * message identical to a legitimate "not approved", so the fix that changed nothing looked like a
       * platform bug — filed as #158, which was really this.
       *
       * Wired here even though the check above is present: it costs one line and it is the line that would
       * have said, on the first call, that the tool could never run.
       */
      onMisconfiguration: (report) => console.error(`[tools] ${JSON.stringify(report)}`),
    });

    const approvals = createRunApprovals({
      interactions,
      approvals: createApprovalService({
        interactions,
        grants: backend.grants,
        dispatcher: createBullMqJobDispatcher(createBullMqRunQueue({ url: process.env["AGENTKIT_REDIS_URL"] ?? "" })),
        runs: backend.runs,
      }) as never,
      tools: registry as never,
    });

    return createDefaultEngine({
      async loadManifest() {
        return exampleAgentManifest;
      },
      resolveModel: () => ({
        model: resolved.model,
        modelId: resolved.modelId,
        currency: resolved.definition.pricing.currency,
        definition: resolved.definition,
        /**
         * What this turn cost — #166.
         *
         * Without a `price` the engine emits `costMinorUnits: 0` on every `usage.updated`, so the ledger records
         * real token counts against a cost of zero and the spend panel is permanently free. Tokens without a
         * price is honest; tokens with a *fabricated* zero looks like a measurement.
         *
         * `computeModelCostMinorUnits` is the platform's own arithmetic, so the panel's figure and a quota
         * ceiling's figure cannot disagree about what a million tokens costs.
         */
        price: (usage) =>
          computeModelCostMinorUnits(resolved.definition.pricing, {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            ...(usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens }),
          }),
      }),
      /**
       * History, through the one shared projection in `history.ts` — so the page and the model see the same
       * conversation.
       *
       * Running this app is what found #157: nothing wrote an assistant `messages` row, so on turn two the
       * model saw only the user's side of turn one and had no idea what it had itself said. This file used to
       * fold the run event log to compensate. The worker persists the turn now, so it is a plain read.
       */
      async loadHistory(context: ExecutionContext): Promise<readonly TurnMessage[]> {
        if (context.conversationId === undefined) return [];
        return historyForModel(
          await conversationTurns({
            stores: backend,
            tenantId: String(context.tenantId),
            conversationId: String(context.conversationId),
            // The compacted form, which is what compaction is for. The page reads the full transcript.
            compacted: true,
          }),
        );
      },
      async buildTools(context: ExecutionContext, manifest: AgentManifest): Promise<readonly ModelTurnTool[]> {
        void manifest;
        /**
         * The **preloaded** half only, and the `inputSchema` must travel with it.
         *
         * A bug I introduced and then chased into the platform. `discoverable` entries are *compact* — name,
         * label, description, category, effect — and carry no schema; `preloaded` entries are full descriptors
         * that do. Mapping both and keeping only `{name, description}` meant every tool reached the model with no
         * schema, `streamModelTurn` substituted a permissive object schema, and the SDK had nothing to parse the
         * streamed arguments into: **every call arrived as `{}`**.
         *
         * The symptom looked exactly like a platform streaming bug — calls with empty arguments, requested work
         * silently not happening — and it took reading the SDK's raw chunks to see the fault was here: straight
         * from `streamText`, `tool-call` carried `{"fact":"User prefers short answers."}` perfectly.
         *
         * So: preload the category, which is what `preloaded` is *for*, and pass the schema through. The
         * discoverable path exists for large catalogues where a model calls `learn_tools` first; with seven tools
         * that round trip buys nothing.
         */
        /**
         * The mode decides what the model can even *see* — #155.
         *
         * In `plan`, write and external-write tools are excluded from the catalogue by **effect**, not by name: a
         * name list goes stale the moment someone adds a tool, and the new tool would silently be reachable in
         * the one mode where it must not be.
         *
         * Excluded rather than refused, deliberately. A model that can see a tool and is refused every call keeps
         * trying, and produces plans that assume actions it will not be allowed to take. A model that cannot see
         * it plans with an accurate picture of its own reach.
         */
        const mode = await modes.get({
          tenantId: String(context.tenantId),
          conversationId: String(context.conversationId ?? ""),
        });
        const blocked = new Set(EXCLUDED_EFFECTS[mode]);
        /**
         * Both categories: the first-party tools and the imported MCP ones (#173).
         *
         * The platform namespaces an imported tool's *category* as `mcp:<server>`, which is what keeps a remote
         * server's tools identifiable in a catalogue — and means a preload list naming only `assistant` silently
         * excludes every one of them. The tools would be authorized, registered and invisible, which reads exactly
         * like the MCP bridge not working.
         */
        const all = await registry.catalog(context, {
          preloaded: [],
          categories: ["assistant", `mcp:${DOCS_MCP_SERVER_ID}`],
          excluded: [],
        });
        const catalog = {
          preloaded: all.preloaded.filter((d) => !blocked.has(String(d.effect))),
        };
        return catalog.preloaded.map((descriptor) => ({
          name: descriptor.name,
          description: descriptor.description,
          ...(descriptor.inputSchema === undefined ? {} : { inputSchema: descriptor.inputSchema }),
          async execute(input: unknown) {
            return registry.execute(context, { name: descriptor.name, input });
          },
        }));
      },
      // The system prompt goes through the platform's own assembly, so #145's untrusted-content envelope applies
      // to the `external` sections rather than being bypassed by a hand-built string here.
      systemPrompt: async (manifest, context) =>
        exampleSystemPrompt(
          manifest,
          context,
          await modes.get({
            tenantId: String(context.tenantId),
            conversationId: String(context.conversationId ?? ""),
          }),
          backend,
        ),
      approvals,
      /**
       * The question side of resumption — #163, and this app is what found it missing.
       *
       * `approvals` alone was not enough: a run parked on a question resumed with no idea it had been answered,
       * so the model asked again. Watched it happen in the browser — picked two options from the picker, the run
       * resumed, and the identical picker came back.
       */
      questions: questionServiceFor(backend),
      /**
       * Citations reach the message — #155 AC-5, via #165.
       *
       * The emitter takes the authorization policy because emission is where the access check lives: a citation
       * carries an excerpt, so one emitted for a source the reader may not open leaks the text itself. Passing
       * the same policy the tool catalogue is filtered with means "may see the tool" and "may see the passage"
       * cannot answer differently.
       */
      citations: createCitationEmitter({ authorization }),
    });
  }
};

/** Assembled through `gatherSections` + `renderContextBlock`, so the untrusted envelope is not bypassed. */
const exampleSystemPrompt = async (
  manifest: AgentManifest,
  context: ExecutionContext,
  mode: ConversationMode,
  backend: ExampleBackend,
): Promise<string> => {
  const { gatherSections, renderContextBlock, makeNonce } = await import("@agentkit/backend");
  const { randomBytes } = await import("node:crypto");
  /**
   * The notebook's provider, plus the **platform's** principal-memory provider.
   *
   * The memory provider is the platform's rather than a local one, and that is the fix for a real bug: the
   * example had its own reading an in-process `Map`, so a fact told in one conversation was gone in the next —
   * the map lived in the worker process, died with it, and was invisible to the API host. `PrincipalMemoryStore`
   * is durable and tenant-scoped, and `createPrincipalMemoryProvider` budgets retrieval by salience so memories
   * never crowd out recent turns.
   */
  // The one shared list — see `./providers.ts`. A second list here would make `/api/context` a report about a
  // prompt the model never saw.
  const sections = await gatherSections(context, exampleProviders(backend));
  /**
   * The mode instruction goes in the **prompt as well as** the catalogue.
   *
   * Filtering the tools is what makes plan mode true; telling the model why is what makes it *useful*. Without
   * the instruction it simply finds tools missing and improvises an explanation — usually that it lacks
   * permission, which is not what the person chose.
   */
  const modeBlock = MODE_DESCRIPTIONS[mode].instruction;
  /**
   * The skill **catalogue** in the prompt, not the skill bodies — #171.
   *
   * This is the whole economics of skills. Names and one-line descriptions cost tens of tokens and are paid for
   * every turn; the bodies cost hundreds each and are paid for only when a turn needs them. Putting the bodies
   * here would be a longer system prompt with extra steps, and would dilute the one skill that matters with the
   * two that do not.
   *
   * Resolved from the store on every turn rather than cached, so a skill added or archived takes effect on the
   * next turn. The version in the catalogue is what `load_skill` pins to.
   */
  const catalogue = await skillResolver(backend).listCatalog({
    tenantId: context.tenantId,
    assigned: ASSIGNED_SKILLS,
    allowTenantSkills: true,
  });
  const skillBlock = renderSkillCatalogue(catalogue);
  const base = [manifest.instructions, modeBlock, skillBlock].filter((part) => part !== "").join("\n\n");
  if (sections.length === 0) return base;
  /**
   * Budgeted through `assemblePrompt`, not merely gathered — #168.
   *
   * This used to render every gathered section straight into the prompt. It worked because the example's context
   * is small, and it meant the app had no idea how full the window was: `gatherSections` returns everything a
   * provider offers, and nothing decided what fits. So a notebook that grew would have pushed the prompt past
   * the model's limit and the failure would have arrived from the provider, as a 400.
   *
   * `assemblePrompt` budgets per bucket, prunes in a defined order, and reports what it dropped and why — which
   * is also what makes `/api/context` able to say anything true about utilization.
   */
  const assembled = assemblePrompt({
    sections,
    budget: exampleContextBudget(),
    modelContextTokens: contextLimitFor(),
  });
  const block = renderContextBlock(assembled.sections, makeNonce((n) => randomBytes(n).toString("hex")));
  return `${base}\n\n# Context\n${block}`;
};



export default app;
