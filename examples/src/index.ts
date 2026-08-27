/**
 * The example app module — #155.
 *
 * `RETINUE_APP_MODULE` must default-export `{ authenticate, deps, engine, buildContext }`, and until now no such
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

import { asId, resolveCapabilities } from "@retinue/agentkit";
import { budgetSkillCatalogue, truncationNotice } from "@retinue/agentkit/context";
import { assemblePrompt, commitExtractedMemories, createCitationEmitter, createPrincipalMemoryProvider, createRunSkillTracker, createSkillResolver } from "@retinue/agentkit/context";
import { createApprovalGate, createApprovalService, createAuthorizationPolicy, createQuestionService, createRunApprovals, questionPending } from "@retinue/agentkit/hitl";
import { EMPTY_RUN_STREAM_STATE, computeModelCostMinorUnits, createDefaultEngine, parseExecutionContext, reduceRunEvent } from "@retinue/agentkit/runtime";
import { createToolRegistry, createToolSearch, defineDelegatingTool } from "@retinue/agentkit/tools";
import { createDockerSandbox } from "@retinue/agentkit/tools";
import { createQuotaGuard, createStoredLimitResolver } from "@retinue/agentkit/usage";
import { createBullMqJobDispatcher, createBullMqRunQueue } from "@retinue/agentkit/adapters/bullmq";
import { createPostgresApprovalGrantStore, createPostgresIdempotencyStore, createPostgresInteractionStore, createPostgresPrincipalMemoryStore, createPostgresRunEventLog, createPostgresSkillStore, createPostgresRunStore, createPostgresSessionStateStore, createPostgresUsageLimitStore, createPostgresUsageRollupStore, createPostgresUsageStore, createPostgresConversationStore } from "@retinue/agentkit/adapters/postgres";
import { createRedisLiveEventSource } from "@retinue/agentkit/adapters/redis";
import type { ContextBudget, ContextInspection, QuestionSpec, AgentManifest, ExecutionContext, ModelTurnTool, ResolverDeps, Run, RunId, Tool, TurnMessage } from "@retinue/agentkit";
import type { SqlExecutor, TransactionRunner } from "@retinue/agentkit/adapters/postgres";
import { Redis } from "ioredis";
import type { RetinueConfig } from "@retinue/agentkit/server";
import { createDevAuthenticate } from "./auth.js";
import type { Authenticate } from "@retinue/agentkit/server";
import { STANDARD_TOOL_CATEGORIES, createStandardToolProvider } from "@retinue/agentkit/tools";
import { createAttachmentResolver } from "@retinue/agentkit/knowledge";
import { createFlowRunner } from "@retinue/agentkit/flows";
import { EXAMPLE_FLOWS, createExampleFlowHandler } from "./flows.js";
import { exampleToolkits, searchProviderFrom } from "./toolkits.js";

/**
 * The catalogue controls this app wires — REQ-045 (#204), task #210.
 *
 * From the environment because they are a *deployment's* decision, and this file is a deployment. A real
 * multi-tenant host reads the toolset from a column keyed by tenant; there is one tenant here, so there is one
 * setting, and the seam is the same either way.
 *
 * All three default to off. A budget nobody asked for that silently withheld tools would be exactly the
 * invisible failure the mechanism exists to make visible.
 */
export const exampleCatalogBudget = (): { readonly maxTokens: number } | undefined => {
  const raw = process.env["RETINUE_CATALOG_BUDGET_TOKENS"];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? { maxTokens: parsed } : undefined;
};

export const exampleToolset = (): { readonly disabledCategories: readonly string[] } | undefined => {
  const raw = process.env["RETINUE_DISABLED_TOOL_CATEGORIES"];
  const categories = (raw ?? "").split(",").map((part) => part.trim()).filter((part) => part !== "");
  return categories.length === 0 ? undefined : { disabledCategories: categories };
};

/**
 * The filesystem this app exposes, if any — REQ-047 (#206), task #215.
 *
 * Two directories, and they must be different: the read root is material the assistant may cite, and the
 * writable root is where its own output lands. One directory for both is how a corpus a model cites becomes a
 * corpus a model wrote.
 *
 * Off by default. A file tool pointed at a default directory would be a tool reading whatever happened to be in
 * the process's working tree.
 */
