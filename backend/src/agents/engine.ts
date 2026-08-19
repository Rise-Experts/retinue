/**
 * Default agent engine — `docs/03-intelligence-runtime.md`.
 *
 * The concrete model loop that plugs into the durable worker's `AgentEngine` slot. It resolves the
 * agent's model, assembles the system prompt + history, exposes the authorized tools, and drives one
 * turn through the neutral `streamModelTurn` primitive (which owns the AI SDK), mapping its chunks to
 * the platform's typed `RunEvent`s. Transient provider failures are retried Claude-style — but only
 * before any output has streamed, so a retry never duplicates a partial answer; tool side effects
 * stay safe via the registry's idempotency keys.
 */

import type { ExecutionContext } from "../core/context.js";
import { AgentPlatformError } from "../core/errors.js";
import type { MessageId, MessagePartId } from "../core/ids.js";
import { asId } from "../core/ids.js";
import type { TextPart, ToolCallPart, ToolResultPart } from "../core/content-parts.js";
import type {
  ModelTurnRequest,
  ModelTurnTool,
  NeutralStreamChunk,
  NeutralUsage,
  ResolvedModel,
  TurnMessage,
} from "../models/index.js";
import { streamModelTurn } from "../models/index.js";
import {
  decideRetry,
  deriveRunMessageId,
  toPlatformError,
  DEFAULT_RETRY_POLICY,
  type AgentEngine,
  type EngineEvent,
  type EngineRunInput,
  type RetryPolicy,
  type Run,
} from "../runtime/index.js";
import type { AgentManifest } from "./index.js";

/** A model resolved for a turn: the opaque handle plus what the engine needs to attribute usage. */
export type ResolvedModelInfo = {
  readonly model: ResolvedModel;
  readonly modelId: string;
  readonly currency?: string;
  /** Optional cost function (minor units) from the model's pricing, used to bill each turn. */
  readonly price?: (usage: NeutralUsage) => number;
};

