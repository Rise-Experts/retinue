/**
 * Which side panes a turn's tool results changed — #628 part 5.
 *
 * The chat stream already carries every tool result, so the open panes need not wait for the turn to end
 * (or be reopened) to show a new post, image, PDF, document or schedule: each successful result names the
 * panes whose data it changed, and those are invalidated as the result arrives.
 *
 * A failed result changes nothing and invalidates nothing. The name is the tool that **ran** —
 * `ranToolName` when a call went through `execute_tool` — for the same reason `partsToMessage` reads it.
 *
 * Pure, so the mapping is tested without a DOM.
 */

import type { MessagePart } from '@retinue/react';
import type { PaneKind } from './paneCache';

const POST: readonly PaneKind[] = ['post', 'posts'];
const MEDIA_ON_POST: readonly PaneKind[] = ['media', 'post', 'posts'];
const SCHEDULE: readonly PaneKind[] = ['calendar', 'posts', 'post'];

/** Tool → the panes its successful result changes. A tool not listed changes no pane. */
export const TOOL_PANES: Readonly<Record<string, readonly PaneKind[]>> = {
  // Posts.
  create_post_draft: POST,
  create_thread_draft: POST,
  update_post_draft: POST,
  duplicate_post_draft: POST,
  draft_post_for_channels: POST,
  revise_post_channels: POST,
  delete_post: SCHEDULE,
  repost_post: SCHEDULE,
  // Media — made, imported, rendered, or put on (or taken off) a post.
  generate_media: ['media'],
  check_media_job: MEDIA_ON_POST,
  import_stock_media: ['media'],
  render_diagram: ['media'],
  render_code_snippet: ['media'],
  render_post_template: MEDIA_ON_POST,
  capture_website: ['media'],
  convert_media: MEDIA_ON_POST,
  attach_media_to_post: MEDIA_ON_POST,
  attach_uploaded_media: MEDIA_ON_POST,
  attach_project_asset: MEDIA_ON_POST,
  detach_media_from_post: MEDIA_ON_POST,
  replace_media_on_post: MEDIA_ON_POST,
  // Documents: the artifact rows, and the PDFs printed from them.
  create_artifact: ['documents'],
  update_artifact: ['documents'],
  generate_pdf: ['documents', 'media'],
  attach_artifact_to_post: ['documents', 'media', 'post', 'posts'],
  // Schedules and publishing.
  schedule_post: SCHEDULE,
  publish_post_now: SCHEDULE,
  retry_publish_target: SCHEDULE,
  create_recurring_schedule: SCHEDULE,
  cancel_recurring_schedule: SCHEDULE,
  // The chat's project.
  update_project: ['project'],
  remember_project_rule: ['project'],
  propose_project_setup: ['project'],
  extract_brand_kit: ['project'],
};

export const panesForTool = (name: string): readonly PaneKind[] => TOOL_PANES[name] ?? [];

type ToolResult = Extract<MessagePart, { type: 'tool-result' }>;

const ranName = (part: ToolResult): string => part.ranToolName ?? part.toolName;

const failed = (output: unknown): boolean =>
  output !== null && typeof output === 'object' && (output as { ok?: unknown }).ok === false;

/**
 * The panes changed by tool results not seen before, and the ids now seen.
 *
 * `seen` is the caller's: the live turn's parts arrive again with every event, and one result must
 * invalidate once, not once per event.
 */
export const panesForResults = (
  parts: readonly MessagePart[],
  seen: ReadonlySet<string>,
): { readonly panes: readonly PaneKind[]; readonly seen: readonly string[] } => {
  const panes = new Set<PaneKind>();
  const fresh: string[] = [];
  for (const part of parts) {
    if (part.type !== 'tool-result') continue;
    const id = String(part.toolCallId);
    if (seen.has(id)) continue;
    fresh.push(id);
    if (failed(part.output)) continue;
    for (const pane of panesForTool(ranName(part))) panes.add(pane);
  }
  return { panes: [...panes], seen: fresh };
};

/** A media job's state, as `generate_media`, `check_media_job` and the job route report it. */
const TERMINAL: ReadonlySet<string> = new Set(['succeeded', 'failed']);

/**
 * The media jobs this session started that are not known to be finished — what the light poll watches.
 *
 * Started by a `generate_media` result (`jobId`), finished by a `check_media_job` result in a terminal
 * state or by the poll itself (`done`).
 */
export const pendingMediaJobs = (parts: readonly MessagePart[], done: ReadonlySet<string>): readonly string[] => {
  const started: string[] = [];
  const finished = new Set(done);
  for (const part of parts) {
    if (part.type !== 'tool-result' || failed(part.output)) continue;
    const output = part.output as { jobId?: unknown; state?: unknown } | null;
    if (output === null || typeof output !== 'object' || typeof output.jobId !== 'string') continue;
    const name = ranName(part);
    if (name === 'generate_media') {
      if (typeof output.state === 'string' && TERMINAL.has(output.state)) finished.add(output.jobId);
      else if (!started.includes(output.jobId)) started.push(output.jobId);
    } else if (name === 'check_media_job' && typeof output.state === 'string' && TERMINAL.has(output.state)) {
      finished.add(output.jobId);
    }
  }
  return started.filter((id) => !finished.has(id));
};

/** How often a pending media job is polled, and for how long at most. */
export const MEDIA_POLL_MS = 5_000;
export const MEDIA_POLL_MAX_MS = 15 * 60_000;