export const exampleFilesystem = (): { readonly root: string; readonly writableRoot?: string } | undefined => {
  const root = process.env["RETINUE_FILES_ROOT"];
  if (root === undefined || root === "") return undefined;
  const writableRoot = process.env["RETINUE_FILES_WRITABLE_ROOT"];
  return writableRoot === undefined || writableRoot === "" ? { root } : { root, writableRoot };
};

/**
 * The sandbox for `shell_exec` — task #215.
 *
 * A container image, or nothing. There is deliberately no way to select the local adapter from the environment:
 * running commands on the runtime's host is a decision that belongs in code somebody reviewed, not in a variable
 * somebody copied from a colleague's `.env`.
 */
export const exampleSandbox = () => {
  const image = process.env["RETINUE_SANDBOX_IMAGE"];
  if (image === undefined || image === "") return undefined;
  /**
   * The declaration gates the wiring, not the other way round.
   *
   * `resolveCapabilities` refuses a runtime that wired something it did not declare — a good rule, and it made
   * "image set, `RETINUE_SHELL` unset" a boot failure, which is a hostile way to greet somebody who set one
   * variable. So the app follows its own declaration: no declaration, no sandbox, no tool. The other direction
   * stays a boot failure, and that is the one that matters: `RETINUE_SHELL=1` with no image refuses to start
   * rather than serving an agent whose shell tool silently declines.
   */
  return exampleShellDeclared() ? createDockerSandbox({ image }) : undefined;
};

/** Whether this deployment declared the second of `shell_exec`'s two switches. */
export const exampleShellDeclared = (): boolean => process.env["RETINUE_SHELL"] === "1";

export const exampleSkillCatalogBudget = (): { readonly maxTokens: number } | undefined => {
  const raw = process.env["RETINUE_SKILL_CATALOGUE_BUDGET_TOKENS"];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? { maxTokens: parsed } : undefined;
};

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
import { EXAMPLE_SKILLS, renderSkillCatalogue } from "./skills.js";
import { DOCS_MCP_SERVER_ID, DOCS_MCP_TOOLS, createDocsMcpClient, createDocsMcpProvider } from "./mcp.js";
import { fileURLToPath } from "node:url";
import { exampleAgentManifest, exampleContextProviders } from "./agent.js";
import { EXCLUDED_EFFECTS, MODE_DESCRIPTIONS, type ConversationMode } from "./modes.js";
import { createModeStore } from "./mode-store.js";
import { conversationTurns, historyForModel, historyForModelWithAttachments } from "./history.js";

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
const FIRST_PARTY_TOOLS = ["remember", "recall", "list_notes", "search_notes", "ask_user", "load_skill"] as const;

/**
 * The kit's tools this app grants — REQ-039 (#188).
 *
 * Listed by name rather than derived from `STANDARD_TOOL_NAMES`, and that is the point: a derived list would
 * grant every tool a future version of the library adds, so upgrading the package would widen what a model may
 * do without anyone deciding to. A grant is a decision, so it is typed out.
 *
 * The drift this invites — the library gains a tool and nobody notices — is caught by a test rather than by
 * hoping: `example-app.test.ts` asserts every tool the provider actually lists is granted to some role, so an
 * undecided tool is a failing build and not an invisible one.
 */
const KIT_READ_TOOLS = ["fetch_url", "fetch_json", "http_request", "parse_csv", "query_json", "calculate", "now", "web_search"] as const;

/** Only `editor` gets these: they change or share something. */
const WRITE_TOOLS = ["write_note", "share_note"] as const;

/** `http_write` reaches another system, so it sits with the writes and is gated like them. */
const KIT_WRITE_TOOLS = ["http_write"] as const;

/**
 * The filesystem reads — task #215. Both roles, like the web reads.
 *
 * Reading a file inside the configured root is the same kind of act as fetching a URL: the control is the root,
 * not a role. `fs_write` and `shell_exec` are a different matter and sit with the writes below.
 */
const KIT_FS_READ_TOOLS = ["fs_read", "fs_list", "fs_search"] as const;

/**
 * `fs_write` and `shell_exec` — `editor` only, and both gated.
 *
 * `shell_exec` is granted here deliberately, for the same reason `github_merge_pull_request` is: a destructive
 * tool no role may call is a gate nothing exercises. It is still off unless a sandbox is wired *and* the `shell`
 * capability declared, which is two more switches than a grant.
 */
