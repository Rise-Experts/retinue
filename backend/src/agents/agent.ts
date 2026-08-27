/**
 * Embedded agent facade — `docs/03` + `docs/06` (embedded profile).
 *
 * The batteries-included entry point: `createAgent({ manifest }).run({ conversationId, message })`.
 * It wires the reference in-memory stores, the model registry + provider factory, the tool registry
 * and the default engine into the durable worker, then runs a turn to completion and returns its
 * parts. State persists across turns on the same conversation. Swap the in-memory adapters for
 * Postgres/Supabase and drive the worker from a real queue to get the server profile — same engine,
 * same contracts.
 */

import type { ExecutionContext } from "../core/context.js";
import { AgentPlatformError } from "../core/errors.js";
import { asId } from "../core/ids.js";
import type { ConversationId, MessageId, PrincipalId, RunId, TenantId } from "../core/ids.js";
import type { Message, MessagePart, TextPart } from "../core/content-parts.js";
import { createModelRegistry, computeModelCostMinorUnits } from "../models/index.js";
import type { ModelDefinition, ModelRoleAssignments } from "../models/index.js";
// From the module rather than the barrel: `models/index.ts` no longer re-exports the factory, because doing so
// made every root import load six provider SDKs (#196).
import {
  createProviderFactory,
  type ProviderCredentials,
  type ProviderFactory,
} from "../models/provider-factory.js";
import type { ModelProvider } from "../models/index.js";
import type { AuthorizationPolicy } from "../authorization/index.js";
import { gatherSections, type ContextProvider } from "../context/index.js";
import { randomBytes } from "node:crypto";
import { makeNonce, renderContextBlock } from "../security/prompt-safety.js";
import { createToolRegistry, type ToolProvider, type ToolSearch, type ToolsetResolver } from "../tools/index.js";
import type { TokenBudget } from "../core/budget.js";
import { createDurableWorker, type AgentEngine, type ProcessOutcome, type Run } from "../runtime/index.js";
import {
  createMemoryCheckpointStore,
  createMemoryRunEventLog,
  createMemoryRunStore,
} from "../adapters/memory/runtime.js";
import { createMemoryConversationStore } from "../adapters/memory/index.js";
import { createMemoryEventBus } from "../runtime/index.js";
import { createMemoryMessageStore } from "../adapters/memory/message-store.js";
import type { Guardrail } from "../guardrails/index.js";
import {
  createSkillBodyLoader,
  createSkillCatalogueProvider,
  type SkillResolver,
} from "../skills/index.js";
import { createDefaultEngine, type ResolvedModelInfo } from "./engine.js";
import type { AgentManifest } from "./index.js";
import {
  DEFAULT_MODEL_CATALOG,
  DEFAULT_ROLE_ASSIGNMENTS,
  defineAgent,
  type AgentManifestInput,
} from "./define.js";

/**
 * The policy this agent runs under — task #244, the interpreter for `authorizationPolicyId`.
 *
 * The field was declared and read by nothing, so an agent naming `"restricted"` ran under whatever the host had
 * wired — very possibly the permissive default. Three rules, and the third is the one that matters:
 *
 * 1. A map is supplied and contains the id → that policy.
 * 2. No map, and the id is `defineAgent`'s `"default"` → the single wired policy, or the permissive default.
 *    This is the normal case and stays a one-liner.
 * 3. **Any other combination is an error.** An id the deployment cannot honour must never fall through to the
 *    permissive default: an agent asking to run under a narrow policy and silently getting allow-all is the
 *    worst possible reading of this field, and it is the reading it had. Failing at construction is loud, early
 *    and cheap.
 *
 * Note the platform does not check that a named policy is *narrower* than any other. It cannot: a policy is an
 * interface the host implements, and composing two of them into an intersection would mean second-guessing a
 * deployment's own authorization. What the platform guarantees is that the policy an agent named is the policy
 * it got, or the run does not start.
 */
