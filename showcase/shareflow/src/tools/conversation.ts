import { z } from "zod";
import type { Tool } from "@retinue/agentkit";
import { defineDelegatingTool } from "@retinue/agentkit/tools";

import type { ShareFlowToolFactory } from "./factory.js";
import { shareFlowTool } from "./factory.js";

/**
 * `recall_tool_result` — #630. History shows earlier tool results as previews with a `ref`, so a long thread fits
 * the model's window; this reads one back in full, a page at a time. Read-only and scoped to this conversation.
 */
const recallSchema = z
  .object({
    ref: z.string().trim().min(3).max(300),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

export const recallToolResultTool = shareFlowTool(["toolResults"], ({ services, deps }): Tool =>
  defineDelegatingTool(deps, {
    name: "recall_tool_result",
    label: "Re-read an earlier result",
    description:
      "Read the full output of a tool you called earlier in this conversation. Earlier replies show tool results only as a short preview or a one-line entry with a ref such as \"msg_…#call_…\" — pass that ref exactly. Use it when you need details the preview left out (search results, a document's text, a draft's full caption) instead of guessing or calling the original tool again. Long outputs come back in pages: pass nextOffset as offset for the next one.",
    category: "research",
    effect: "read",
    inputSchema: recallSchema,
    delegatesTo: "ToolResultRecallService.recall",
    delegate: async (input: z.infer<typeof recallSchema>, context) =>
      services.toolResults.recall(context, { ref: input.ref, ...(input.offset === undefined ? {} : { offset: input.offset }) }),
  }));

export const CONVERSATION_TOOL_NAMES = ["recall_tool_result"] as const;
export const CONVERSATION_TOOL_FACTORIES: readonly ShareFlowToolFactory[] = [recallToolResultTool];
