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

const toToolSet = (tools: readonly ModelTurnTool[]): ToolSet => {
  const set: ToolSet = {};
  for (const t of tools) {
    set[t.name] = aiTool({
      ...(t.description ? { description: t.description } : {}),
      inputSchema: isZodSchema(t.inputSchema)
        ? (t.inputSchema as never)
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
export async function* streamModelTurn(req: ModelTurnRequest): AsyncIterable<NeutralStreamChunk> {
  const messages: ModelMessage[] = req.messages.map((m) => ({ role: m.role, content: m.text }) as ModelMessage);
  const result = streamText({
    model: req.model,
    ...(req.system ? { system: req.system } : {}),
    messages,
    ...(req.tools && req.tools.length > 0 ? { tools: toToolSet(req.tools) } : {}),
    stopWhen: stepCountIs(req.maxSteps ?? 8),
    ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
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