export const selectAuthorization = (
  config: Pick<CreateAgentConfig, "authorization" | "authorizationPolicies">,
  manifest: Pick<AgentManifest, "authorizationPolicyId" | "id">,
): AuthorizationPolicy => {
  const id = manifest.authorizationPolicyId ?? "default";
  const named = config.authorizationPolicies;
  if (named !== undefined) {
    const chosen = named[id];
    if (chosen !== undefined) return chosen;
    throw new AgentPlatformError({
      code: "capability_unavailable",
      message:
        `agent "${manifest.id}" runs under authorization policy "${id}" and no such policy is registered ` +
        `(registered: ${Object.keys(named).map((k) => `"${k}"`).join(", ") || "none"}). Refusing rather than ` +
        "falling back — an agent that asked for a narrow policy and silently got a permissive one is the " +
        "failure this field exists to prevent.",
      retryable: false,
    });
  }
  if (id !== "default")
    throw new AgentPlatformError({
      code: "capability_unavailable",
      message:
        `agent "${manifest.id}" runs under authorization policy "${id}" and none is registered. Pass ` +
        "`authorizationPolicies: { \"" +
        id +
        "\": … }`, or leave the manifest's `authorizationPolicyId` at \"default\".",
      retryable: false,
    });
  return config.authorization ?? allowAllAuthorization();
};

/**
 * The providers this agent asked for, in the order it asked — task #244.
 *
 * `AgentManifest.contextProviderIds` was declared and read by nothing, so a manifest naming two of four wired
 * providers got all four, and naming none got all of them too. Two decisions make the field meaningful without
 * making it a trap:
 *
 * - **An empty list means every wired provider**, not none. `defineAgent` defaults it to `[]`, so treating empty
 *   as "no context" would silently strip the memory, notes and attachments from every agent already written
 *   against the default. The field is a *selection*, and no selection means no narrowing.
 * - **A named id that is not wired is an error**, not a silent omission. The failure it prevents is the one worth
 *   preventing: an agent whose manifest asks for `principal-memory`, a typo or a missing wire, and an assistant
 *   that quietly remembers nothing. That reads exactly like a model that chose not to use its memory.
 *
 * Order follows the manifest, because section order is prompt order and the manifest is where an author can see
 * and control it.
 */
export const selectContextProviders = (
  wired: readonly ContextProvider[],
  manifest: Pick<AgentManifest, "contextProviderIds" | "id">,
): readonly ContextProvider[] => {
  const asked = manifest.contextProviderIds ?? [];
  if (asked.length === 0) return wired;
  const byId = new Map(wired.map((p) => [p.id, p]));
  const missing = asked.filter((id) => !byId.has(id));
  if (missing.length > 0)
    throw new AgentPlatformError({
      code: "capability_unavailable",
      message:
        `agent "${manifest.id}" asks for context provider(s) ${missing.map((m) => `"${m}"`).join(", ")} and ` +
        `nothing wired supplies them (wired: ${wired.map((p) => `"${p.id}"`).join(", ") || "none"}). An agent ` +
        "that silently runs without the context it declared is indistinguishable from a model choosing not to " +
        "use it.",
      retryable: false,
    });
  return asked.map((id) => byId.get(id)!);
};

/** Permissive policy used by the embedded facade when a caller wires tools but no authorization. */
const allowAllAuthorization = (): AuthorizationPolicy => ({
  async can() {
    return { allow: true };
  },
  async filterTools(_ctx, tools) {
    return tools;
  },
  async scope(context) {
    return { tenantId: context.tenantId, roleIds: context.roleIds };
  },
});

