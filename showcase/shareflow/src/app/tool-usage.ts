import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "@retinue/agentkit";
import type { UsageStore } from "@retinue/agentkit/persistence";
import { pricingFor } from "./model.js";

/**
 * Tokens spent by a model call **inside a tool**, on the same ledger as the turn's — #499 AC-1.
 *
 * The engine records one `usage_records` row per chat step. A tool that generates — writing a caption
 * per channel, scoring options — calls the model through `structuredGenerateFrom`, which threw the
 * SDK's `usage` away, so drafting a post showed up nowhere: not in the 30-day spend, not per run.
 *
 * A row here is marked by its step id, `tool:<uuid>`: unique, so it never collides with the engine's
 * `(runId, step)` dedupe key, and recognisable, so the context meter can leave it out — a tool's prompt
 * is not the conversation's context. It needs a run (the ledger's foreign key), so a call made outside
 * one — a direct `POST /api/tools/:name` — is not recorded. Priced like the turn's own steps; the
 * workspace's own key (BYO) costs this platform nothing.
 */
export const TOOL_STEP_PREFIX = "tool:";

export type ToolModelUsage = {
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly ranOnWorkspaceModel: boolean;
};

export type RecordToolUsage = (context: ExecutionContext, usage: ToolModelUsage) => Promise<void>;

export const toolUsageRecorder = (deps: {
  readonly store: Pick<UsageStore, "append">;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now?: () => string;
  readonly id?: () => string;
}): RecordToolUsage => {
  return async (context, usage) => {
    if (context.runId === undefined) return;
    const pricing = usage.ranOnWorkspaceModel ? undefined : pricingFor(usage.modelId, deps.env);
    const { computeModelCostMinorUnits } = await import("@retinue/agentkit/runtime");
    const costMinorUnits =
      pricing === undefined
        ? 0
        : computeModelCostMinorUnits({ currency: "USD", ...pricing } as never, {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          });
    const id = (deps.id ?? randomUUID)();
    await deps.store.append({
      tenantId: context.tenantId,
      event: {
        id,
        tenantId: String(context.tenantId),
        ...(context.principalId === undefined ? {} : { principalId: context.principalId }),
        runId: context.runId,
        ...(context.conversationId === undefined ? {} : { conversationId: context.conversationId }),
        stepId: `${TOOL_STEP_PREFIX}${id}`,
        modelId: usage.modelId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens ?? 0,
        costMinorUnits,
        currency: "USD",
        occurredAt: (deps.now ?? (() => new Date().toISOString()))(),
      },
    } as never);
  };
};
