/**
 * The tools the model is handed for a turn — retinue REQ-041 (#190).
 *
 * `createDefaultEngine`'s `buildTools`. Its own file because three of the four decisions here were
 * defects in the reference application first, and each is invisible in exactly the way that makes it
 * expensive:
 *
 *  1. **The input schema must travel with a preloaded descriptor.** Map a catalogue entry to
 *     `{name, description}` and the schema is gone; `streamModelTurn` then substitutes a permissive
 *     object schema, the SDK has nothing to parse streamed arguments into, and **every tool call
 *     arrives as `{}`**. The symptom reads as a platform streaming bug — calls with empty arguments,
 *     requested work silently not happening.
 *  2. **The categories come from the package's own export**, never a list typed here. A hand-kept copy
 *     goes stale the next time a category is added, and the tools in it are registered, authorised,
 *     listed in the catalogue and never handed to the model. The only symptom is an assistant
 *     declining to do something it appears to have a tool for.
 *  3. **Every registry meta-tool is handed over explicitly**, from `catalog.meta`. Without them the
 *     lazy catalogue is built, tested and unreachable: this deployment preloads **twenty** of
 *     fifty-eight tools, so the other thirty-eight exist only behind discovery. Their schemas are written
 *     out because a meta-tool descriptor carries none (`inputSchema: {}`), and a permissive one would
 *     reproduce (1).
 *
 *  4. **`execute_tool` is the half that was missing, and its absence was silent.** For weeks this file
 *     wired `find_tools` and nothing else, which is worse than wiring neither: the model could *find*
 *     a tool and then had no way to *call* it. What it does instead is emit a function call by that
 *     name — a name that was never declared — and Gemini answers
 *     `finishReason: UNEXPECTED_TOOL_CALL` with an **empty candidate**. The platform's `finish`
 *     handler reads `totalUsage` and never looks at `finishReason`, so the turn ended as
 *     `run.completed` with zero parts: no text, no error, no tool call. From a browser the assistant
 *     simply answered nothing.
 *
 *     It is deterministic per prompt, which is what made it look like a UI bug. "hi" needs no tool and
 *     answers. "which platforms am I connected to?" routes to `list_accounts`, which is preloaded, and
 *     answers. "How many social accounts are connected?" reaches for something outside the preloaded
 *     two and returns nothing, eight times out of eight.
 *
 *     Every direct test I ran passed, and that is the lesson worth keeping: `POST /api/tools/:name`
 *     bypasses the model entirely, so all fifty-eight tools were verified through a path no
 *     conversation uses. The tool worked; the assistant could not reach it.
 */

import { zodSchema } from "ai";

import type { ExecutionContext, ModelTurnTool, ToolRegistry } from "@retinue/agentkit";

import { SOCIAL_ASSISTANT_PRELOADED_TOOLS } from "../manifests/index.js";

/**
 * The search meta-tool's schema, written here because the descriptor carries none.
 *
 * The registry validates these arguments itself; this exists so the *provider* has something to parse
 * the model's streamed arguments into. See (1) in the header.
 */
export const FIND_TOOLS_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "What you are trying to do, in a few words." },
    limit: { type: "number", description: "How many tools to return. Defaults to a sensible few." },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

/**
 * `execute_tool`'s schema — the one that makes a discovered tool callable.
 *
 * The shape is `unwrapExecuteTool`'s in the registry: `name` is the tool to run, `input` is that
 * tool's own input, and `idempotencyKey` is passed through for the external and destructive effects
 * that require one. `input` is deliberately untyped here — it is a different shape per tool, and the
 * registry re-validates it against the real schema at execution, which is where the authoritative
 * answer lives.
 *
 * `additionalProperties: false` on the envelope but **not** on `input`: constraining the inner object
 * would reject every tool whose schema this envelope cannot know.
 */
export const EXECUTE_TOOL_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "The tool to run, as returned by find_tools." },
    input: { type: "object", description: "That tool's own input. Call learn_tools first for its schema." },
    idempotencyKey: {
      type: "string",
      description: "Required for tools that publish, send or delete. Reuse it to retry without repeating the effect.",
    },
  },
  required: ["name"],
  additionalProperties: false,
} as const;