const KIT_DANGEROUS_TOOLS = ["fs_write", "shell_exec"] as const;

/**
 * The integration toolkits' reads — #214.
 *
 * Granted to both roles: reading a public repository or a channel the bot is in is the same kind of act as
 * fetching a URL. Typed out for the same reason as the kit's own list — a grant is a decision, and deriving it
 * from `GITHUB_TOOL_NAMES` would widen it every time the package gained a tool.
 */
const TOOLKIT_READ_TOOLS = [
  "github_search_code",
  "github_get_file",
  "github_list_issues",
  "slack_list_channels",
  "slack_read_history",
] as const;

/**
 * The integration toolkits' writes — `editor` only, and every one of them gated.
 *
 * `github_merge_pull_request` is `destructive`, and it is granted here deliberately: a destructive tool that no
 * role may call is a gate nothing exercises, and the approval path is the platform's most distinctive behaviour.
 * It reaches a real repository, which is exactly why it stops and asks.
 */
const TOOLKIT_WRITE_TOOLS = [
  "github_create_issue",
  "github_comment",
  "github_merge_pull_request",
  "slack_post_message",
  "slack_reply_in_thread",
] as const;

// The imported MCP tools come from `./mcp.ts`, derived from the administrator classification there.

/**
 * Every tool name any role may use.
 *
 * Exported for the drift test rather than for the app: the app reads `ROLES`. A test that recomputed this list
 * from the same constants would agree with itself no matter what the roles actually say.
 */
export const ROLE_TOOL_NAMES: readonly string[] = [
  ...FIRST_PARTY_TOOLS,
  ...KIT_READ_TOOLS,
  ...WRITE_TOOLS,
  ...KIT_WRITE_TOOLS,
  ...KIT_FS_READ_TOOLS,
  ...KIT_DANGEROUS_TOOLS,
  ...TOOLKIT_READ_TOOLS,
  ...TOOLKIT_WRITE_TOOLS,
  ...DOCS_MCP_TOOLS,
];

const ROLES = [
  {
    roleId: "editor",
    permissions: [
      { action: "read", resourceType: "*" },
      { action: "write", resourceType: "*" },
      { action: "execute", resourceType: "tool" },
      { action: "publish", resourceType: "note", requiresApproval: true },
    ],
    tools: [
      ...FIRST_PARTY_TOOLS,
      ...KIT_READ_TOOLS,
      ...WRITE_TOOLS,
      ...KIT_WRITE_TOOLS,
      ...KIT_FS_READ_TOOLS,
      ...KIT_DANGEROUS_TOOLS,
      ...TOOLKIT_READ_TOOLS,
      ...TOOLKIT_WRITE_TOOLS,
      ...DOCS_MCP_TOOLS,
    ],
  },
  {
    roleId: "viewer",
    permissions: [
      { action: "read", resourceType: "*" },
      { action: "execute", resourceType: "tool" },
    ],
    // No `write_note`, no `share_note`. `viewer` cannot *see* them in the catalogue, so the model never offers
    // something the person cannot do — which is a better experience than a refusal after asking.
    tools: [...FIRST_PARTY_TOOLS, ...KIT_READ_TOOLS, ...KIT_FS_READ_TOOLS, ...TOOLKIT_READ_TOOLS, ...DOCS_MCP_TOOLS],
  },
] as const;

/**
 * Exported since #185, for the app runner.
 *
 * The runner builds its own `postgresBackend` for the HTTP routes, and the file service inside it needs this
 * policy — not a permissive stand-in. Two policies in one deployment is how an attachment ends up readable
 * through one route and refused through another.
 */
