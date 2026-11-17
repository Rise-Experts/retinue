/**
 * What happens to a turn's prompt on its way to the model, step by step — #630.
 *
 * A turn is a loop of up to 24 model calls, and the AI SDK re-sends every earlier step's tool call and full
 * tool result on each one. Nothing bounded that: a run that searched, read three pages and a PDF carried all
 * of them into every later step. This runs in the model middleware (`workspace-turn-model.ts`), where each
 * call's real prompt is visible, and does two things.
 *
 * ## Clearing old tool results
 *
 * Past `CLEAR_TOOL_RESULTS_AT` of the working window, the oldest tool outputs — never the newest
 * `KEEP_RECENT_TOOL_RESULTS` — are replaced by a short stub carrying a preview, until the prompt is under
 * `CLEAR_TOOL_RESULTS_TO`. The call and its result stay paired (only the result's *content* changes), which
 * every provider requires. Anthropic's `clear_tool_uses` does the same server-side for Claude only; this is
 * the provider-neutral version, and it clears in one large step so it breaks the prompt cache rarely.
 *
 * ## Prompt caching
 *
 * - **Anthropic** caches only at explicit breakpoints: one on the system prompt (instructions and context,
 *   stable across a conversation) and one on the newest message (so each step reads the previous step's
 *   prefix from cache).
 * - **OpenAI** caches automatically, but routes by prefix hash; a stable `promptCacheKey` per conversation
 *   keeps a thread's requests on the same cache.
 * - **Gemini** caches implicitly and needs nothing.
 */
import {
  CLEAR_TOOL_RESULTS_AT,
  CLEAR_TOOL_RESULTS_TO,
  KEEP_RECENT_TOOL_RESULTS,
  contextWindowFor,
} from "./context-window.js";
import { DEFAULT_CHARS_PER_TOKEN, defaultCharsPerToken, estimateTokensAt } from "./token-ratio.js";

type Part = { readonly type?: string; readonly output?: unknown; readonly toolName?: string; readonly providerOptions?: Record<string, unknown> } & Record<string, unknown>;
type PromptMessage = { readonly role?: string; readonly content?: unknown; readonly providerOptions?: Record<string, unknown> } & Record<string, unknown>;
type Params = { readonly prompt?: readonly PromptMessage[]; readonly tools?: unknown; readonly providerOptions?: Record<string, Record<string, unknown>> } & Record<string, unknown>;

/**
 * Characters ÷ `charsPerToken` of the value's JSON. Provider usage stays the ground truth.
 *
 * #658: the ratio is the answering model's — learned from the run's previous call when there was one
 * (`workspace-turn-model.ts`), else its default (Gemini ~6, Claude/OpenAI ~4). At a flat 4 a Gemini run cleared its
 * tool outputs at ~40% of the window instead of 60%.
 */
const tokensOf = (value: unknown, charsPerToken: number = DEFAULT_CHARS_PER_TOKEN): number => {
  try {
    return estimateTokensAt(JSON.stringify(value) ?? "", charsPerToken);
  } catch {
    return 0;
  }
};

/** What this call will send, estimated: the prompt plus the tool declarations. */
export const estimateCallTokens = (params: Params, charsPerToken: number = DEFAULT_CHARS_PER_TOKEN): number =>
  tokensOf(params.prompt ?? [], charsPerToken) + tokensOf(params.tools ?? [], charsPerToken);

/** How much of a cleared output survives as a preview. */
export const CLEARED_PREVIEW_CHARS = 600;

const outputString = (output: unknown): string => {
  // A V3 tool-result output is `{ type: "json" | "text" | …, value }`.
  const value = output !== null && typeof output === "object" && "value" in (output as object) ? (output as { value: unknown }).value : output;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
};

const CLEARED_MARK = "[Earlier tool output cleared to keep this turn inside the context window.";

const clearedOutput = (output: unknown) => {
  const text = outputString(output).replace(/\s+/g, " ").trim();
  const preview = text.length <= CLEARED_PREVIEW_CHARS ? text : `${text.slice(0, CLEARED_PREVIEW_CHARS)}…`;
  return {
    type: "text",
    value: `${CLEARED_MARK} Preview: ${preview} — call the tool again if you need the full result.]`,
  };
};

export type ClearResult = { readonly params: Params; readonly cleared: number; readonly before: number; readonly after: number };

/**
 * Old tool outputs replaced by stubs when the call is past `clearAt` of `working` tokens.
 *
 * Pure: returns new params, never mutates the SDK's. Oldest first, newest `keep` untouched, and it stops as
 * soon as the estimate is under `clearTo` — or when nothing clearable is left, since the newest results and
 * everything that is not a tool result are the turn itself.
 */