/** `learn_tools`: the schemas for named tools, before calling them. */
export const LEARN_TOOLS_SCHEMA = {
  type: "object",
  properties: {
    names: {
      type: "array",
      items: { type: "string" },
      description: "The tools whose input and output schemas you want.",
    },
  },
  required: ["names"],
  additionalProperties: false,
} as const;

/**
 * `load_skill`: a named skill's instructions, on demand.
 *
 * Wired for the same reason as the others — this deployment ships seven active skills, and without
 * this the model has no way to load any of them, so their instructions were shipped and unreachable.
 * The registry caps how many load per run, which is its business rather than this file's.
 */
export const LOAD_SKILL_SCHEMA = {
  type: "object",
  properties: { name: { type: "string", description: "The skill whose instructions to load." } },
  required: ["name"],
  additionalProperties: false,
} as const;

/**
 * The registry meta-tools this host hands over, with the schema each needs.
 *
 * Driven off `catalog.meta` rather than this list alone: a name the platform does not offer is skipped
 * rather than declared, so a tool that exists here and not there cannot become a call the model makes
 * and the registry refuses.
 *
 * Deliberately absent, and each for a reason rather than an oversight:
 *
 * - `read_tool_output` — the registry has no `execute` branch for it, so declaring it would advertise
 *   a call that cannot be served.
 * - `ask_questions` and `request_approval` — handled by the HITL subsystem rather than the registry,
 *   and the platform's own note says the run path raises an approval itself when the gate refuses, so
 *   a model that forgot to ask is not a model that publishes unasked.
 */
const META_TOOL_SCHEMAS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  find_tools: FIND_TOOLS_SCHEMA,
  execute_tool: EXECUTE_TOOL_SCHEMA,
  learn_tools: LEARN_TOOLS_SCHEMA,
  load_skill: LOAD_SKILL_SCHEMA,
};

/**
 * A Zod schema, by the one duck-type that holds across Zod versions.
 *
 * `safeParse` rather than `_def`, because `_def` is an implementation detail that has moved and a plain
 * JSON schema could plausibly grow one; a function named `safeParse` is Zod and nothing else.
 */
const isZodSchema = (value: unknown): boolean =>
  typeof value === "object" && value !== null && typeof (value as { safeParse?: unknown }).safeParse === "function";

/**
 * `learn_tools`' answer, with its schemas turned into JSON Schema — and this fixed a **hard run failure**.
 *
 * The registry answers `learn_tools` with the descriptors themselves, schemas included, and every
 * ShareFlow descriptor carries a **Zod** schema (`defineShareFlowTool` takes one; the platform's own
 * `streamModelTurn` accepts either and converts). So the tool result handed back to the model contained
 * live Zod instances. Serialised into a checkpoint they read as `{"_def":{...},"_cached":null}`; passed
 * to the next model call they are objects with methods, and the AI SDK validates its prompt before it
 * sends one:
 *
 *   Invalid prompt: The messages do not match the ModelMessage[] schema.
 *
 * The run **failed**. Not a bad answer — no answer, and no model call at all. It happened on exactly the
 * turns where the model did the right thing: `find_tools` to discover, `learn_tools` to read the schema,
 * and then the turn died. Three of eighteen sweep prompts (comments, leads, screenshot) failed this way,
 * and all three are ones whose tools are not preloaded, which is why the failure looked like a category
 * of question the assistant could not answer.
 *
 * Converting here rather than asking the platform to: this is the boundary where a registry internal
 * becomes model context, and it is the boundary this application owns. A tool whose schema cannot be
 * converted loses its schema and keeps its description, which is a tool the model can still ask about
 * through `execute_tool` — rather than a turn that cannot happen.
 */
