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
import {
  createModelRegistry,
  computeModelCostMinorUnits,
  createProviderFactory,
  type ModelDefinition,
  type ModelRoleAssignments,
  type ProviderCredentials,
  type ProviderFactory,
} from "../models/index.js";
import type { ModelProvider } from "../models/index.js";
import type { AuthorizationPolicy } from "../authorization/index.js";
import { gatherSections, type ContextProvider } from "../context/index.js";
import { randomBytes } from "node:crypto";
import { makeNonce, renderContextBlock } from "../security/prompt-safety.js";
import { createToolRegistry, type ToolProvider } from "../tools/index.js";
import { createDurableWorker, type AgentEngine, type ProcessOutcome, type Run } from "../runtime/index.js";
import {
  createMemoryCheckpointStore,
  createMemoryRunEventLog,
  createMemoryRunStore,
} from "../adapters/memory/runtime.js";
import { createMemoryConversationStore } from "../adapters/memory/index.js";
import { createMemoryEventBus } from "../runtime/index.js";
import { createMemoryMessageStore } from "../adapters/memory/message-store.js";
import { createDefaultEngine, type ResolvedModelInfo } from "./engine.js";
import type { AgentManifest } from "./index.js";

/** The subset a caller must supply; everything else gets a sensible default. */
export type AgentManifestInput = Pick<AgentManifest, "id" | "name" | "instructions" | "modelPolicy"> &
  Partial<AgentManifest>;

export const DEFAULT_EXECUTION_LIMITS: AgentManifest["limits"] = {
  maxSteps: 8,
  maxToolCalls: 16,
  wallClockTimeoutMs: 120_000,
  maxInputTokens: 100_000,
  maxOutputTokens: 4_096,
  costCeilingMinorUnits: 100_000,
  maxRetries: 5,
  retryBackoffMs: 500,
  maxInlineToolOutputBytes: 8_192,
};

/** Fill a partial manifest with defaults so the common case is a few fields. */
export const defineAgent = (input: AgentManifestInput): AgentManifest => ({
  version: 1,
  description: "",
  responseFormat: { kind: "text" },
  toolPolicy: { preloaded: [], categories: [], excluded: [] },
  skillPolicy: { assigned: [], allowTenantSkills: false },
  authorizationPolicyId: "default",
  contextProviderIds: [],
  limits: DEFAULT_EXECUTION_LIMITS,
  ...input,
});

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
  const authorization = config.authorization ?? allowAllAuthorization();
  const toolRegistry = createToolRegistry({ providers: config.tools ?? [], authorization });

  const resolveModel: NonNullable<CreateAgentConfig["resolveModel"]> =
    config.resolveModel ??
    ((m) => {
      const def = registry.resolve(m.modelPolicy);
      return {
        model: providerFactory.languageModel(def),
        modelId: def.modelId,
        currency: def.pricing.currency,
        price: (u) => computeModelCostMinorUnits(def.pricing, { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedInputTokens: u.cachedInputTokens }),
      };
    });

  const contextProviders = config.contextProviders ?? [];
  const engine = config.engine ?? createDefaultEngine({
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
            const sections = await gatherSections(context, contextProviders);
            if (sections.length === 0) return m.instructions;
            const ctxText = renderContextBlock(sections, makeNonce(config.randomHex ?? defaultRandomHex));
            return `${m.instructions}\n\n# Context\n${ctxText}`;
          },
        }
      : {}),
    async loadHistory(context) {
      const page = await messages.listByConversation({ tenantId: context.tenantId, conversationId: context.conversationId!, limit: 1_000 });
      return page.items.map((m) => ({
        role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
        text: textOf(m.parts),
      }));
    },
    ...(config.tools && config.tools.length > 0
      ? {
          buildTools: async (context: ExecutionContext) => {
            const resolvedTools: { name: string; description?: string; inputSchema?: unknown; execute: (i: unknown) => Promise<unknown> }[] = [];
            const gathered = (await Promise.all((config.tools ?? []).map((p) => p.listTools(context)))).flat();
            const permitted = new Set((await authorization.filterTools(context, gathered.map((t) => t.descriptor))).map((d) => d.name));
            for (const t of gathered) {
              if (!permitted.has(t.descriptor.name)) continue;
              resolvedTools.push({
                name: t.descriptor.name,
                description: t.descriptor.description,
                inputSchema: t.descriptor.inputSchema,
                execute: async (input: unknown) => {
                  const result = await toolRegistry.execute(context, { name: t.descriptor.name, input });
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
      messages.append(tenantId, userMessage(conversationId, `${runId}:user`, input.message));
      await runs.create({ tenantId, id: runId, conversationId, agentId: asId(manifest.id), agentVersion: manifest.version });

      const result = await worker.process({ tenantId, runId });
      const checkpoint = await checkpoints.latest({ tenantId, runId });
      const parts = checkpoint?.parts ?? [];
      // Persist the assistant turn so the next run's history includes it.
      if (parts.length > 0) messages.append(tenantId, assistantMessage(conversationId, `${runId}:assistant`, parts));
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

/** A small default catalog so `modelPolicy: { role: "smart" }` resolves out of the box. */
export const DEFAULT_MODEL_CATALOG: readonly ModelDefinition[] = [
  {
    provider: "anthropic",
    modelId: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    lifecycle: "generally-available",
    inputModalities: ["text", "image"],
    capabilities: { tools: true, structuredOutput: true, reasoning: true, nativeSearch: false },
    limits: { contextTokens: 200_000, maxOutputTokens: 8_192 },
    pricing: { currency: "USD", inputPerMillion: 3_000, outputPerMillion: 15_000 },
    dataResidency: ["us"],
  },
  {
    provider: "anthropic",
    modelId: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5",
    lifecycle: "generally-available",
    inputModalities: ["text", "image"],
    capabilities: { tools: true, structuredOutput: true, reasoning: false, nativeSearch: false },
    limits: { contextTokens: 200_000, maxOutputTokens: 8_192 },
    pricing: { currency: "USD", inputPerMillion: 800, outputPerMillion: 4_000 },
    dataResidency: ["us"],
  },
];

export const DEFAULT_ROLE_ASSIGNMENTS: ModelRoleAssignments = {
  smart: ["claude-sonnet-5"],
  fast: ["claude-haiku-4-5-20251001"],
};