export const clearOldToolResults = (
  params: Params,
  options: {
    readonly working: number;
    readonly clearAt?: number;
    readonly clearTo?: number;
    readonly keep?: number;
    /** #658: the answering provider's characters per token. Defaults to 4. */
    readonly charsPerToken?: number;
  },
): ClearResult => {
  const charsPerToken = options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const before = estimateCallTokens(params, charsPerToken);
  const prompt = params.prompt;
  const clearAt = options.clearAt ?? CLEAR_TOOL_RESULTS_AT;
  const clearTo = options.clearTo ?? CLEAR_TOOL_RESULTS_TO;
  const keep = options.keep ?? KEEP_RECENT_TOOL_RESULTS;
  if (prompt === undefined || before <= options.working * clearAt) return { params, cleared: 0, before, after: before };

  // Every tool result, in order, as [message index, part index].
  const positions: [number, number][] = [];
  prompt.forEach((message, m) => {
    if (!Array.isArray(message.content)) return;
    (message.content as Part[]).forEach((part, p) => {
      if (part?.type === "tool-result" && !outputString(part.output).startsWith(CLEARED_MARK)) positions.push([m, p]);
    });
  });
  const clearable = positions.slice(0, Math.max(0, positions.length - keep));
  if (clearable.length === 0) return { params, cleared: 0, before, after: before };

  const next = prompt.map((message) => (Array.isArray(message.content) ? { ...message, content: [...(message.content as Part[])] } : message));
  let estimate = before;
  let cleared = 0;
  for (const [m, p] of clearable) {
    if (estimate <= options.working * clearTo) break;
    const content = next[m]?.content as Part[];
    const part = content[p];
    if (part === undefined) continue;
    const replaced = { ...part, output: clearedOutput(part.output) };
    estimate -= tokensOf(part, charsPerToken) - tokensOf(replaced, charsPerToken);
    content[p] = replaced;
    cleared += 1;
  }
  return { params: { ...params, prompt: next }, cleared, before, after: estimate };
};

const withAnthropicBreakpoint = <T extends { providerOptions?: Record<string, unknown> }>(item: T): T => {
  const existing = (item.providerOptions ?? {}) as Record<string, Record<string, unknown>>;
  return { ...item, providerOptions: { ...existing, anthropic: { ...(existing["anthropic"] ?? {}), cacheControl: { type: "ephemeral" } } } };
};

/**
 * Cache hints for the call's provider. Anthropic: breakpoints on the last system message and the newest
 * message. OpenAI: a per-conversation `promptCacheKey`. Everything else: unchanged.
 */
export const withPromptCaching = (params: Params, options: { readonly provider: string; readonly cacheKey?: string }): Params => {
  const provider = options.provider.toLowerCase();
  if (provider === "anthropic" && params.prompt !== undefined && params.prompt.length > 0) {
    const prompt = [...params.prompt];
    let lastSystem = -1;
    prompt.forEach((message, index) => {
      if (message.role === "system") lastSystem = index;
    });
    if (lastSystem !== -1) prompt[lastSystem] = withAnthropicBreakpoint(prompt[lastSystem] as PromptMessage);
    const last = prompt.length - 1;
    if (last !== lastSystem) prompt[last] = withAnthropicBreakpoint(prompt[last] as PromptMessage);
    return { ...params, prompt };
  }
  if ((provider === "openai" || provider === "azure-openai") && options.cacheKey !== undefined && options.cacheKey !== "") {
    const existing = params.providerOptions ?? {};
    return { ...params, providerOptions: { ...existing, openai: { ...(existing["openai"] ?? {}), promptCacheKey: options.cacheKey } } };
  }
  return params;
};

/** Both, for one call on `target`. Logs a clear, because it means a run grew past the point it was sized for. */
export const manageCallContext = (
  params: Params,
  target: { readonly provider: string; readonly modelId: string },
  options: {
    readonly cacheKey?: string;
    readonly log?: (line: string) => void;
    /** #658: the ratio the run's previous call showed. Absent: the target model's default. */
    readonly charsPerToken?: number;
  } = {},
): Params => {
  const { working } = contextWindowFor(target.modelId);
  const result = clearOldToolResults(params, { working, charsPerToken: options.charsPerToken ?? defaultCharsPerToken(target.modelId) });
  if (result.cleared > 0) {
    (options.log ?? console.info)(
      `[shareflow] cleared ${result.cleared} older tool output(s) from this step's prompt: ~${result.before} → ~${result.after} tokens ` +
        `of a ${working}-token working window (${target.modelId}).`,
    );
  }
  return withPromptCaching(result.params, { provider: target.provider, ...(options.cacheKey === undefined ? {} : { cacheKey: options.cacheKey }) });
};