const learnedWithJsonSchemas = (result: unknown): unknown => {
  if (typeof result !== "object" || result === null) return result;
  const envelope = result as { ok?: unknown; data?: unknown };
  if (envelope.ok !== true || typeof envelope.data !== "object" || envelope.data === null) return result;
  const data = envelope.data as { tools?: unknown };
  if (!Array.isArray(data.tools)) return result;

  const converted = data.tools.map((entry) => {
    if (typeof entry !== "object" || entry === null) return entry;
    const tool = entry as Record<string, unknown>;
    const asJson = (schema: unknown): unknown => {
      if (!isZodSchema(schema)) return schema;
      try {
        return zodSchema(schema as never).jsonSchema;
      } catch {
        // A schema that will not convert is dropped rather than passed on: an unconvertible Zod instance
        // is exactly the value that fails prompt validation, and the description still says what the tool does.
        return undefined;
      }
    };
    return {
      ...tool,
      ...(tool["inputSchema"] === undefined ? {} : { inputSchema: asJson(tool["inputSchema"]) }),
      ...(tool["outputSchema"] === undefined ? {} : { outputSchema: asJson(tool["outputSchema"]) }),
    };
  });

  return { ...envelope, data: { ...data, tools: converted } };
};

/**
 * The registry as the **model** sees it: `learn_tools` answers in JSON Schema.
 *
 * A wrapper rather than a special case inside `createBuildTools`, because a `ModelTurnTool`'s own
 * `execute` is **not** the only path to the registry. Once `approvals` is wired, `createDefaultEngine`
 * routes every call through `RunApprovals.runTool`, which reaches `deps.tools.execute` directly and
 * never touches the tool object this file builds. A conversion living in that `execute` would have been
 * correct until the turn HITL was switched on and then silently stopped running — the same shape of
 * defect as the composition that worked in tests and not in the worker.
 *
 * So both callers take the wrapped registry, and there is one place where a registry internal becomes
 * model context.
 */
/**
 * `execute_tool` may not proxy a gated tool, because that route cannot produce an approval.
 *
 * The platform's HITL wrapper resolves a descriptor before it decides anything:
 *
 * ```js
 * const [descriptor] = await deps.tools.learn(ctx, [call.name]);
 * if (!descriptor) return { outcome: "result", result: await deps.tools.execute(ctx, call) };
 * ```
 *
 * `execute_tool` is a meta-tool and is not in `learn`'s corpus, so a gated tool reached through it
 * takes that early return. The registry's own gate still fires — `execute_tool` re-enters through the
 * public surface precisely so it does — but its `approval_required` comes back as an ordinary result
 * rather than an interaction, and the engine turns an unexpected result into a thrown error. The user
 * gets a failed run reading "Tool delete_post requires approval" with no card and nothing pending.
 *
 * Preloading every gated tool (`SOCIAL_ASSISTANT_PRELOADED_TOOLS`, asserted in `manifests.test.ts`)
 * already closes this in practice: `catalog()` puts a tool in `preloaded` **or** `discoverable` and
 * never both, so `find_tools` cannot surface a gated tool for `execute_tool` to proxy. But that is a
 * property of the platform's catalogue partitioning, not a promise to this deployment — the same kind
 * of assumption as a cast to an interface, which the compiler stops checking. So the refusal is
 * written here too, where it holds regardless.
 *
 * The message mirrors the platform's own for meta-tools — *"call it directly"* — and it is always
 * actionable, because the invariant guarantees a gated tool is declared directly on every turn.
 */
const executeToolTarget = (input: { readonly name: string; readonly input?: unknown }): string | undefined => {
  if (input.name !== "execute_tool") return undefined;
  const asked = (input.input ?? {}) as { readonly name?: unknown };
  return typeof asked.name === "string" && asked.name.trim() !== "" ? asked.name : undefined;
};

/** The target's descriptor, or `undefined` if the registry cannot say. See the note at the call site. */
const learnedDescriptor = async (
  registry: ToolRegistry,
  context: ExecutionContext,
  name: string,
): Promise<{ readonly approvalPolicy?: string } | undefined> => {
  if (typeof registry.learn !== "function") return undefined;
  try {
    const [descriptor] = await registry.learn(context, [name]);
    return descriptor;
  } catch {
    return undefined;
  }
};

