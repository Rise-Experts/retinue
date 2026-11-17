/**
 * Pure helpers for the assistant page's permission-card UI (Phase-2
 * human-in-the-loop confirmation). Used by
 * `web/src/app/(dashboard)/assistant/page.tsx`.
 *
 * Kept dependency-free (no React, no fetch) so the SSE-payload -> card-state
 * mapping and the decision -> `/api/assistant/continue` request-body mapping
 * are trivially unit-testable, mirroring `./hitl.ts` and `./parseEvent.ts`.
 */

/**
 * `"publish"`/`"schedule"` are the known, human-labeled categories (see
 * `categoryFor` in `./hitl.ts`). Any other non-empty string is a fail-safe
 * category for a sensitive tool AgentOS paused on that isn't (yet) mapped
 * there — the relay sends `"other"` for this case (see `./relay.ts`), kept
 * as `string` here (not a literal union) so the card still renders instead
 * of silently dropping the frame.
 */
export type PermissionCategory = "publish" | "schedule" | (string & {});

export type PermissionDecision = "once" | "session" | "always" | "deny";

/**
 * A tool entry as AgentOS sent it in the `RunPaused` event (mirrors
 * `PausedTool` in `./relay.ts` — redeclared here rather than imported so
 * this module stays dependency-free). Must be echoed back to
 * `POST /api/assistant/continue` verbatim (only `confirmed` changes) — the
 * AgentOS `/continue` contract silently no-ops the tool call if given a
 * reduced shape.
 */
export interface ToolCall {
  tool_call_id: string;
  tool_name: string;
  tool_args: unknown;
  [key: string]: unknown;
}

export interface PendingPermission {
  runId: string;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  category: PermissionCategory;
  /** Full RunPaused tool objects (see `./relay.ts`), echoed back on decision. */
  tools: ToolCall[];
  /**
   * The runtime's own one-line description of what it is about to do.
   *
   * Optional because the old runtime had none, and preferred to the card's three hardcoded phrasings
   * when present: those key on `category` being exactly `publish` or `schedule`, and the new runtime's
   * categories are its own (`publishing`, `engagement`, …), so every card fell through to "Run
   * reply_to_comment? This needs your confirmation." — the tool's identifier and nothing about what it
   * would do.
   */
  summary?: string;
}

/**
 * The arguments worth showing on the card, as label/value pairs.
 *
 * An approval is a decision, and nobody can make it from a tool name: "reply to a comment" with the
 * reply itself hidden is a button that says "trust me". The whole point of a human in the loop is that
 * the human sees the thing.
 *
 * Ordered so the text a person is putting their name to comes first, then destinations and timing, then
 * whatever is left. Values are stringified and clipped rather than rendered as JSON: the card is a few
 * lines wide and a normalized input can nest.
 */
export function permissionDetails(
  toolArgs: Record<string, unknown>,
  limit = 6,
): readonly { readonly label: string; readonly value: string }[] {
  const FIRST = ["text", "reply", "message", "caption", "content", "when", "platforms", "accountIds", "postDraftId"];
  const keys = Object.keys(toolArgs);
  const ordered = [...FIRST.filter((key) => keys.includes(key)), ...keys.filter((key) => !FIRST.includes(key))];

  return ordered.slice(0, limit).flatMap((key) => {
    const value = toolArgs[key];
    if (value === undefined || value === null || value === "") return [];
    const text = Array.isArray(value)
      ? value.map((entry) => String(entry)).join(", ")
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
    if (text === "" || text === "{}" || text === "[]") return [];
    return [{ label: humanLabel(key), value: text.length > 240 ? `${text.slice(0, 239)}…` : text }];
  });
}

/** `postDraftId` → "Post draft id". Field names are the API's; a card should not read like one. */
function humanLabel(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Parses the JSON `data:` payload of a `permission-required` SSE frame (see
 * `web/src/lib/assistant/relay.ts`) into a `PendingPermission`. Returns null
 * for anything malformed rather than throwing, so a caller can safely fall
 * back to ignoring an unrecognized frame.
 *
 * Note: this payload has no `event` key of its own — the frame is
 * recognized by its SSE-level `event: permission-required` line (see
 * `parseSseFrameEventName` in `./sse.ts`), not by anything in this JSON.
 */
export function parsePermissionRequired(data: unknown): PendingPermission | null {
  if (typeof data !== "object" || data === null) return null;
  const runId = (data as { run_id?: unknown }).run_id;
  const toolCallId = (data as { tool_call_id?: unknown }).tool_call_id;
  const toolName = (data as { tool_name?: unknown }).tool_name;
  const category = (data as { category?: unknown }).category;
  const rawArgs = (data as { tool_args?: unknown }).tool_args;
  const rawTools = (data as { tools?: unknown }).tools;

  if (typeof runId !== "string" || !runId) return null;
  if (typeof toolCallId !== "string" || !toolCallId) return null;
  if (typeof toolName !== "string" || !toolName) return null;
  // Accept any non-empty category string — a paused tool AgentOS hasn't
  // mapped in `categoryFor` yet still needs its card to render (fail safe),
  // not fall back to `null`/no-card. Only a genuinely missing/empty
  // category is rejected.
  if (typeof category !== "string" || !category) return null;
  // The full RunPaused tool objects are required, not optional: without
  // them the eventual `/continue` call cannot carry more than the minimal
  // shape that AgentOS silently no-ops (see ./relay.ts).
  if (!Array.isArray(rawTools) || rawTools.length === 0) return null;

  const toolArgs = typeof rawArgs === "object" && rawArgs !== null ? (rawArgs as Record<string, unknown>) : {};
  const tools = rawTools as ToolCall[];

  return { runId, toolCallId, toolName, toolArgs, category, tools };
}

/** Comma-joined `platforms` list out of a tool call's args, e.g. "linkedin, instagram". */
export function permissionPlatforms(toolArgs: Record<string, unknown>): string {
  const platforms = toolArgs.platforms;
  if (!Array.isArray(platforms)) return "";
  return platforms.filter((p): p is string => typeof p === "string").join(", ");
}

/** The `when` field of a `schedule_post` tool call's args, as a display string. */
export function permissionWhen(toolArgs: Record<string, unknown>): string {
  const when = toolArgs.when;
  return typeof when === "string" ? when : "";
}

/**
 * Request body for `POST /api/assistant/continue` once the user has
 * decided. Carries the full `tools` array unchanged — the route (not this
 * client-side helper) sets `confirmed` on each tool from `decision`, mirroring
 * how the auto-continue path in `./relay.ts` does it server-side.
 */
export function buildContinuePayload(perm: PendingPermission, decision: PermissionDecision, sessionId: string) {
  return {
    run_id: perm.runId,
    tools: perm.tools,
    decision,
    session_id: sessionId,
  };
}