export const authorization = createAuthorizationPolicy({
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

/**
 * The attachment resolver, when there is a file service to read through — #185.
 *
 * `undefined` where there is none, which is the memory composition: it has no content store the two processes
 * share, so it has no attachments. Returning a resolver over nothing would give a turn parts that fail to load.
 */
const attachmentResolver = (backend: ExampleBackend) =>
  backend.files === undefined ? undefined : createAttachmentResolver({ files: backend.files });

/**
 * The flow runner, when the composition can store flows — REQ-038 (#187).
 *
 * A flow's durability is its storage: an execution that is not written between steps cannot be resumed, so a
 * composition without the stores has no flows rather than flows that lose their place. `undefined` says so.
 *
 * `EXAMPLE_FLOWS` are published on first use rather than at import, and a conflict is swallowed: publishing a
 * version that already exists is the *expected* outcome on every boot after the first, and the store refuses it
 * precisely so a version cannot change under a running execution.
 */
export const exampleFlowRunner = (backend: ExampleBackend) => {
  if (backend.flowDefinitions === undefined || backend.flowExecutions === undefined) return undefined;
  return createFlowRunner({
    definitions: backend.flowDefinitions,
    executions: backend.flowExecutions,
    // The poll half of waking a parent: correctness does not depend on the notification arriving.
    runs: backend.runs,
    handler: createExampleFlowHandler({
      registry: exampleRegistry(backend),
      /**
       * An agent step becomes a child run — #202.
       *
       * Three decisions here, each of which had an appealing wrong answer:
       *
       * **No conversation.** `ConversationRunCoordinator` claims a *conversation's* single run slot, so a flow
       * running inside a conversation whose steps also claimed it would deadlock against the conversation's own
       * turn — the parent holds the slot and waits for a child that can never get it. A conversation-less run
       * (#198) has no slot to contend for. What the member needs from the thread travels in the prompt, where it
       * is readable, rather than through a conversation the child does not have.
       *
       * **The ceiling is the flow's remainder**, handed over by the interpreter and re-derived per step. Giving
       * the child its own independent limits is a member that can outspend the team.
       *
       * **The row before the job.** A job enqueued before its run row exists points at nothing: the worker claims
       * it, `claim` matches no run, and the job is silently skipped — the abandoned-run shape #144 found.
       */
      startChildRun: async (context, input) => {
        const runId = asId<RunId>(`run-flow-${input.member ?? "agent"}-${Date.now().toString(36)}`);
        /**
         * The row before the job, always.
         *
         * A job enqueued before its run row exists points at nothing: the worker claims it, `claim` matches no
         * run, and the job is silently skipped — the abandoned-run shape #144 found and #155 reproduced by
         * leaving out the create.
         */
        await backend.runs.create({
          tenantId: context.tenantId,
          id: runId,
          // No `conversationId`, deliberately — see the comment above `startChildRun`.
          agentId: asId(input.agentId),
          agentVersion: 1,
          principalId: context.principalId,
          roleIds: context.roleIds,
          /**
           * The request travels on the **run** — #202.
           *
           * A conversation-less run has no history to read, so `input` is the whole of what this member is told.
           * The alternative was a `Message`, which requires a conversation: the run shape said none was needed
           * while the storage said its input still needed one.
           */
          input: {
            prompt: input.prompt,
            ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
            ...(input.member === undefined ? {} : { member: input.member }),
          },
          // From the flow's remainder, re-derived per step, so a member cannot outspend the team.
          limits: {
            maxSteps: Math.max(1, input.budgetRemaining.steps),
            ...(input.budgetRemaining.costMinorUnits === undefined
              ? {}
              : { costCeilingMinorUnits: input.budgetRemaining.costMinorUnits }),
            ...(input.budgetRemaining.wallClockMs === undefined
              ? {}
              : { wallClockTimeoutMs: input.budgetRemaining.wallClockMs }),
          },
        });
        await createBullMqJobDispatcher(
          createBullMqRunQueue({ url: process.env["RETINUE_REDIS_URL"] ?? "" }),
        ).enqueueRun({ tenantId: context.tenantId, runId });
        return String(runId);
      },
      askQuestion: async (context, input) => {
        /**
         * The platform's own question service, on the flow's run.
         *
         * The run id comes from the context rather than being invented: a flow *is* a run (#197), so its
         * checkpoint parks the same run a chat turn would, and the assistant surface can answer it with the
         * mutation it already has. A synthetic run id here would produce a question nothing could find.
         */
        const service = questionServiceFor(backend);
        const asked = await service.ask(context, asId(String(context.runId ?? "")), [
          { key: "flow", prompt: input.question, ...(input.options === undefined ? {} : { options: [...input.options] }) },
        ]);
        return String(asked.id);
      },
    }),
  });
};

const exampleToolProviders = (backend: ExampleBackend) => [
  { id: "example.notes-tools", async listTools() { return buildTools(backend); } },
  /**
   * The kit's own tools — REQ-039 (#188).
   *
   * `fetch_url`, `calculate` and `now` used to be written out in this file. They are not domain tools; every
   * application needs them, and this one having its own copies is what "the platform ships zero tools" looked
   * like from the inside. They come from the library now, and what is left in `buildTools` is the part that is
   * genuinely about notes.
   *
   * Wiring is the toggle: an HTTP client is supplied, so the web tools exist. No search provider is configured,
   * so there is no `web_search` — rather than one that always answers "not configured", which costs the model a
   * turn to discover. **No SQL either, deliberately**: this app's pool is read-write, and `createSqlQuery`
   * requires a `readOnly: true` acknowledgement that would be a lie here. Wiring it would make `sql_query`'s
   * `read` classification false, which no test could catch.
   */
  createStandardToolProvider({
    deps: { authorization, idempotency: backend.idempotency, approvals: approvalGateFor(backend) },
    http: {},
    /**
     * The filesystem tools, when a root is configured — task #215.
     *
     * `fs_read`, `fs_list` and `fs_search` appear together; `fs_write` needs the second root as well. Path
     * scoping, the symlink refusal and the byte ceiling are the toolkit's, not this app's.
     */
    ...(exampleFilesystem() === undefined ? {} : { filesystem: exampleFilesystem() as never }),
    /**
     * `shell_exec`, and both of its switches — task #215.
     *
     * The sandbox is one; the `shell` capability declaration is the other, read at the call. A deployment that
     * wired an image for a test and forgot must not thereby have an agent that runs commands.
     */
    ...(exampleSandbox() === undefined ? {} : { sandbox: exampleSandbox() as never, shellEnabled: exampleShellDeclared }),
    // A search provider from `@retinue/tools-search` when one is configured, and no `web_search` otherwise
    // (#214). Note that the toolkit contributes a *provider*, not a tool: five vendors are five values of one
    // parameter, so switching from Brave to Tavily changes an environment variable and nothing else.
    ...(searchProviderFrom(process.env) === undefined ? {} : { search: searchProviderFrom(process.env) }),
  }),
  /**
   * The integration toolkits — one call each, and nothing in `backend/` knows they exist (#214 AC-2).
   *
   * They arrive through the same registry as everything else, so a GitHub write inherits the approval gate, the
   * idempotency key, the authorization filter and the audit trail rather than bringing its own rules.
   */
  ...exampleToolkits(process.env),
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
    dispatcher: createBullMqJobDispatcher(createBullMqRunQueue({ url: process.env["RETINUE_REDIS_URL"] ?? "" })),
    runs: backend.runs,
  });

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
    /**
     * `find_tools` — task #210. Keyword-only: no `embeddings` is wired, deliberately.
     *
     * #221 measured selection accuracy as flat from 20 to 200 tools, so the case for search is context cost
     * rather than accuracy, and paying an embedding provider per catalogue would be spending money on a problem
     * this app does not have. The seam is one argument away when a deployment's catalogue is large enough to
     * need it.
     */
    search: createToolSearch(),
    ...(exampleToolset() === undefined ? {} : { toolsets: { resolve: async () => exampleToolset() as never } }),
    /**
     * The client's view of the catalogue is bounded too — task #210, AC-3.
     *
     * Two budgets, deliberately: this one bounds what a *client* renders, and the engine's bounds what the model
     * is given. They are different lists — the model gets preloaded descriptors with schemas, a client gets
     * compact entries — so one number applied in one place would leave the other unbounded while looking
     * capped.
     */
    ...(exampleCatalogBudget() === undefined ? {} : { catalogBudget: exampleCatalogBudget() as never }),
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
          // From the manifest, not a literal — task #244. Two copies of a policy is one copy too many.
          ...exampleAgentManifest.skillPolicy,
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
   * Readiness has to include Redis, because this app cannot work without it.
   *
   * The host only probes Redis if the app hands it a connection, and this app did not -- so `/readyz`
   * answered "ready" with Redis down, and traffic arrived at a process that could not take a
   * per-conversation lock or enqueue a run. Postgres being reachable says nothing about that.
   *
   * One connection, built once at boot: `cli.ts` calls this a single time and keeps the result for the
   * probe, so this is not a connection per health check.
   */
  redis: (config: { readonly redisUrl: string }) => new Redis(config.redisUrl),

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

  deps({ config, sql, runner }: { config: RetinueConfig; sql: SqlExecutor; runner?: TransactionRunner }): ResolverDeps {
    /**
     * The Postgres composition, assembled once — #155 AC-7.
     *
     * `deps` and `engine` used to build a dozen stores each from `sql`, which made the whole app module a
     * Postgres application. Threading a bundle instead is what lets the single-process mode reuse *this* wiring
     * rather than carry a copy — and a copy is how a difference creeps in unnoticed, which is the shape of both
     * #157 and #161.
     */
    const backend = postgresBackend(sql, createRedisLiveEventSource(new Redis(config.redisUrl)), runner, authorization);
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
      // Search and the tenant's toolset, wired the same way on every path — a catalogue that answered
      // differently depending on which code path asked would be worse than not having either.
      search: createToolSearch(),
      ...(exampleToolset() === undefined ? {} : { toolsets: { resolve: async () => exampleToolset() as never } }),
      ...(exampleCatalogBudget() === undefined ? {} : { catalogBudget: exampleCatalogBudget() as never }),
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
        /**
         * The ledger, for a rolling window — #181.
         *
         * Optional on the guard, and omitting it is not benign: a rolling limit then refuses every run with "a
         * rolling quota window needs a UsageStore". Which is the correct direction — a spend guard that cannot
         * read spend must not be the thing that says yes — but it means the wiring has to be here, not left for
         * whoever first configures `rolling:300`.
         */
        usage: createPostgresUsageStore(sql),
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

  engine({ sql }: { config: RetinueConfig; sql: SqlExecutor }) {
    // The worker needs no realtime *source*, so it is absent rather than invented. It also gets no
    // `TransactionRunner`, which is why the backend's coordinator has to be the lazy one — see `stores.ts`.
    // The worker gets the policy too: it is the process that *reads* an attachment to put it in a turn, so
    // without a file service here an uploaded image would resolve in the API and vanish in the worker (#185).
    return composeEngine(
      postgresBackend(sql, { subscribe: () => { throw new Error("the worker does not subscribe"); } } as never, undefined, authorization),
    );
  },

  buildContext: (run: Run) => buildWorkerContext(run),

  /**
   * A settled run wakes whatever flow was waiting for it — #202.
   *
   * A factory over `{ config, sql }`, exactly like `engine`, because the hook needs the same composition the
   * worker was built with. Built once per worker rather than per run: a runner constructed over a stale executor
   * is the shape that fails after a connection drop, and constructing one per settled run would do that on every
   * chat turn in the deployment.
   *
   * This is the **fast** path only. Correctness lives in the flow runner's poll, which reads the child's state on
   * every resume — a crash between the child completing and this firing loses the message, and a parent that only
   * woke on notifications would sit forever with nothing looking again.
   */
  onRunSettled({ sql }: { readonly config: RetinueConfig; readonly sql: SqlExecutor }) {
    const backend = postgresBackend(
      sql,
      { subscribe: () => { throw new Error("the settled-run listener does not subscribe"); } } as never,
      undefined,
      authorization,
    );
    const runner = exampleFlowRunner(backend);
    if (runner === undefined) return undefined;
    return async ({ context, run }: { readonly context: ExecutionContext; readonly run: Run }) => {
      // `notifyRunFinished` returns null when nothing was waiting for this run, which is the common case: most
      // runs in this app are chat turns.
      await runner.notifyRunFinished(context, run.id);
    };
  },
};

/**
 * The agent, composed from ports — one wiring for both adapters (#155 AC-7).
 *
 * Everything below is adapter-agnostic: the manifest, the tools, the registry, the approval loop, the skills,
 * the modes, the context providers. That is the claim ports-and-adapters makes, and this function is where it
 * is finally load-bearing rather than asserted — the memory composition calls exactly this.
 */
/**
 * This app's capability declaration — #198.
 *
 * The example is a chat assistant, so it starts from that profile. Every "on" here has its dependency wired
 * below, and `resolveCapabilities` is what *proves* that rather than asserting it: an entry that loses its
 * wiring fails at construction with the capability named, instead of going quiet — which is how #157, #159,
 * #161, #163, #165 and #185 each survived their own tests.
 *
 * Written out rather than left to the profile, because a reader of this file should be able to see what the app
 * does without opening the platform.
 */
export const exampleCapabilities = () =>
  resolveCapabilities({
    profile: "assistant",
    capabilities: {
      // The docs MCP server is composed per role rather than in the base runtime, so it is off here and the
      // declaration stays true of *this* configuration rather than of what the app could do.
      mcp: "off",
      /**
       * `shell` — task #215, and the one capability whose declaration is a security decision.
       *
       * From the environment, and `resolveCapabilities` refuses to return a runtime whose declaration and wiring
       * disagree: declaring this with no sandbox image is a **boot failure**, not a tool that quietly refuses at
       * the first call. That is the whole value of the capability declaration existing.
       */
      shell: exampleShellDeclared() ? "on" : "off",
    },
    wired: new Set([
      "messages",
      "principalMemory",
      "summaries",
      "summarizer",
      "citations",
      "interactions",
      "skills",
      "usage",
      ...(exampleSandbox() === undefined ? [] : ["sandbox"]),
    ]),
  });

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
      // Search and the tenant's toolset, wired the same way on every path — a catalogue that answered
      // differently depending on which code path asked would be worse than not having either.
      search: createToolSearch(),
      ...(exampleToolset() === undefined ? {} : { toolsets: { resolve: async () => exampleToolset() as never } }),
      ...(exampleCatalogBudget() === undefined ? {} : { catalogBudget: exampleCatalogBudget() as never }),
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
        dispatcher: createBullMqJobDispatcher(createBullMqRunQueue({ url: process.env["RETINUE_REDIS_URL"] ?? "" })),
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
            /**
             * Forwarded, or a per-unit provider under-bills every multimodal turn — #185 AC-4.
             *
             * Whether these change the figure is the *pricing record's* decision, not this app's:
             * `computeModelCostMinorUnits` ignores them unless the record says the provider charges separately.
             * So passing them is free where it does not apply and correct where it does — and dropping them here
             * would be a silent shortfall that scales with every image anyone sends.
             */
            ...(usage.imageCount === undefined ? {} : { imageCount: usage.imageCount }),
            ...(usage.audioSeconds === undefined ? {} : { audioSeconds: usage.audioSeconds }),
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
        const turns = await conversationTurns({
          stores: backend,
          tenantId: String(context.tenantId),
          conversationId: String(context.conversationId),
          // The compacted form, which is what compaction is for. The page reads the full transcript.
          compacted: true,
        });
        /**
         * Attachments resolved into parts the model can see — #185 AC-1 and AC-3.
         *
         * Through `createAttachmentResolver`, which reads via `FileService`, so an image reaches the model on
         * exactly the terms `read_attachment` would have given it: the same entitlement check, the same refusal
         * when the file is not this caller's. Building the parts from the stores here would have been shorter
         * and would have made the modality bridge a way around file authorization.
         *
         * `accepts` comes from the resolved model, so a model without vision produces a *named* skip — "shot.png
         * is image, which the selected model does not accept" — rather than a refused turn that does not say
         * which attachment caused it.
         */
        const attachments = attachmentResolver(backend);
        if (attachments === undefined) return historyForModel(turns);
        return historyForModelWithAttachments(turns, {
          resolver: attachments,
          context,
          accepts: resolved.definition.inputModalities,
        });
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
          /**
           * ...and the kit's categories, which is the same lesson learned twice — REQ-039 (#188).
           *
           * The list above said `["assistant", "mcp:…"]`, so the fifteen tools from `@retinue/agentkit/tools` —
           * `web`, `data`, `general` — were registered, authorized, listed in the catalogue, and never handed to
           * the model. The only symptom was the assistant declining to fetch a URL it appeared to have a tool
           * for, which reads as a model problem and is not one.
           *
           * Spread from the library's own export rather than typed out here: a hand-kept copy of someone else's
           * category list is a copy that goes stale the next time they add one, and the failure is silent.
           */
          categories: ["assistant", `mcp:${DOCS_MCP_SERVER_ID}`, ...STANDARD_TOOL_CATEGORIES],
          excluded: [],
        });
        const catalog = {
          preloaded: all.preloaded.filter((d) => !blocked.has(String(d.effect))),
        };
        const preloaded = catalog.preloaded.map((descriptor) => ({
          name: descriptor.name,
          description: descriptor.description,
          ...(descriptor.inputSchema === undefined ? {} : { inputSchema: descriptor.inputSchema }),
          async execute(input: unknown) {
            return registry.execute(context, { name: descriptor.name, input });
          },
        }));

        /**
         * `find_tools`, handed to the model — task #210, AC-1.
         *
         * From `all.meta` rather than typed out, so it appears only when the registry actually has a search
         * wired. The schema is written here because a meta-tool descriptor carries none: the registry validates
         * these arguments itself, and a permissive schema would let the SDK stream `{}` — the #155 defect this
         * file's own comments describe.
         *
         * Without this the whole mechanism would be built, tested and unreachable: a budget could drop a tool
         * and the model would have no way back to it, which is the difference between a deferral and an
         * amputation.
         */
        const find = all.meta.find((entry) => entry.name === "find_tools");
        const findTool =
          find === undefined
            ? []
            : [
                {
                  name: find.name,
                  description: find.description,
                  inputSchema: {
                    type: "object",
                    properties: {
                      query: { type: "string", description: "What you are trying to do, in your own words." },
                      limit: { type: "number", description: "How many tools to return. Default 10." },
                    },
                    required: ["query"],
                  },
                  async execute(input: unknown) {
                    return registry.execute(context, { name: "find_tools", input });
                  },
                },
              ];

        /**
         * `execute_tool` — task #210, and the thing that makes `find_tools` worth having.
         *
         * A found tool is by definition not in this turn's list, so without this the model learns a name it
         * cannot call. It goes through `registry.execute`, so authorization, the toolset, the approval gate and
         * the idempotency key all apply exactly as they would to a direct call — the indirection is a way to
         * *reach* a tool, never a way around anything.
         */
        const learnTool =
          find === undefined
            ? []
            : [
                {
                  name: "learn_tools",
                  description:
                    "Fetch the full input schema for tools by name, including ones not listed above. Call this " +
                    "before running something you found with find_tools, so you know what arguments it takes.",
                  inputSchema: {
                    type: "object",
                    properties: { names: { type: "array", items: { type: "string" } } },
                    required: ["names"],
                  },
                  async execute(input: unknown) {
                    return registry.execute(context, { name: "learn_tools", input });
                  },
                },
              ];

        const executeTool =
          find === undefined
            ? []
            : [
                {
                  name: "execute_tool",
                  description:
                    "Run a tool by name, including one not listed above — for example one you found with " +
                    "find_tools. Approval and permissions apply exactly as they would to a direct call.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      name: { type: "string", description: "The tool's name." },
                      input: { type: "object", description: "The tool's arguments, matching its schema." },
                    },
                    required: ["name", "input"],
                  },
                  async execute(input: unknown, options?: { readonly report?: (fact: { ranToolName: string }) => void }) {
                    const result = await registry.execute(context, { name: "execute_tool", input });
                    // So the run event log names the action, not the mechanism — task #210.
                    if (result.ranToolName !== undefined) options?.report?.({ ranToolName: result.ranToolName });
                    return result;
                  },
                },
              ];

        return [...preloaded, ...findTool, ...learnTool, ...executeTool];
      },
      /** A ceiling on the tool list, when this deployment configured one — task #210, AC-3. */
      ...(exampleCatalogBudget() === undefined ? {} : { catalogBudget: exampleCatalogBudget() as never }),
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
  const { gatherSections, renderContextBlock, makeNonce } = await import("@retinue/agentkit/context");
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
    // From the manifest, not a literal — task #244.
    ...exampleAgentManifest.skillPolicy,
  });
  /**
   * The skill catalogue, budgeted — task #210, AC-5.
   *
   * The same `applyTokenBudget` the tool catalogue uses, and the notice goes into the prompt itself: a context
   * provider has no run event stream, so the model is told directly. Which is arguably the better channel —
   * being told during the turn beats being told in a log afterwards, because the model can act on it.
   */
  const skillBudget = exampleSkillCatalogBudget();
  const budgeted = skillBudget === undefined ? undefined : budgetSkillCatalogue(catalogue, skillBudget);
  const skillBlock =
    budgeted === undefined
      ? renderSkillCatalogue(catalogue)
      : `${renderSkillCatalogue(budgeted.resident)}${truncationNotice(budgeted)}`;
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