export type CreateAgentConfig = {
  readonly manifest: AgentManifestInput;
  /** Model catalog; defaults to a small Anthropic catalog (smart/fast). */
  readonly models?: readonly ModelDefinition[];
  readonly roleAssignments?: ModelRoleAssignments;
  readonly providerCredentials?: Partial<Record<ModelProvider, ProviderCredentials>>;
  readonly tools?: readonly ToolProvider[];
  /** Context providers (e.g. principal memory, retrieval) whose sections are prepended to the prompt. */
  readonly contextProviders?: readonly ContextProvider[];
  /**
   * Random hex for the untrusted-content delimiter nonce (#145).
   *
   * Injected so a test can pin the exact bytes of a rendered prompt; defaults to `node:crypto`. A module that
   * reaches for randomness directly is one whose output cannot be asserted, and the assertion here is precisely
   * that a forged delimiter does not survive.
   */
  readonly randomHex?: (bytes: number) => string;
  readonly authorization?: AuthorizationPolicy;
  /**
   * Named policies a manifest may select with `authorizationPolicyId` — task #244.
   *
   * Absent is the normal case: one `authorization` (or the permissive default), and every manifest carrying
   * `defineAgent`'s `"default"`. Supplying a map is how a deployment runs several agents under different
   * policies — a customer-facing agent under a narrow one, an internal agent under a wider one — without the
   * host having to build a separate registry per agent.
   */
  readonly authorizationPolicies?: Readonly<Record<string, AuthorizationPolicy>>;
  /**
   * Checks to run before the model sees a turn and before anything leaves it — REQ-046 (#205), AC-5.
   *
   * Here so a host can add one without composing the runtime by hand: this facade exists to be the short path,
   * and a guardrail that could only be wired through the long one would be a guardrail most deployments never
   * add.
   */
  readonly guardrails?: readonly Guardrail[];
  /**
   * Search over the catalogue, which is what makes `find_tools` exist — REQ-045 (#204), task #210.
   *
   * Absent means no `find_tools`. Wire it with `createToolSearch()` for keyword search, or pass an
   * `EmbeddingProvider` to it for hybrid — and see `tools/find.ts` on why keyword-only is the honest default.
   */
  readonly toolSearch?: ToolSearch;
  /** A ceiling in tokens on the tool list handed to the model — task #210, AC-3. Absent means no ceiling. */
  readonly catalogBudget?: TokenBudget;
  /** A tenant's category switches, applied before authorization — task #210, AC-4. */
  readonly toolsets?: ToolsetResolver;
  /**
   * A skill resolver — task #244, and what makes `manifest.skillPolicy` mean something.
   *
   * Wiring is the toggle, the rule `toolSearch` already follows. Supplying one adds a skills catalogue section
   * to the prompt (names and descriptions, filtered by the manifest's `assigned`/`allowTenantSkills`) and makes
   * `load_skill` real; omitting it means neither is advertised.
   */
  readonly skills?: SkillResolver;
  readonly tenantId?: string;
  /** Test/advanced seam: override how a manifest resolves to a model (e.g. a mock model). */
  readonly resolveModel?: (manifest: AgentManifest, context: ExecutionContext) => ResolvedModelInfo;
  /** Test/advanced seam: supply the engine directly instead of building the default one. */
  readonly engine?: AgentEngine;
  readonly now?: () => number;
};

export type RunInput = {
  readonly conversationId: string;
  readonly message: string;
  readonly principalId?: string;
  readonly roleIds?: readonly string[];
};

export type RunResult = {
  readonly runId: string;
  readonly outcome: ProcessOutcome;
  readonly parts: readonly MessagePart[];
  /** Convenience: the assistant's concatenated text. */
  readonly text: string;
};

const textOf = (parts: readonly MessagePart[]): string =>
  parts.filter((p): p is TextPart => p.type === "text").map((p) => p.text).join("");

/** The default nonce source. Real randomness, so a delimiter cannot be predicted across runs. */
const defaultRandomHex = (bytes: number): string => randomBytes(bytes).toString("hex");

