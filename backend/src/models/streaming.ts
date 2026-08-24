/**
 * Neutral model-turn streaming — `docs/03-intelligence-runtime.md`.
 *
 * The one place the Vercel AI SDK's `streamText` tool loop is used (boundary rule R3 keeps the SDK
 * inside `models/`). It runs a multi-step turn — the model calls tools, their results feed back, it
 * continues — and yields provider-neutral chunks. The agent engine consumes these chunks without
 * ever importing the SDK, so switching providers changes nothing above this layer.
 */

import { jsonSchema, stepCountIs, streamText, tool as aiTool, type LanguageModel, type ModelMessage, type ToolSet } from "ai";

/** Opaque handle to a provider model. Aliased here so layers above `models/` never import the SDK. */
export type ResolvedModel = LanguageModel;

/** A conversation turn message the engine hands down (text-only for v1; multimodal is additive). */
export type TurnMessage = { readonly role: "system" | "user" | "assistant"; readonly text: string };

/** A tool the model may call this turn. `execute` is the platform's guarded execution path. */
export type ModelTurnTool = {
  readonly name: string;
  readonly description?: string;
  /** Zod schema or JSON-schema object; a permissive object schema is used when absent. */
  readonly inputSchema?: unknown;
  execute(input: unknown): Promise<unknown>;
};

export type ModelTurnRequest = {
  readonly model: ResolvedModel;
  readonly system?: string;
  readonly messages: readonly TurnMessage[];
  readonly tools?: readonly ModelTurnTool[];
  readonly maxSteps?: number;
  readonly abortSignal?: AbortSignal;
  /**
   * Generation parameters — #160.
   *
   * None of these existed, and none was sent: `streamText` was called with model, system, messages, tools and
   * `stopWhen` only. So `ModelDefinition.limits.maxOutputTokens` was **decorative** in the text path — a
   * definition declaring a 4,096-token cap capped nothing, and a run got whatever the provider's default
   * happened to be. `models/vision.ts` was the only place that applied it.
   *
   * `temperature` matters for a second reason: the evaluation harness (#141) rests its reproducibility argument
   * partly on temperature zero, and there was no way to ask for it on a real run.
   */
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stopSequences?: readonly string[];
};

export type NeutralUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningTokens?: number;
};

/** Provider-neutral stream chunk — the engine maps these to `RunEvent`s. */
export type NeutralStreamChunk =
  | { readonly type: "text-delta"; readonly id: string; readonly text: string }
  | { readonly type: "tool-call"; readonly toolCallId: string; readonly toolName: string; readonly input: unknown }
  | { readonly type: "tool-result"; readonly toolCallId: string; readonly toolName: string; readonly output: unknown }
  | { readonly type: "finish"; readonly usage: NeutralUsage }
  | { readonly type: "error"; readonly error: unknown };

const isZodSchema = (s: unknown): boolean =>
  typeof s === "object" && s !== null && typeof (s as { safeParse?: unknown }).safeParse === "function";

/** A JSON-schema-shaped object: `{ type: "object", … }`. Enough to tell one from a Zod schema or from absence. */
const isJsonSchema = (s: unknown): boolean =>
  typeof s === "object" && s !== null && typeof (s as { type?: unknown }).type === "string";

const toToolSet = (tools: readonly ModelTurnTool[]): ToolSet => {
  const set: ToolSet = {};
  for (const t of tools) {
    set[t.name] = aiTool({
      ...(t.description ? { description: t.description } : {}),
      /**
       * A **JSON schema is honoured**, not discarded — #159.
       *
       * `ModelTurnTool.inputSchema` documents itself as "Zod schema or JSON-schema object", and every tool the
       * platform builds carries a JSON schema: that is what `defineDelegatingTool` takes and what
       * `ToolDescriptor.inputSchema` holds. The previous version kept only a Zod schema and replaced everything
       * else with a permissive `{ type: "object", additionalProperties: true }`.
       *
       * A permissive schema tells the model the tool takes *any* object — so it has no parameter names to fill in
       * and emits calls with **empty arguments**. Every JSON-schema tool in the platform was reaching the model
       * effectively undocumented, and the work it was asked to do silently did not happen: the assistant was
       * asked to remember a fact, called `remember` with `{}`, and two turns later said it knew nothing.
       *
       * Wrapping with `jsonSchema()` is all that was missing. The permissive fallback stays for a tool that
       * genuinely declares nothing, which is the only case it was meant for.
       */
      inputSchema: isZodSchema(t.inputSchema)
        ? (t.inputSchema as never)
        : isJsonSchema(t.inputSchema)
          ? jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0])
          : jsonSchema({ type: "object", additionalProperties: true }),
      execute: (input: unknown) => t.execute(input),
    });
  }
  return set;
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Run one turn and yield neutral chunks. `streamText` drives the model↔tool loop up to `maxSteps`;
 * this reads its `fullStream` and normalizes the pieces the engine cares about (text deltas, tool
 * calls/results, final usage, errors).
 */