export const withLearnableSchemas = (registry: ToolRegistry): ToolRegistry => ({
  ...registry,
  async execute(context, input) {
    const target = executeToolTarget(input);
    if (target !== undefined) {
      /**
       * Fails open, deliberately, and it is worth being exact about why that is safe.
       *
       * The security boundary is the registry's own `approval` check, which `execute_tool` re-enters
       * through the public surface and therefore cannot bypass — a gated call with no approval comes
       * back `approval_required` whatever happens here. This guard is not that boundary; it converts a
       * dead run into an actionable instruction. So if `learn` is unavailable or throws, the worst case
       * is the pre-fix user experience for one call, whereas failing closed would break the thirty-eight
       * discovery-only tools on a transient database error. Nothing executes unapproved either way.
       */
      const descriptor = await learnedDescriptor(registry, context, target);
      if (descriptor !== undefined && descriptor.approvalPolicy !== "never") {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message:
              `execute_tool cannot call ${target}; call it directly. It needs approval, and an ` +
              `approval raised through execute_tool cannot be presented to the user.`,
            retryable: false,
          },
        } as never;
      }
    }

    const result = await registry.execute(context, input);
    // Only `learn_tools` carries schemas out of the registry; everything else returns app data or text.
    return (input.name === "learn_tools" ? learnedWithJsonSchemas(result) : result) as never;
  },
});

export const createBuildTools =
  (registry: ToolRegistry) =>
  async (context: ExecutionContext): Promise<readonly ModelTurnTool[]> => {
    const catalog = await registry.catalog(context, {
      /**
       * The named set, from the manifest rather than repeated here.
       *
       * The smallest set that lets the assistant start work without a discovery round trip. Every
       * preloaded schema sits in context for the whole run, which is the cost the lazy catalogue exists
       * to avoid — with fifty-eight tools, preloading all of them is most of a context window spent
       * before the first word.
       */
      preloaded: [...SOCIAL_ASSISTANT_PRELOADED_TOOLS],
      /**
       * **No categories, and this line is the whole two-tier design.**
       *
       * The registry preloads a tool when `preloadNames.has(name) || preloadCategories.has(category)`.
       * This used to pass `SHAREFLOW_TOOL_CATEGORIES` — *every* category — so the second clause matched
       * every tool in the application and all fifty-eight were preloaded, with `discoverable` empty.
       * The comment above described the opposite of what the code did.
       *
       * What that cost, measured against a real Gemini call: 61 function declarations, 45,467 bytes of
       * them, a 12,162-token prompt before the user's first word — and 7 of 29 model calls returning an
       * empty candidate (`finishReason: STOP`, a candidate with no `parts` at all), which the platform's
       * `finish` handler reports as a *completed* run with nothing in it. That is the "the assistant
       * answered nothing" bug, and it was three lines of policy.
       *
       * It also made `find_tools`, `learn_tools` and `execute_tool` dead weight: there was nothing left
       * to discover, while the prompt spent a whole clause telling the model to discover things.
       */
      categories: [],
      excluded: [],
    });

    const preloaded = catalog.preloaded.map(
      (descriptor): ModelTurnTool =>
        ({
          name: descriptor.name,
          description: descriptor.description,
          // See (1): without this every call to this tool arrives with empty arguments.
          ...(descriptor.inputSchema === undefined ? {} : { inputSchema: descriptor.inputSchema }),
          async execute(input: unknown) {
            return registry.execute(context, { name: descriptor.name, input });
          },
        }) as unknown as ModelTurnTool,
    );

    /**
     * The way back to the other thirty-eight.
     *
     * From `catalog.meta` rather than assumed, so it appears only when a search is actually wired — a
     * `find_tools` handed to the model against a registry with no search would be a tool that always
     * fails, which costs a turn to discover and teaches the model not to try again.
     */
    /**
     * The meta-tools, each with the schema the descriptor does not carry.
     *
     * Built from `catalog.meta` so the platform decides what exists and this file decides only how to
     * describe it. The registry re-authorises and re-validates on execute, so handing a meta-tool over
     * grants nothing that discovery did not already allow.
     */
    const metaTools: readonly ModelTurnTool[] = catalog.meta.flatMap((entry) => {
      const inputSchema = META_TOOL_SCHEMAS[entry.name];
      if (inputSchema === undefined) return [];
      return [
        {
          name: entry.name,
          description: entry.description,
          inputSchema,
          async execute(input: unknown) {
            return registry.execute(context, { name: entry.name, input });
          },
        } as unknown as ModelTurnTool,
      ];
    });

    return [...preloaded, ...metaTools];
  };
