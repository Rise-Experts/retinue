/**
 * How files the user attaches in the chat reach the agent.
 *
 * AgentOS's run endpoint takes a message; there is no attachment channel on it.
 * Rather than change that contract, the proxy appends a delimited block listing
 * the storage paths, and the agent is instructed to pass those verbatim as
 * `media_urls` to `create_draft`.
 *
 * The block is added SERVER-SIDE, in `/api/assistant/runs`, for two reasons:
 *
 *  1. The paths must be re-validated against the caller's workspace before the
 *     agent (and later the publish worker, which signs them with the
 *     service-role client) ever sees them. A client that forged
 *     `other-workspace/secret.pdf` would otherwise get it attached to a post.
 *  2. The user's own message bubble stays clean — the block never appears in
 *     what they typed.
 */

import { sanitizeMediaRefs } from '@/lib/media';

const OPEN = '[attached-media]';
const CLOSE = '[/attached-media]';

/**
 * Builds the block, one storage path per line. Returns '' for no paths so
 * callers can concatenate unconditionally.
 */
export function buildAttachmentBlock(paths: readonly string[]): string {
  if (paths.length === 0) return '';
  return [OPEN, ...paths, CLOSE].join('\n');
}

/**
 * Appends the attachment block to `message`, after sanitizing `paths` against
 * `workspaceId`.
 *
 * Sanitizing here (not in the browser) is the security boundary: `sanitizeMediaRefs`
 * drops any storage path outside the caller's own workspace folder, which is the
 * same rule the publish path relies on. It also caps the count.
 *
 * Returns the message unchanged when nothing survives sanitizing.
 */
export function appendAttachments(
  message: string,
  paths: unknown,
  workspaceId: string,
): string {
  const safe = sanitizeMediaRefs(paths, workspaceId);
  const block = buildAttachmentBlock(safe);
  if (!block) return message;
  return `${message}\n\n${block}`;
}

/**
 * Parses the paths back out of a message. Used by tests and available for
 * anything that needs to render or audit what was attached; the agent itself
 * reads the block as plain text.
 */
export function parseAttachmentBlock(message: string): string[] {
  const start = message.indexOf(OPEN);
  if (start === -1) return [];
  const end = message.indexOf(CLOSE, start);
  if (end === -1) return [];
  return message
    .slice(start + OPEN.length, end)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