/**
 * A short, safe message for a thrown tool error.
 *
 * Bounded and message-only. The model needs enough to decide whether to retry or explain, and a validation
 * message ("expected string, received undefined") is exactly that — but the value lands in the durable event log,
 * so it is truncated and the object itself never travels.
 */
const errorCodeOf = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0 && code.length <= 64) return code;
    const name = (error as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return "tool-failed";
};

const errorMessageOf = (error: unknown): string => {
  const message =
    typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : String(error);
  return message.slice(0, 200);
};

export async function* streamModelTurn(req: ModelTurnRequest): AsyncIterable<NeutralStreamChunk> {
  const messages: ModelMessage[] = req.messages.map((m) => ({ role: m.role, content: m.text }) as ModelMessage);
  const result = streamText({
    model: req.model,
    ...(req.system ? { system: req.system } : {}),
    messages,
    ...(req.tools && req.tools.length > 0 ? { tools: toToolSet(req.tools) } : {}),
    stopWhen: stepCountIs(req.maxSteps ?? 8),
    ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
    // Spread conditionally so an unset parameter leaves the provider's own default alone, rather than pinning it
    // to a value this layer invented. #160: none of these was sent at all before.
    ...(req.maxOutputTokens === undefined ? {} : { maxOutputTokens: req.maxOutputTokens }),
    ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    ...(req.topP === undefined ? {} : { topP: req.topP }),
    ...(req.stopSequences === undefined ? {} : { stopSequences: [...req.stopSequences] }),
  });

  for await (const chunk of result.fullStream) {
    switch (chunk.type) {
      case "text-delta":
        yield { type: "text-delta", id: (chunk as { id?: string }).id ?? "text", text: (chunk as { text?: string }).text ?? "" };
        break;
      case "tool-call":
        yield {
          type: "tool-call",
          toolCallId: (chunk as { toolCallId: string }).toolCallId,
          toolName: (chunk as { toolName: string }).toolName,
          input: (chunk as { input?: unknown }).input,
        };
        break;
      case "tool-result":
        yield {
          type: "tool-result",
          toolCallId: (chunk as { toolCallId: string }).toolCallId,
          toolName: (chunk as { toolName: string }).toolName,
          output: (chunk as { output?: unknown }).output,
        };
        break;
      /**
       * A tool whose `execute` threw — #159.
       *
       * The SDK runs the tools itself and emits `tool-error` when one throws. This case did not exist, so the
       * chunk fell into `default: break` and the failure produced **no neutral chunk at all**: the model never
       * learned the call failed, the projection was left with a `tool-call` and no matching `tool-result`, and
       * the dangling call was only finalised as `tool.failed` at the end of the run — after the answer had
       * already been written. A user asked the assistant to remember something and was told, two turns later,
       * that it knew nothing about them.
       *
       * Mapped to a `tool-result` carrying an error payload rather than to a bare `error`, and that choice is the
       * point: a bare error is a *run* failure, but a tool failing is a normal thing the model should see and
       * respond to. Emitting it as the call's result both resolves the dangling call and puts the failure in the
       * model's own history, so it can retry or say what went wrong.
       */
      case "tool-error":
        yield {
          type: "tool-result",
          toolCallId: (chunk as { toolCallId: string }).toolCallId,
          toolName: (chunk as { toolName: string }).toolName,
          output: {
            ok: false,
            // The message only, never the thrown object: a stack or a cause chain routinely carries a URL with a
            // token in it, and this value goes into the run's durable event log. Same rule as #143's `recordError`.
            error: {
              code: errorCodeOf((chunk as { error?: unknown }).error),
              message: errorMessageOf((chunk as { error?: unknown }).error),
            },
          },
        };
        break;
      case "error":
        yield { type: "error", error: (chunk as { error: unknown }).error };
        break;
      case "finish": {
        const usage = (chunk as { totalUsage?: Record<string, unknown> }).totalUsage ?? {};
        yield {
          type: "finish",
          usage: {
            inputTokens: num(usage.inputTokens),
            outputTokens: num(usage.outputTokens),
            cachedInputTokens: num(usage.cachedInputTokens),
            ...(usage.reasoningTokens !== undefined ? { reasoningTokens: num(usage.reasoningTokens) } : {}),
          },
        };
        break;
      }
      default:
        break;
    }
  }
}
