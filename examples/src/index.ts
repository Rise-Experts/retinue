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
  createPostgresConversationRunCoordinator,
  createPostgresIdempotencyStore,
  createPostgresInteractionStore,
  createPostgresPrincipalMemoryStore,
  createPostgresRunEventLog,
  createPostgresRunStore,
  createPostgresSessionStateStore,
  createPostgresUsageRollupStore,
  createPostgresUsageStore,
  createPostgresConversationStore,
  createApprovalGate,
  createApprovalService,
  computeModelCostMinorUnits,
  commitExtractedMemories,
  createCitationEmitter,
  createPrincipalMemoryProvider,
  createQuestionService,
  questionPending,
  createRunApprovals,
  createToolRegistry,
  parseExecutionContext,
  reduceRunEvent,
} from "@agentkit/backend";
import type {
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
import { examplePricing, resolveExampleModel } from "./model.js";
import { questionSpecsFrom } from "./questions.js";
import { buildWorkerContext } from "./worker-context.js";
import { MAX_MEMORY_ENTRIES, NoteNotFound, createExampleStore, createExampleTools, type ExampleStore } from "./tools.js";
import { exampleAgentManifest, exampleContextProviders } from "./agent.js";
import { EXCLUDED_EFFECTS, MODE_DESCRIPTIONS, type ConversationMode } from "./modes.js";
import { createModeStore } from "./mode-store.js";
import { conversationTurns, historyForModel } from "./history.js";

/** One store per process. The tools are a test surface; see the note in `tools.ts`. */
const store: ExampleStore = createExampleStore();
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
const ROLES = [
  {
    roleId: "editor",
    permissions: [
      { action: "read", resourceType: "*" },
      { action: "write", resourceType: "*" },
      { action: "execute", resourceType: "tool" },
      { action: "publish", resourceType: "note", requiresApproval: true },
    ],
    tools: ["remember", "recall", "list_notes", "search_notes", "write_note", "share_note", "calculate", "now", "ask_user"],
  },
  {
    roleId: "viewer",
    permissions: [
      { action: "read", resourceType: "*" },
      { action: "execute", resourceType: "tool" },
    ],
    // No `write_note`, no `share_note`. `viewer` cannot *see* them in the catalogue, so the model never offers
    // something the person cannot do — which is a better experience than a refusal after asking.
    tools: ["remember", "recall", "list_notes", "search_notes", "calculate", "now", "ask_user"],
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
const approvalGateFor = (sql: SqlExecutor) =>
  createApprovalGate({
    grants: createPostgresApprovalGrantStore(sql),
    // Without `interactions` the gate refuses every one-time ticket rather than trusting one, so a decided
    // approval would still never authorise its execution.
    interactions: createPostgresInteractionStore(sql),
  });

/** The question service, for the `ask_user` tool. Built per call so it shares the caller's executor. */
const questionServiceFor = (sql: SqlExecutor) =>
  createQuestionService({
    interactions: createPostgresInteractionStore(sql),
    dispatcher: createBullMqJobDispatcher(createBullMqRunQueue({ url: process.env["AGENTKIT_REDIS_URL"] ?? "" })),
    runs: createPostgresRunStore(sql),
  });

const buildTools = (sql: SqlExecutor): readonly Tool[] => {
  const idempotency = createPostgresIdempotencyStore(sql);

  const deps = { authorization, idempotency, approvals: approvalGateFor(sql) };
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
        const stored = await commitExtractedMemories(createPostgresPrincipalMemoryStore(sql), {
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
        const entries = await createPostgresPrincipalMemoryStore(sql).retrieve({
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
        const question = await questionServiceFor(sql).ask(context, context.runId as never, specs);
        // Thrown, not returned. The engine reads the `question_pending` code, tells the model the run is
        // parked, and emits `question.requested` — which is what actually suspends it.
        throw questionPending(question);
      },
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

/**
 * The coordinator, built only if something asks for it.
 *
 * Two facts collide. `claimOrEnqueue` takes the conversation's run slot `FOR UPDATE`, so it needs a real
 * `TransactionRunner`. And the platform's `runWorker` calls `app.deps({ config, sql })` with no runner — because
 * **the worker never uses the coordinator**: it reads `deps.runs` and `deps.eventLog` and nothing else. Admission
 * is the API's job.
 *
 * So `deps()` cannot require a runner, and must not silently accept `undefined` either: the first version passed
 * `undefined as never` and the first real request died on `Cannot read properties of undefined (reading
 * 'transaction')`. Build lazily, and let the *use* fail with a message naming the missing piece. The API supplies
 * one and works; the worker does not and never notices.
 */
const lazyCoordinator = (
  sql: SqlExecutor,
  runner: TransactionRunner | undefined,
): ResolverDeps["coordinator"] => {
  const build = (): ResolverDeps["coordinator"] => {
    if (runner === undefined)
      throw new Error(
        "this process has no TransactionRunner, so the conversation run coordinator cannot be used. The API " +
          "host supplies one; the worker does not, and does not need it.",
      );
    return createPostgresConversationRunCoordinator(sql, runner);
  };
  // A proxy rather than an object of getters, so every method — present and future — is covered by one decision.
  // Enumerating them would mean a method added later silently returning undefined.
  return new Proxy({} as ResolverDeps["coordinator"], {
    get: (_target, property) => {
      const built = build() as unknown as Record<string | symbol, unknown>;
      const value = built[property];
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(built) : value;
    },
  });
};

const app = {
  authenticate: createDevAuthenticate(),

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
    const runs = createPostgresRunStore(sql);
    const interactions = createPostgresInteractionStore(sql);
    const grants = createPostgresApprovalGrantStore(sql);
    const eventLog = createPostgresRunEventLog(sql);
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
      providers: [{ id: "example.notes-tools", async listTools() { return buildTools(sql); } }],
      authorization,
      idempotency: createPostgresIdempotencyStore(sql),
      // The registry's own fail-closed check. Without it every `policy`/`always` tool is refused, however the
      // envelope was configured — which is what made an approved share still fail.
      approval: approvalGateFor(sql),
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
      toolRegistry: registry,
      // `runs` is passed to both services deliberately: without it an approved run is enqueued but stays in
      // `waiting-for-approval`, which `claim` will not accept — the bug the #144 load harness found.
      questions: createQuestionService({ interactions, dispatcher, runs }),
      approvals: createApprovalService({ interactions, grants, dispatcher, runs }),
      // Lazy: the worker gets no runner and never uses this. See `lazyCoordinator`.
      coordinator: lazyCoordinator(sql, runner),
      dispatcher,
      eventLog,
      live,
    };
  },

  engine({ sql }: { config: AgentkitConfig; sql: SqlExecutor }) {
    const modes = createModeStore({
      sessions: createPostgresSessionStateStore(sql),
      grants: createPostgresApprovalGrantStore(sql),
    });
    const resolved = resolveExampleModel();
    const interactions = createPostgresInteractionStore(sql);
    const registry = createToolRegistry({
      providers: [{ id: "example.notes-tools", async listTools() { return buildTools(sql); } }],
      authorization,
      idempotency: createPostgresIdempotencyStore(sql),
      // The registry's own fail-closed check. Without it every `policy`/`always` tool is refused, however the
      // envelope was configured — which is what made an approved share still fail.
      approval: approvalGateFor(sql),
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
        grants: createPostgresApprovalGrantStore(sql),
        dispatcher: createBullMqJobDispatcher(createBullMqRunQueue({ url: process.env["AGENTKIT_REDIS_URL"] ?? "" })),
        runs: createPostgresRunStore(sql),
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
            sql,
            tenantId: String(context.tenantId),
            conversationId: String(context.conversationId),
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
        const all = await registry.catalog(context, { preloaded: [], categories: ["assistant"], excluded: [] });
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
          sql,
        ),
      approvals,
      /**
       * The question side of resumption — #163, and this app is what found it missing.
       *
       * `approvals` alone was not enough: a run parked on a question resumed with no idea it had been answered,
       * so the model asked again. Watched it happen in the browser — picked two options from the picker, the run
       * resumed, and the identical picker came back.
       */
      questions: questionServiceFor(sql),
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
  },

  buildContext: (run: Run) => buildWorkerContext(run),
};

/** Assembled through `gatherSections` + `renderContextBlock`, so the untrusted envelope is not bypassed. */
const exampleSystemPrompt = async (
  manifest: AgentManifest,
  context: ExecutionContext,
  mode: ConversationMode,
  sql: SqlExecutor,
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
  const sections = await gatherSections(context, [
    ...exampleContextProviders(store),
    createPrincipalMemoryProvider({
      store: createPostgresPrincipalMemoryStore(sql),
      maxEntries: 8,
    }),
  ]);
  /**
   * The mode instruction goes in the **prompt as well as** the catalogue.
   *
   * Filtering the tools is what makes plan mode true; telling the model why is what makes it *useful*. Without
   * the instruction it simply finds tools missing and improvises an explanation — usually that it lacks
   * permission, which is not what the person chose.
   */
  const modeBlock = MODE_DESCRIPTIONS[mode].instruction;
  const base = `${manifest.instructions}\n\n${modeBlock}`;
  if (sections.length === 0) return base;
  const block = renderContextBlock(sections, makeNonce((n) => randomBytes(n).toString("hex")));
  return `${base}\n\n# Context\n${block}`;
};

export default app;
