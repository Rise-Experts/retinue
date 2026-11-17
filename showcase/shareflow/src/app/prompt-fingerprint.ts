/**
 * What a model call's prompt was made of, as short hashes — so a broken prompt cache can be traced to the part
 * that changed.
 *
 * Every provider caches by prefix, and one differing byte ends the cached part. After #649 made the system prompt
 * stable, production still showed 0 cached tokens on back-to-back Gemini turns (2026-10-01), and nothing logs the
 * request that was sent. This records, per call: a hash of the tool declarations, of the system prompt, and of each
 * message in order. Two consecutive turns then show the first part that differs — tools, system, or message *n* —
 * without storing a word of the prompt itself.
 */
import { createHash } from "node:crypto";

export type PromptFingerprint = {
  /** Hash of the tool declarations, in the order sent. */
  readonly tools: string;
  readonly toolCount: number;
  /** Hash of the system messages. */
  readonly system: string;
  readonly systemChars: number;
  /** One hash per non-system message, oldest first. */
  readonly messages: readonly string[];
  /**
   * #658: how many characters the whole call carried — system, messages and tool declarations — counted the way
   * the history estimate counts them (text, tool inputs and outputs as text, declarations as JSON). Recorded on
   * the same row as the call's measured `last_input_tokens`, so their quotient is the provider's real
   * chars-per-token ratio on this conversation (`token-ratio.ts`).
   */
  readonly promptChars: number;
  /** #658: the call carried an image or a file — tokens with no characters behind them, so it teaches no ratio. */
  readonly hasMedia: boolean;
};

const jsonLength = (value: unknown): number => {
  try {
    return (JSON.stringify(value) ?? "").length;
  } catch {
    return 0;
  }
};

/** A V3 tool-result output is `{ type: "json" | "text" | …, value }`; its text is what the provider reads. */
const outputLength = (output: unknown): number => {
  const value = output !== null && typeof output === "object" && "value" in (output as object) ? (output as { value: unknown }).value : output;
  return typeof value === "string" ? value.length : jsonLength(value);
};

/** One message's characters, and whether it carried media. Unknown part shapes count as their JSON. */
const contentChars = (content: unknown): { readonly chars: number; readonly media: boolean } => {
  if (typeof content === "string") return { chars: content.length, media: false };
  if (!Array.isArray(content)) return { chars: jsonLength(content ?? ""), media: false };
  let chars = 0;
  let media = false;
  for (const part of content as readonly Record<string, unknown>[]) {
    const type = part?.["type"];
    if (typeof part?.["text"] === "string") chars += (part["text"] as string).length;
    else if (type === "tool-call") chars += String(part["toolName"] ?? "").length + (typeof part["input"] === "string" ? (part["input"] as string).length : jsonLength(part["input"]));
    else if (type === "tool-result") chars += String(part["toolName"] ?? "").length + outputLength(part["output"]);
    else if (type === "file" || type === "image") media = true;
    else chars += jsonLength(part);
  }
  return { chars, media };
};

const hash = (value: unknown): string => {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "";
  } catch {
    text = String(value);
  }
  return createHash("sha256").update(text).digest("hex").slice(0, 10);
};

type PromptMessage = { readonly role?: string; readonly content?: unknown };

/** The fingerprint of a LanguageModelV3 call's params. Pure. */
export const promptFingerprint = (params: unknown): PromptFingerprint => {
  const p = (params ?? {}) as { readonly prompt?: readonly PromptMessage[]; readonly tools?: unknown };
  const prompt = Array.isArray(p.prompt) ? p.prompt : [];
  const system = prompt.filter((message) => message.role === "system");
  const rest = prompt.filter((message) => message.role !== "system");
  const tools = Array.isArray(p.tools) ? p.tools : [];
  const counted = prompt.map((message) => contentChars(message.content));
  return {
    promptChars: counted.reduce((sum, c) => sum + c.chars, 0) + (tools.length === 0 ? 0 : jsonLength(tools)),
    hasMedia: counted.some((c) => c.media),
    tools: hash(tools),
    toolCount: tools.length,
    system: hash(system),
    systemChars: system.reduce((sum, message) => sum + (typeof message.content === "string" ? message.content.length : JSON.stringify(message.content ?? "").length), 0),
    messages: rest.map((message) => `${message.role ?? "?"}:${hash(message.content)}`),
  };
};
