import { PLATFORMS, type PlatformId } from "@/lib/platforms";
import { formatPostToken } from "@/lib/assistant/postToken";
import { emptyDraft, scheduleCaptions, type ChannelDraft } from "../compose/sessionModel";
import type { MediaItem } from "../compose/mediaItem";

/**
 * The post panel's pure parts — #497. What a saved post looks like on the board, what the board saves
 * back, and what "Schedule" asks the agent to do.
 */

export type Drafts = Partial<Record<PlatformId, ChannelDraft>>;

/** `GET /api/posts/:id` — `loadPostForEdit`'s answer. */
export type LoadedPost = {
  readonly postId: string;
  readonly caption: string;
  readonly platformCaptions: Readonly<Record<string, string>>;
  readonly platforms: readonly string[];
  readonly status: string;
  readonly media: readonly { path: string; url: string; kind: "image" | "video" | "document" }[];
  readonly editable: boolean;
  readonly textFormatPresetId?: string | null;
};

const KNOWN = new Set<string>(PLATFORMS.map((p) => p.id));

export const platformsOf = (post: LoadedPost): PlatformId[] =>
  post.platforms.filter((p): p is PlatformId => KNOWN.has(p));

/** One card per channel the post targets: its own caption where it has one, the shared one otherwise. */
export const draftsFromPost = (post: LoadedPost): Drafts =>
  Object.fromEntries(
    platformsOf(post).map((id) => [id, { ...emptyDraft(), text: post.platformCaptions[id] ?? post.caption }]),
  ) as Drafts;

export const mediaFromPost = (post: LoadedPost): MediaItem[] =>
  post.media.map((m) => ({
    path: m.path,
    previewUrl: m.url,
    uploading: false,
    isVideo: m.kind === "video",
    ext: m.path.split(".").pop() ?? "",
  }));

/**
 * What the board saves — `PATCH /api/posts/:id`, the same fields compose's edit path sends.
 *
 * Null when there is nothing savable yet: the route refuses an empty caption or no channels, and a
 * card someone has just cleared to retype is not an error worth a red message.
 */
export const patchBodyFor = (board: {
  drafts: Drafts;
  selected: readonly PlatformId[];
  media: readonly MediaItem[];
  presetId: string | null;
}): {
  caption: string;
  platforms: PlatformId[];
  platformCaptions: Partial<Record<PlatformId, string>>;
  mediaPaths: string[];
  textFormatPresetId: string | null;
} | null => {
  const { caption, platformCaptions } = scheduleCaptions(board.drafts, board.selected);
  if (caption === "" || board.selected.length === 0) return null;
  return {
    caption,
    platforms: [...board.selected],
    platformCaptions,
    mediaPaths: board.media.filter((m) => !m.uploading).map((m) => m.path),
    // A background cannot survive an attachment (#316 AC-4), the rule compose derives the same way.
    textFormatPresetId: board.media.length > 0 ? null : board.presetId,
  };
};

/**
 * The message "Schedule" or "Post now" sends to the agent.
 *
 * Scheduling from the panel goes **through the agent** rather than `/api/schedule`, so it meets the
 * same gated `schedule_post` / `publish_post_now` and the same approval card as asking in words.
 * `/api/schedule` could not do it anyway: it refuses an existing post that is not yet APPROVED.
 *
 * The time is given both as the person typed it and as an absolute instant, so the agent never has
 * to guess a timezone — `publishing-safety`'s first rule.
 */
export const scheduleRequest = (req: {
  postId: string;
  channels: readonly string[];
  when: "now" | "schedule";
  date: string;
  time: string;
  format: "post" | "story";
  timeZone: string;
}): string => {
  const token = formatPostToken(req.postId) ?? req.postId;
  const on = req.channels.join(", ");
  const story = req.format === "story" ? " as a story" : "";
  if (req.when === "now") return `Post ${token} now${story} on ${on}.`;
  const instant = new Date(`${req.date}T${req.time}:00`);
  const iso = Number.isNaN(instant.getTime()) ? "" : ` (${instant.toISOString()})`;
  return `Schedule ${token}${story} on ${on} for ${req.date} ${req.time} ${req.timeZone}${iso}.`;
};

/** Cards a running caption tool is writing, marked so the board shows "Writing…" on them. */
/**
 * #497 AC-1: the channels a running write has already finished, over the "writing" cards — a caption fills its
 * card and stops its spinner; null (could not be written) just stops the spinner.
 */
export const withWritten = (drafts: Drafts, written: Readonly<Record<string, string | null>>): Drafts => {
  const entries = Object.entries(written);
  if (entries.length === 0) return drafts;
  const next: Drafts = { ...drafts };
  for (const [id, caption] of entries) {
    const current = next[id as PlatformId];
    if (current === undefined) continue;
    next[id as PlatformId] = { ...current, generating: false, ...(caption === null ? {} : { text: caption }) };
  }
  return next;
};

export const withWriting = (drafts: Drafts, channels: readonly PlatformId[], writing: readonly string[] | "all"): Drafts => {
  const busy = writing === "all" ? new Set<string>(channels) : new Set(writing);
  if (busy.size === 0) return drafts;
  const next: Drafts = { ...drafts };
  for (const id of channels) if (busy.has(id)) next[id] = { ...(drafts[id] ?? emptyDraft()), generating: true };
  return next;
};
