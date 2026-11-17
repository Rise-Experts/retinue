/**
 * Earlier tool results, by reference — #630.
 *
 * The worker stores every assistant message with all its parts, full tool outputs included
 * (`messages.parts`). History used to send the model none of them; it now sends recent ones as previews and
 * older ones as a one-line reference, and this is the other half: `recall_tool_result` turns a reference back
 * into the full output, a page at a time. Nothing is lost by keeping the prompt small — only moved out of it.
 *
 * A reference is `<messageId>#<toolCallId>`: both are the platform's own ids, so it can be built from any
 * stored message without a second table.
 */
import { AgentPlatformError, type ConversationId, type ExecutionContext, type Message, type MessageId, type MessageStore, type TenantId } from "@retinue/agentkit";

import type { RecalledToolResult, ToolResultRecallService } from "../services/index.js";

/** One page of a recalled result, in characters (~4,000 tokens). */
export const RECALL_PAGE_CHARS = 16_000;

export const toolResultRef = (messageId: string, toolCallId: string): string => `${messageId}#${toolCallId}`;

export const parseToolResultRef = (ref: string): { readonly messageId: string; readonly toolCallId: string } | undefined => {
  const at = ref.trim().lastIndexOf("#");
  if (at <= 0 || at === ref.trim().length - 1) return undefined;
  const trimmed = ref.trim();
  return { messageId: trimmed.slice(0, at), toolCallId: trimmed.slice(at + 1) };
};

type ToolResultPart = { readonly type: "tool-result"; readonly toolCallId?: string; readonly toolName?: string; readonly output?: unknown };
type StoredToolResult = { readonly type: "tool-result"; readonly toolCallId: string; readonly toolName: string; readonly output?: unknown };

/** The tool-result parts of a stored message that carry a call id — the ones a reference can name. */
export const toolResultsOf = (message: Message): readonly StoredToolResult[] =>
  ((message.parts ?? []) as readonly unknown[]).filter(
    (part): part is StoredToolResult =>
      part !== null &&
      typeof part === "object" &&
      (part as ToolResultPart).type === "tool-result" &&
      typeof (part as ToolResultPart).toolCallId === "string" &&
      typeof (part as ToolResultPart).toolName === "string",
  );

/** A stored output as the text a model reads. Strings stay strings; everything else is JSON. */
export const outputText = (output: unknown): string => {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output) ?? "";
  } catch {
    return String(output);
  }
};

const notFound = (ref: string) =>
  new AgentPlatformError({
    code: "not_found",
    message: `No tool result "${ref}" in this conversation. Use a ref exactly as it appears in an earlier reply's tool results.`,
    retryable: false,
  });

export const createToolResultRecallService = (input: { readonly messages: Pick<MessageStore, "findById"> }): ToolResultRecallService => ({
  async recall(context: ExecutionContext, { ref, offset = 0 }): Promise<RecalledToolResult> {
    const parsed = parseToolResultRef(ref);
    if (parsed === undefined) throw notFound(ref);
    const message = await input.messages.findById({ tenantId: context.tenantId as TenantId, id: parsed.messageId as MessageId });
    /*
     * The conversation is checked as well as the tenant: a reference is only meaningful inside the thread that
     * produced it, and a model handed an id from somewhere else must not read another chat through this.
     */
    if (
      message === null ||
      context.conversationId === undefined ||
      String(message.conversationId) !== String(context.conversationId as ConversationId)
    ) {
      throw notFound(ref);
    }
    const part = toolResultsOf(message).find((p) => p.toolCallId === parsed.toolCallId);
    if (part === undefined) throw notFound(ref);

    const text = outputText(part.output);
    const start = Math.max(0, Math.min(Math.floor(offset), text.length));
    const end = Math.min(text.length, start + RECALL_PAGE_CHARS);
    return {
      ref: toolResultRef(parsed.messageId, parsed.toolCallId),
      toolName: part.toolName,
      content: text.slice(start, end),
      offset: start,
      totalChars: text.length,
      ...(end < text.length ? { nextOffset: end } : {}),
    };
  },
});
