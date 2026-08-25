/**
 * The context window: what fits, what is in it, and how full it is — #168.
 *
 * Its own module rather than part of the app module, for the reason `questions.ts` and `worker-context.ts` are:
 * importing `index.ts` runs the wiring, and the wiring refuses to start without the dev-auth flag. `server.ts`
 * needs these, and a server that has to boot the app module to answer "how full is the window" is a server
 * coupled to it for no reason.
 *
 * Providers are passed in rather than reached for, so this file knows nothing about notebooks or memory.
 */

import { assemblePrompt, estimateTokens, gatherSections, inspectAssembledPrompt, turnText } from "@agentkit/backend";
import type { ExampleStores } from "./stores.js";
import type { ContextBudget, ContextInspection, ContextProvider, ExecutionContext } from "@agentkit/backend";
import type { SqlExecutor } from "@agentkit/backend/adapters/postgres";
import { conversationTurns } from "./history.js";
import { resolveExampleModel } from "./model.js";
import { MODE_DESCRIPTIONS, type ConversationMode } from "./modes.js";
import { exampleAgentManifest } from "./agent.js";

/**
 * The model's input limit, and the budget the example assembles within.
 *
 * The limit comes from the resolved model's own definition rather than a constant here: a policy resolving a
 * different model must move the denominator with it, or every utilization figure is about the wrong model.
 */
export const contextLimitFor = (): number => resolveExampleModel().definition.limits.contextTokens;

/**
 * Bucket budgets, as fractions of the window rather than fixed numbers.
 *
 * A **function**, not a constant. It was a module-level IIFE, so importing anything that transitively reached
 * this file demanded `AGENTKIT_MODEL_API_KEY` — which made the whole module untestable, and captured the budget
 * of whatever model happened to be configured when the process loaded rather than the one resolved for the turn.
 *
 * Fixed token counts are wrong the moment the configured model changes — a budget tuned for a 128k window
 * starves an 8k one and wastes a 1M one. History gets the largest share because a conversation *is* its history;
 * the notebook and memory are there to inform it, not to crowd it out.
 */
export const exampleContextBudget = (): ContextBudget => {
  const limit = contextLimitFor();
  const share = (fraction: number) => Math.floor(limit * fraction);
  return {
    basePolicyTokens: share(0.05),
    userContextTokens: share(0.1),
    toolTokens: share(0.1),
    skillTokens: share(0.05),
    knowledgeTokens: share(0.15),
    historyTokens: share(0.45),
  };
};

/**
 * What the window holds right now — #168.
 *
 * Both halves, because a "context utilization" figure that counts only one of them is a figure that reassures
 * you right up to the failure. The system prompt's context sections are budgeted by `assemblePrompt`; the
 * conversation history is passed separately to the engine via `loadHistory` and is usually the larger half and
 * the one that grows without bound.
 *
 * Estimated, and named as an estimate. `estimateTokens` is the platform's ~4-characters-per-token heuristic, not
 * the provider's tokenizer, so this is the right order of magnitude and not a figure to bill from. A precise
 * count would need the provider's tokenizer per model, which is the sort of dependency that makes a monitoring
 * endpoint a reason to add a native module.
 */
export const contextUsage = async (input: {
  readonly stores: Pick<ExampleStores, "messages" | "summaries">;
  /**
   * Only for the message count, and optional — #155 AC-7.
   *
   * `MessageStore` has no `count`, and adding one to the port for a page's meter would be the wrong trade. The
   * memory composition omits it and gets `totalMessages: null`, which is an honest "unknown" rather than a wrong
   * number — and the overflow warning is then simply not shown, which is better than showing a false one.
   */
  readonly sql?: SqlExecutor;
  readonly context: ExecutionContext;
  readonly mode: ConversationMode;
  /** Passed in, so this file knows nothing about what the app's context is made of. */
  readonly providers: readonly ContextProvider[];
}): Promise<{
  readonly limit: number;
  readonly promptTokens: number;
  readonly historyTokens: number;
  readonly usedTokens: number;
  readonly remainingTokens: number;
  readonly fraction: number;
  readonly turns: number;
  /**
   * Every message in the conversation, not just the windowed ones.
   *
   * Reported so that dropping becomes *visible*. A utilization figure computed over a capped read describes the
   * cap, and a conversation of 2000 messages showing "3% full" is the most misleading number this endpoint could
   * produce — it says there is room when 1600 turns have already fallen off the end.
   */
  readonly totalMessages: number | null;
  readonly windowedMessages: number;
  readonly inspection: ContextInspection;
}> => {
  const sections = await gatherSections(input.context, input.providers);
  const limit = contextLimitFor();
  const assembled = assemblePrompt({ sections, budget: exampleContextBudget(), modelContextTokens: limit });

  const turns =
    input.context.conversationId === undefined
      ? []
      : await conversationTurns({
          stores: input.stores,
          tenantId: String(input.context.tenantId),
          conversationId: String(input.context.conversationId),
          /**
           * The **compacted** history, because that is the one the model is given.
           *
           * Reading the raw transcript here made the meter report a window nobody was sending: compaction
           * reclaimed 15,000 tokens and the figure did not move, which is worse than no figure — it says the
           * thing you just did had no effect.
           */
          compacted: true,
        });
  const historyTokens = turns.reduce((sum, t) => sum + estimateTokens(turnText(t)), 0);

  // The instructions and the mode block are part of the prompt too, and small but not zero — omitting them
  // would make the figure quietly optimistic in exactly the direction that matters.
  const instructionTokens =
    estimateTokens(exampleAgentManifest.instructions) + estimateTokens(MODE_DESCRIPTIONS[input.mode].instruction);
  const promptTokens = assembled.totalTokens + instructionTokens;
  const usedTokens = promptTokens + historyTokens;

  const totalMessages =
    input.context.conversationId === undefined || input.sql === undefined
      ? null
      : await countMessages(input.sql, String(input.context.tenantId), String(input.context.conversationId));

  return {
    limit,
    promptTokens,
    historyTokens,
    totalMessages,
    windowedMessages: turns.length,
    usedTokens,
    remainingTokens: Math.max(0, limit - usedTokens),
    // Capped at 1. Past the limit the useful information is "full", and a bar wider than its track is a
    // rendering bug rather than a measurement.
    fraction: limit === 0 ? 0 : Math.min(1, usedTokens / limit),
    turns: turns.length,
    inspection: inspectAssembledPrompt(assembled),
  };
};

/**
 * How many messages the conversation has, in total.
 *
 * A count, not a page. `MessageStore` has no `count` — reasonably, since a port with a count for every table is a
 * port with a lot of methods nobody calls — and paging to find out would be the O(n) query this whole change
 * exists to remove. So this is deliberately raw SQL in the *application*, which is where a
 * question this specific belongs.
 */
const countMessages = async (sql: SqlExecutor, tenantId: string, conversationId: string): Promise<number> => {
  const rows = await sql.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1 AND conversation_id = $2`,
    [tenantId, conversationId],
  );
  return rows[0]?.n ?? 0;
};
