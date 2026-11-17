/**
 * Which post the Assistant's side panel should show — #497.
 *
 * The panel is bound to a **post draft id**, not to an artifact: a post already has a home (the
 * `posts` row), and the agent's post tools return its id in their result. This reads those results
 * out of a turn's parts, the same way `artifactsIn` reads artifacts.
 *
 * Pure, over `MessagePart[]`, so the chat can derive the panel from its parts rather than syncing it
 * with an effect — the rule `RetinueChat`'s artifact choice already follows.
 */

import type { MessagePart } from '@retinue/react';

import { parsePostToken } from './postToken';

/**
 * Tools whose result names the post they wrote. `postDraftId` is the key every one of them uses
 * (`shareflow/src/tools/posts.ts`, `compose.ts`, `media.ts`), and it is `posts.id`.
 */
export const POST_TOOLS: ReadonlySet<string> = new Set([
  'create_post_draft',
  'create_thread_draft',
  'update_post_draft',
  'duplicate_post_draft',
  'draft_post_for_channels',
  'revise_post_channels',
  'attach_media_to_post',
  'detach_media_from_post',
  'replace_media_on_post',
]);

/** The tools that write captions, whose running call puts cards into their "Writing…" state. */
const WRITING_TOOLS: ReadonlySet<string> = new Set(['draft_post_for_channels', 'revise_post_channels']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const postIdOf = (value: unknown): string | null => {
  if (value === null || typeof value !== 'object') return null;
  const id = (value as { postDraftId?: unknown }).postDraftId;
  return typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : null;
};

const platformsOf = (value: unknown): readonly string[] => {
  if (value === null || typeof value !== 'object') return [];
  const ids = (value as { platformIds?: unknown }).platformIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
};

export type PostActivity = {
  /** The post the turn last wrote, or the one a running revision is changing. Null while a new draft is still being written. */
  readonly postId: string | null;
  /**
   * Channels a running caption tool is writing. For a new draft these are the cards to show before
   * the post exists; for a revision with no channels named, `all` means every channel on the post.
   */
  readonly writing: readonly string[] | 'all';
  /**
   * How many finished tool results changed this post. The panel reloads the saved draft whenever it
   * goes up, which is how a chat revision reaches cards the person is looking at.
   */
  readonly revision: number;
  /** Position of the newest part that concerns a post, so the chat can tell whether it or an artifact came last. */
  readonly at: number;
};

/**
 * The post the parts are about, if any.
 *
 * `at` is an index into `parts`; the chat compares it with the newest artifact's to decide which panel
 * the turn opened, since only one is shown at a time.
 */
export const postActivityIn = (parts: readonly MessagePart[], liveFrom = 0): PostActivity | null => {
  const finished = new Set<string>();
  for (const part of parts) if (part.type === 'tool-result') finished.add(String(part.toolCallId));

  let postId: string | null = null;
  let at = -1;
  let writing: readonly string[] | 'all' = [];
  const revisions = new Map<string, number>();

  parts.forEach((part, index) => {
    if (part.type === 'tool-result') {
      const name = part.ranToolName ?? part.toolName;
      if (!POST_TOOLS.has(name)) return;
      const id = postIdOf(part.output);
      if (id === null) return; // a refusal carries no id, and there is nothing new to show
      revisions.set(id, (revisions.get(id) ?? 0) + 1);
      postId = id;
      at = index;
      return;
    }
    if (part.type === 'tool-call' && WRITING_TOOLS.has(part.toolName) && !finished.has(String(part.toolCallId))) {
      const target = postIdOf(part.input);
      // Only the live turn can still be writing: an unanswered call in an earlier turn was interrupted,
      // so its post is shown as saved, and a new draft that never got an id shows nothing.
      if (index < liveFrom) {
        if (target !== null) {
          postId = target;
          writing = [];
          at = index;
        }
        return;
      }
      const channels = platformsOf(part.input);
      // A revision with no channels named rewrites every channel on the post.
      writing = channels.length > 0 ? channels : target === null ? [] : 'all';
      // A new draft has no id yet: the panel opens on the channels being written.
      postId = target;
      at = index;
    }
  });

  if (at === -1) return null;
  return { postId, writing, revision: postId === null ? 0 : revisions.get(postId) ?? 0, at };
};

/** The newest artifact's position, for the same comparison. */
export const lastArtifactAt = (parts: readonly MessagePart[]): number => {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]!.type === 'artifact') return index;
  }
  return -1;
};

/**
 * Finished results that changed `postId`, over every turn in the session — the panel's reload key.
 *
 * Counted over all turns rather than the live one, so a post opened from an earlier answer still
 * reloads when a later turn revises it.
 */
export const revisionsOf = (postId: string, turns: readonly (readonly MessagePart[])[]): number => {
  let count = 0;
  for (const parts of turns) {
    for (const part of parts) {
      if (part.type !== 'tool-result') continue;
      if (!POST_TOOLS.has(part.ranToolName ?? part.toolName)) continue;
      if (postIdOf(part.output) === postId) count += 1;
    }
  }
  return count;
};

/** A `chorus:post/<id>` href, or a bare id, as the post id the panel takes. */
export const postIdFromHref = (href: string): string | null => {
  const token = parsePostToken(href);
  if (token !== null) return token.toLowerCase();
  return UUID.test(href) ? href.toLowerCase() : null;
};

/**
 * What the reader chose for the side panel, and **when**: `at` is the position of the newest panel
 * activity at the moment they chose. `null` follows the session. A choice holds until something newer
 * happens — a post the agent writes after the reader closed the panel opens it again, and one chosen
 * from a chip gives way to the next post the agent writes.
 */
export type PanelChoice =
  | { readonly kind: 'artifact' | 'post'; readonly id: string; readonly at: number }
  | { readonly kind: 'closed'; readonly at: number }
  | null;

export type OpenPanel =
  | { readonly kind: 'artifact'; readonly id: string }
  | { readonly kind: 'post'; readonly postId: string | null; readonly writing: readonly string[] | 'all' }
  | null;

/** Position of the newest part that opens a panel — a post or an artifact — or -1. */
export const latestPanelAt = (parts: readonly MessagePart[]): number =>
  Math.max(postActivityIn(parts)?.at ?? -1, lastArtifactAt(parts));

/**
 * The panel to show, over **every turn in this session**, oldest first (`parts`), with `liveFrom`
 * where the running turn starts.
 *
 * The session, not the live turn: following only the live turn closed the panel the moment the next
 * message was sent — a new turn has no parts yet — which production showed on the first "now make
 * LinkedIn shorter". A post chosen by the reader still shows "Writing…" when the live turn revises it.
 */
export const openPanelFor = (choice: PanelChoice, parts: readonly MessagePart[], liveFrom = 0): OpenPanel => {
  const activity = postActivityIn(parts, liveFrom);
  const artifactAt = lastArtifactAt(parts);
  const latest = Math.max(activity?.at ?? -1, artifactAt);
  if (choice !== null && latest <= choice.at) {
    if (choice.kind === 'closed') return null;
    if (choice.kind === 'artifact') return { kind: 'artifact', id: choice.id };
    return { kind: 'post', postId: choice.id, writing: activity !== null && activity.postId === choice.id ? activity.writing : [] };
  }
  if (latest === -1) return null;
  if (activity !== null && activity.at > artifactAt) return { kind: 'post', postId: activity.postId, writing: activity.writing };
  const part = parts[artifactAt]!;
  return part.type === 'artifact' ? { kind: 'artifact', id: String(part.artifactId ?? part.versionId) } : null;
};