export const createAgent = (config: CreateAgentConfig) => {
  const manifest = defineAgent(config.manifest);
  const tenantId = asId<TenantId>(config.tenantId ?? "default");
  const now = config.now ?? Date.now;

  const conversations = createMemoryConversationStore();
  const runs = createMemoryRunStore();
  const checkpoints = createMemoryCheckpointStore();
  const eventLog = createMemoryRunEventLog();
  const bus = createMemoryEventBus();
  const messages = createMemoryMessageStore();

  const registry = createModelRegistry({
    models: config.models ?? DEFAULT_MODEL_CATALOG,
    roles: config.roleAssignments ?? DEFAULT_ROLE_ASSIGNMENTS,
  });
  const providerFactory: ProviderFactory = createProviderFactory({ credentials: config.providerCredentials ?? {} });
  const authorization = selectAuthorization(config, manifest);
  /**
   * Skills, when a resolver is wired — #244.
   *
   * Both halves read the *same* policy, and that is the point: `createSkillBodyLoader` re-derives the catalogue
   * before loading, so `assigned` and `allowTenantSkills` gate loading as well as listing. A policy that
   * filtered the list but not the load would be no policy at all — a model that guessed a name would get it.
   */
  const skillPolicy = {
    assigned: manifest.skillPolicy?.assigned ?? [],
    allowTenantSkills: manifest.skillPolicy?.allowTenantSkills ?? false,
  };
  const skillLoader =
    config.skills === undefined ? undefined : createSkillBodyLoader({ resolver: config.skills, policy: skillPolicy });

  const toolRegistry = createToolRegistry({
    providers: config.tools ?? [],
    authorization,
    ...(config.toolSearch === undefined ? {} : { search: config.toolSearch }),
    ...(config.toolsets === undefined ? {} : { toolsets: config.toolsets }),
    ...(config.catalogBudget === undefined ? {} : { catalogBudget: config.catalogBudget }),
    ...(skillLoader === undefined ? {} : { skills: skillLoader }),
  });

  const resolveModel: NonNullable<CreateAgentConfig["resolveModel"]> =
    config.resolveModel ??
    ((m) => {
      const def = registry.resolve(m.modelPolicy);
      return {
        model: providerFactory.languageModel(def),
        modelId: def.modelId,
        currency: def.pricing.currency,
        price: (u) =>
          computeModelCostMinorUnits(def.pricing, {
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            cachedInputTokens: u.cachedInputTokens,
            // Dropped here before #247, so a cache write was billed as fresh input — and on a provider that
            // charges a premium for a write, under-billed.
            ...(u.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: u.cacheWriteTokens }),
          }),
      };
    });

  const contextProviders = [
    ...(config.contextProviders ?? []),
    ...(config.skills === undefined
      ? []
      : [createSkillCatalogueProvider({ resolver: config.skills, policy: skillPolicy })]),
  ];
  const engine = config.engine ?? createDefaultEngine({
    ...(config.guardrails === undefined ? {} : { guardrails: config.guardrails }),
    ...(config.catalogBudget === undefined ? {} : { catalogBudget: config.catalogBudget }),
    async loadManifest() {
      return manifest; // single-manifest embedded agent
    },
    resolveModel,
    ...(contextProviders.length > 0
      ? {
          /**
           * The system prompt, with external content quarantined (#145, AC-4).
           *
           * The previous version was `sections.map(s => "## " + s.title + "\n" + s.body)`. That is the one place
           * a model most readily treats text as instruction, and a section body can be a fetched page, an MCP
           * result or an extracted document. `contextProviders` is the *intended extension point* for exactly
           * that content, and nothing in the type system warned the next person who wired one.
           *
           * `renderContextBlock` groups untrusted sections after the trusted ones under a standing preamble and
           * encloses each in a nonce-delimited block with delimiter forgery neutralised. A fresh nonce per
           * assembly, so content cannot learn the delimiter from a previous turn.
           */
          systemPrompt: async (m: AgentManifest, context: ExecutionContext) => {
            const sections = await gatherSections(context, selectContextProviders(contextProviders, m));
            if (sections.length === 0) return m.instructions;
            const ctxText = renderContextBlock(sections, makeNonce(config.randomHex ?? defaultRandomHex));
            return `${m.instructions}\n\n# Context\n${ctxText}`;
          },
        }
      : {}),
    async loadHistory(context) {
      /**
       * The non-null assertion is gone — #198. It was the only thing standing between a conversation-less run
       * and a query keyed on `undefined`, which Postgres would have accepted as a literal and returned nothing
       * for. A refusal that names the capability is the whole point of making the field optional.
       */
      if (context.conversationId === undefined)
        throw new AgentPlatformError({
          code: "invalid_input",
          message:
            "history needs a conversation, and this context has none. The embedded runtime is conversation-based; " +
            "for a run without one, use the composed runtime with history turned off.",
          retryable: false,
        });
      const page = await messages.listByConversation({ tenantId: context.tenantId, conversationId: context.conversationId, limit: 1_000 });
      return page.items.map((m) => ({
        role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
        // Text only here, deliberately: the embedded facade has no file store to resolve an attachment
        // through, and inventing one would be the modality bridge going around file authorization — the
        // failure #185 exists to avoid, reintroduced by the convenience path.
        content: textOf(m.parts),
      }));
    },
    ...(config.tools && config.tools.length > 0
      ? {
          /**
           * The tools this turn, through the registry rather than around it — task #210.
           *
           * This used to gather the providers itself and filter them with `authorization.filterTools`, which was
           * a second copy of what the registry does: no duplicate-name check, and — once tenant toolsets existed
           * — no toolset either, so a switched-off category was hidden everywhere except in the list actually
           * handed to the model.
           */
          buildTools: async (context: ExecutionContext) => {
            const descriptors = await toolRegistry.listAuthorized(context);
            const resolvedTools: { name: string; description?: string; inputSchema?: unknown; execute: (i: unknown) => Promise<unknown> }[] =
              descriptors.map((descriptor) => ({
                name: descriptor.name,
                description: descriptor.description,
                // Carried through so the engine can honour `toolPolicy.categories` without reaching back into
                // the registry for a descriptor it already handed over — #244.
                category: descriptor.category,
                inputSchema: descriptor.inputSchema,
                execute: async (input: unknown) => {
                  const result = await toolRegistry.execute(context, { name: descriptor.name, input });
                  if (!result.ok) throw new AgentPlatformError(result.error);
                  return result.data;
                },
              }));

            /**
             * `find_tools`, when a search is wired — task #210, AC-1.
             *
             * Its schema is written here because a meta-tool descriptor carries none, and a model handed a
             * permissive schema streams `{}` for every call. The registry validates the arguments itself.
             */
            /**
             * `execute_tool`, alongside search — task #210.
             *
             * Without it `find_tools` is a dead end: the tool it names is not in this turn's list (that is why
             * it had to be searched for), so the model learns a name it cannot call. Added whenever search or a
             * budget is configured, which are exactly the cases where the list is partial.
             */
            if (config.toolSearch !== undefined || config.catalogBudget !== undefined) {
              resolvedTools.push({
                name: "execute_tool",
                description:
                  "Run a tool by name — including one that is not listed here, for example one you found with " +
                  "find_tools. Authorization and approval apply exactly as they would to a direct call.",
                inputSchema: {
                  type: "object",
                  properties: {
                    name: { type: "string", description: "The tool's name." },
                    input: { type: "object", description: "The tool's arguments, matching its schema." },
                  },
                  required: ["name", "input"],
                },
                execute: async (input: unknown, options?: { readonly report?: (fact: { ranToolName: string }) => void }) => {
                  const result = await toolRegistry.execute(context, { name: "execute_tool", input });
                  // What actually ran, so the run event log names the action rather than the mechanism.
                  if (result.ranToolName !== undefined) options?.report?.({ ranToolName: result.ranToolName });
                  if (!result.ok) throw new AgentPlatformError(result.error);
                  return result.data;
                },
              });
            }

            if (config.toolSearch !== undefined || config.catalogBudget !== undefined) {
              resolvedTools.push({
                name: "learn_tools",
                description:
                  "Fetch the full input schemas for tools by name — including ones not listed here. Call this " +
                  "before running a tool you found with find_tools, so you know what arguments it takes.",
                inputSchema: {
                  type: "object",
                  properties: { names: { type: "array", items: { type: "string" } } },
                  required: ["names"],
                },
                execute: async (input: unknown) => {
                  const result = await toolRegistry.execute(context, { name: "learn_tools", input });
                  if (!result.ok) throw new AgentPlatformError(result.error);
                  return result.data;
                },
              });
            }

            if (config.toolSearch !== undefined) {
              resolvedTools.push({
                name: "find_tools",
                description:
                  "Search for a tool by describing what you need to do. Not all available tools are listed, so " +
                  "search before concluding that something cannot be done. Run what you find with execute_tool.",
                inputSchema: {
                  type: "object",
                  properties: {
                    query: { type: "string", description: "What you are trying to do, in your own words." },
                    limit: { type: "number", description: "How many tools to return. Default 10." },
                  },
                  required: ["query"],
                },
                execute: async (input: unknown) => {
                  const result = await toolRegistry.execute(context, { name: "find_tools", input });
                  if (!result.ok) throw new AgentPlatformError(result.error);
                  return result.data;
                },
              });
            }

            return resolvedTools;
          },
        }
      : {}),
  });

  // Per-run execution context, so the worker's buildContext returns the right principal/conversation.
  const contextByRun = new Map<string, ExecutionContext>();
  const worker = createDurableWorker({
    runs,
    checkpoints,
    publisher: bus.publisher,
    eventLog,
    engine,
    workerId: "embedded",
    now,
    buildContext: (run: Run) => contextByRun.get(run.id)!,
  });

  let seq = 0;

  return {
    manifest,
    /** Run one turn to completion and return the assistant's parts. State persists on the conversation. */
    async run(input: RunInput): Promise<RunResult> {
      const conversationId = asId<ConversationId>(input.conversationId);
      const principalId = asId<PrincipalId>(input.principalId ?? "user");
      const runId = asId<RunId>(`run-${(seq += 1)}`);
      const context: ExecutionContext = {
        tenantId,
        principalId,
        roleIds: (input.roleIds ?? []).map((r) => asId(r)),
        locale: "en",
        timezone: "UTC",
        requestId: asId(`req-${seq}`),
        conversationId,
        runId,
      };
      contextByRun.set(runId, context);

      if (!(await conversations.findById({ tenantId, id: conversationId }))) {
        await conversations.create({ tenantId, id: conversationId, title: input.message.slice(0, 80) || "Conversation" });
      }
      await messages.append({ tenantId, message: userMessage(conversationId, `${runId}:user`, input.message) });
      await runs.create({ tenantId, id: runId, conversationId, agentId: asId(manifest.id), agentVersion: manifest.version });

      const result = await worker.process({ tenantId, runId });
      const checkpoint = await checkpoints.latest({ tenantId, runId });
      const parts = checkpoint?.parts ?? [];
      // Persist the assistant turn so the next run's history includes it.
      if (parts.length > 0) {
        await messages.append({ tenantId, message: assistantMessage(conversationId, `${runId}:assistant`, parts) });
      }
      contextByRun.delete(runId);

      return { runId, outcome: result.outcome, parts, text: textOf(parts) };
    },
  };
};

const userMessage = (conversationId: ConversationId, id: string, text: string): Message => ({
  id: asId<MessageId>(id),
  conversationId,
  role: "user",
  parts: [{ id: asId(`${id}:0`), type: "text", schemaVersion: 1, createdAt: new Date(0).toISOString(), text } as TextPart],
  createdAt: new Date(0).toISOString(),
});

const assistantMessage = (conversationId: ConversationId, id: string, parts: readonly MessagePart[]): Message => ({
  id: asId<MessageId>(id),
  conversationId,
  role: "assistant",
  parts,
  createdAt: new Date(0).toISOString(),
});
