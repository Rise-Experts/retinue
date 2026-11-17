/**
 * The chat message model behind the assistant pane.
 *
 * This replaces the original flat `{ role, text }` shape. The extra fields
 * mirror AgentOS's own run payload (and the immo_finanz chat client, which
 * renders the same stream), so a message can carry the tool calls, reasoning
 * steps, references, and media that a run produces alongside its text.
 *
 * IMPORTANT — not every field can be populated by Chorus today. The
 * `chorus-assistant` agent (ai_backend/app/assistant/agent.py) has no
 * `reasoning=True` and no `knowledge=`, and its four tools return plain text
 * dicts, so `reasoningSteps`, `references`, `images`, `videos`, and `audio`
 * are structurally unreachable until the agent gains those capabilities. The
 * fields and their renderers exist so that turning a capability on lights up
 * the UI without a frontend change; they are deliberately dormant, not dead.
 *
 * All timestamps here are UNIX seconds, matching what AgentOS puts on its
 * events and stored runs — NOT milliseconds. Convert with `* 1000` before
 * handing one to `Date`.
 */

/**
 * Lifecycle of a single tool call, derived from the AgentOS event that
 * carried it: `ToolCallStarted` -> running, `ToolCallCompleted` -> done,
 * `ToolCallError` -> error.
 */
export type ToolStatus = 'running' | 'done' | 'error';

export interface ToolCallView {
  /**
   * AgentOS's `tool_call_id`. Used as the merge key so a `ToolCallCompleted`
   * updates the chip its `ToolCallStarted` created instead of appending a
   * duplicate. Falls back to a synthetic `name-index` key when upstream
   * omits it (see `toolCallKey`).
   */
  toolCallId: string;
  toolName: string;
  toolArgs?: Record<string, unknown>;
  status: ToolStatus;
  /** Present on error only — AgentOS's tool error text, if it sent any. */
  errorText?: string;
  createdAt?: number;
  /**
   * The result itself, kept only for the tools whose answer the transcript renders as a card — #555's
   * `propose_project_setup`. Everything else stays a chip; results can be large and are not shown.
   */
  output?: unknown;
}

export interface ReasoningStep {
  title: string;
  action?: string;
  result?: string;
  reasoning?: string;
}

export interface ReferenceItem {
  name: string;
  content: string;
  metaData?: Record<string, unknown>;
}

export interface ReferenceGroup {
  query: string;
  references: ReferenceItem[];
}

export interface ImageItem {
  url: string;
  revisedPrompt?: string;
}

export interface VideoItem {
  id?: string | number;
  url: string;
}

export interface AudioItem {
  url?: string;
  base64Audio?: string;
  mimeType?: string;
}

export interface AssistantChatMessage {
  role: 'user' | 'assistant';
  text: string;
  /** UNIX seconds. Absent on messages restored from a run that had no timestamp. */
  createdAt?: number;
  /**
   * Set when the run failed. Rendered as its own error line instead of being
   * appended into `text` — the original implementation injected the error as
   * italic markdown, which made it indistinguishable from model output and
   * impossible to style.
   */
  streamingError?: string;
  /**
   * Set by a `RunPaused` event that reached the browser. Normally the relay
   * converts a pause into a `permission-required` frame and the page shows
   * the permission card instead, so this only fires for the degenerate case
   * the relay forwards as-is: a pause carrying no tools to confirm.
   */
  pausedNotice?: boolean;
  toolCalls?: ToolCallView[];
  /**
   * Display-only filenames of files the user attached to this turn. The storage
   * paths are NOT kept here: they go to the server separately and are
   * re-validated there (see lib/assistant/attachments.ts), so the message list
   * never becomes a source of truth for what may be published.
   */
  attachmentNames?: string[];
  /** Dormant — see the module docstring. */
  reasoningSteps?: ReasoningStep[];
  /** Dormant — see the module docstring. */
  references?: ReferenceGroup[];
  /** Dormant — see the module docstring. */
  images?: ImageItem[];
  /** Dormant — see the module docstring. */
  videos?: VideoItem[];
  /** Dormant — see the module docstring. */
  audio?: AudioItem[];
}

/** Current wall clock in the UNIX seconds this module works in. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function createUserMessage(text: string): AssistantChatMessage {
  return { role: 'user', text, createdAt: nowSeconds() };
}

/**
 * The empty assistant bubble pushed before a run starts streaming into it.
 * Every reducer path targets the last message in the list and requires it to
 * be an assistant message, so this placeholder must exist first.
 */
export function createAssistantPlaceholder(): AssistantChatMessage {
  return { role: 'assistant', text: '', createdAt: nowSeconds() };
}

/**
 * Guards every timestamp read. AgentOS has been observed to omit `created_at`
 * on some events and to store `0` on some runs; both must render as "no
 * timestamp" rather than as 1 January 1970.
 */
export function isValidTimestamp(seconds: number | null | undefined): seconds is number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return false;
  return !Number.isNaN(new Date(seconds * 1000).getTime());
}

/**
 * `HH:mm` in the viewer's locale, or `''` when there is no usable timestamp
 * (callers render nothing in that case rather than a placeholder).
 */
export function formatClockTime(seconds: number | null | undefined, locale = 'en'): string {
  if (!isValidTimestamp(seconds)) return '';
  try {
    return new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(seconds * 1000));
  } catch {
    return '';
  }
}

/**
 * What a date separator should say. Returns a *kind* rather than a string so
 * the component can translate through next-intl — the immo original
 * hardcoded German 'Heute'/'Gestern', which this app can't do since it ships
 * both en and de.
 */
export type DateSeparatorLabel =
  | { kind: 'today' }
  | { kind: 'yesterday' }
  | { kind: 'date'; seconds: number };

export function dateSeparatorLabel(seconds: number | null | undefined): DateSeparatorLabel | null {
  if (!isValidTimestamp(seconds)) return null;
  const date = new Date(seconds * 1000);
  const today = new Date();
  if (isSameLocalDay(date, today)) return { kind: 'today' };
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameLocalDay(date, yesterday)) return { kind: 'yesterday' };
  return { kind: 'date', seconds };
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * True when a separator belongs above the message at `currentSeconds`.
 *
 * `previousSeconds` is the message *before* it in render order (the list is
 * oldest-first). A missing previous timestamp means this is the first dated
 * message in the pane, which does get a separator; a missing current
 * timestamp can't be placed on a day at all, so it gets none.
 */
export function shouldShowDateSeparator(
  currentSeconds: number | null | undefined,
  previousSeconds: number | null | undefined,
): boolean {
  if (!isValidTimestamp(currentSeconds)) return false;
  if (!isValidTimestamp(previousSeconds)) return true;
  return !isSameLocalDay(new Date(currentSeconds * 1000), new Date(previousSeconds * 1000));
}

/**
 * Merge key for a tool call. AgentOS normally sends a `tool_call_id`; when it
 * doesn't, fall back to name + creation time the way the immo client does, and
 * finally to the positional index so two anonymous calls in one message stay
 * distinct instead of collapsing into one chip.
 */
export function toolCallKey(
  tool: { toolCallId?: string; toolName?: string; createdAt?: number },
  index: number,
): string {
  if (tool.toolCallId) return tool.toolCallId;
  if (tool.toolName && tool.createdAt) return `${tool.toolName}-${tool.createdAt}`;
  return `${tool.toolName ?? 'tool'}-${index}`;
}