export type DefaultEngineDeps = {
  /** Load the manifest the run executes (by agent id + version), so history is never rewritten. */
  loadManifest: (input: { agentId: string; version: number; context: ExecutionContext }) => Promise<AgentManifest>;
  resolveModel: (manifest: AgentManifest, context: ExecutionContext) => ResolvedModelInfo;
  /** Conversation history as neutral turn messages, oldest first. */
  loadHistory: (context: ExecutionContext, run: Run) => Promise<readonly TurnMessage[]>;
  /** The tools the model may call this turn (already permission-filtered / guarded on execute). */
  buildTools?: (context: ExecutionContext, manifest: AgentManifest) => Promise<readonly ModelTurnTool[]>;
  /** System prompt; defaults to the manifest instructions. */
  systemPrompt?: (manifest: AgentManifest, context: ExecutionContext) => Promise<string> | string;
  readonly retry?: RetryPolicy;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** The streaming primitive. Defaults to the models-layer `streamModelTurn`; overridden in tests. */
  readonly streamTurn?: (req: ModelTurnRequest) => AsyncIterable<NeutralStreamChunk>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const createDefaultEngine = (deps: DefaultEngineDeps): AgentEngine => {
  const policy = deps.retry ?? DEFAULT_RETRY_POLICY;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const streamTurn = deps.streamTurn ?? streamModelTurn;

  return {
    async *run({ run, context, signal }: EngineRunInput): AsyncIterable<EngineEvent> {
      const manifest = await deps.loadManifest({ agentId: run.agentId, version: run.agentVersion, context });
      const resolved = deps.resolveModel(manifest, context);
      const system = (await (deps.systemPrompt?.(manifest, context) ?? manifest.instructions)) || undefined;
      const messages = await deps.loadHistory(context, run);
      const tools = deps.buildTools ? await deps.buildTools(context, manifest) : [];
      const maxSteps = manifest.limits?.maxSteps ?? 8;
      const messageId = deriveRunMessageId(run.id) as MessageId;

      let attempt = 1;
      for (;;) {
        let emitted = 0;
        const textParts = new Map<string, { partId: MessagePartId; text: string }>();
        const controller = new AbortController();
        try {
          const chunks = streamTurn({ model: resolved.model, ...(system ? { system } : {}), messages, tools, maxSteps, abortSignal: controller.signal });
          for await (const chunk of chunks) {
            if (signal.isCancelled()) {
              controller.abort();
              return;
            }
            for (const event of mapChunk(chunk, messageId, resolved, textParts)) {
              emitted += 1;
              yield event;
            }
          }
          return; // turn complete
        } catch (thrown) {
          const error = toPlatformError(thrown);
          const decision = decideRetry({ error, attempt, policy });
          // Only retry when nothing has streamed yet — otherwise a retry would duplicate output.
          if (emitted > 0 || !decision.retry) throw new AgentPlatformError(error, { cause: thrown });
          yield {
            type: "run.retry-pending",
            attempt,
            maxAttempts: policy.maxAttempts,
            nextAttemptAt: new Date(now() + decision.delayMs).toISOString(),
            error,
          };
          await sleep(decision.delayMs);
          attempt += 1;
        }
      }
    },
  };
};

/** Map one neutral chunk to zero or more engine events. Mutates `textParts` to accumulate deltas. */
function* mapChunk(
  chunk: NeutralStreamChunk,
  messageId: MessageId,
  resolved: ResolvedModelInfo,
  textParts: Map<string, { partId: MessagePartId; text: string }>,
): Generator<EngineEvent> {
  switch (chunk.type) {
    case "text-delta": {
      const existing = textParts.get(chunk.id);
      const text = (existing?.text ?? "") + chunk.text;
      if (!existing) {
        const partId = `${messageId}:text:${chunk.id}` as MessagePartId;
        textParts.set(chunk.id, { partId, text });
        const part: TextPart = { id: partId, type: "text", schemaVersion: 1, createdAt: new Date(0).toISOString(), text };
        yield { type: "part.added", messageId, part };
      } else {
        existing.text = text;
        const part: TextPart = { id: existing.partId, type: "text", schemaVersion: 1, createdAt: new Date(0).toISOString(), text };
        yield { type: "part.updated", messageId, part };
      }
      return;
    }
    case "tool-call": {
      const part: ToolCallPart = {
        id: `${chunk.toolCallId}:call` as MessagePartId,
        type: "tool-call",
        schemaVersion: 1,
        createdAt: new Date(0).toISOString(),
        toolCallId: asId(chunk.toolCallId),
        toolName: chunk.toolName,
        input: chunk.input,
      };
      yield { type: "tool.started", toolCallId: asId(chunk.toolCallId), toolName: chunk.toolName };
      yield { type: "part.added", messageId, part };
      return;
    }
    case "tool-result": {
      const part: ToolResultPart = {
        id: `${chunk.toolCallId}:result` as MessagePartId,
        type: "tool-result",
        schemaVersion: 1,
        createdAt: new Date(0).toISOString(),
        toolCallId: asId(chunk.toolCallId),
        toolName: chunk.toolName,
        output: chunk.output,
        truncated: false,
      };
      yield { type: "tool.completed", toolCallId: asId(chunk.toolCallId), toolName: chunk.toolName };
      yield { type: "part.added", messageId, part };
      return;
    }
    case "finish": {
      yield {
        type: "usage.updated",
        inputTokens: chunk.usage.inputTokens,
        outputTokens: chunk.usage.outputTokens,
        cachedInputTokens: chunk.usage.cachedInputTokens,
        ...(chunk.usage.reasoningTokens !== undefined ? { reasoningTokens: chunk.usage.reasoningTokens } : {}),
        modelId: resolved.modelId,
        currency: resolved.currency ?? "USD",
        costMinorUnits: resolved.price ? resolved.price(chunk.usage) : 0,
      };
      return;
    }
    case "error":
      throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error));
  }
}
