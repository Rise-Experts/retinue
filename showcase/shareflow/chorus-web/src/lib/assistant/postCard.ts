/**
 * The `chorus-post` block: a whole post, rendered as a card in the chat.
 *
 * THE CONTRACT, cited by both sides:
 *
 *     ```chorus-post
 *     {"postId":"<uuid>","status":"APPROVED","platforms":["linkedin"],
 *      "media":["chorus-media:<ws>/a.png"],"text":"The caption\nsecond line"}
 *     ```
 *
 * WHY A FENCED BLOCK AND NOT A LINK: the sibling `chorus:post/<uuid>` token
 * (see ./postToken.ts) is a compact *reference* — a chip that fetches its preview
 * on hover. This is the other case: "here is the post I just made", where the
 * text and media are already known, so a round-trip to fetch them is waste and a
 * collapsed chip hides the thing the reply is about. A block renders EXPANDED
 * with no network call.
 *
 * WHY THE TEXT LIVES IN A JSON STRING: a post's caption legitimately contains
 * markdown-significant characters — `*`, `_`, `#`, `[`. Interpolated into prose it
 * would be re-interpreted, so `**bold**` would render bold in the preview while
 * the platform publishes literal asterisks. Inside a JSON string in a code fence
 * it is inert, which is the whole point: the card must show what will actually be
 * published.
 *
 * WHY MEDIA IS AN ARRAY: one field, one meaning, in order. Media order is the
 * order a platform renders a carousel in, so it has to survive as a list rather
 * than as prose the model formats however it likes.
 *
 * The backend builds this string and the agent copies it verbatim (see the `card`
 * field the internal routes return) — the model is never asked to compose JSON,
 * which is what keeps malformed blocks out of replies.
 *
 * Pure by design: this repo has no jsdom, so rules inside a component are
 * untestable. Everything that could be wrong lives here.
 */

/** The fence info string that marks a post block. */
export const POST_CARD_LANG = 'chorus-post';

export interface PostCardData {
  postId: string;
  /** Publish-ready text — already `toPlatformText`-converted, NOT markdown. */
  text: string;
  platforms: string[];
  status: string;
  /** `chorus-media:` references, in attachment order. */
  media: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Builds the block for a post. Returns null when `postId` is not a UUID, so a
 * block that could never resolve is never emitted.
 */
export function formatPostCard(data: {
  postId: string;
  text: string;
  platforms?: readonly string[];
  status?: string;
  media?: readonly string[];
}): string | null {
  if (typeof data.postId !== 'string' || !UUID.test(data.postId.trim())) return null;

  const payload: PostCardData = {
    postId: data.postId.trim().toLowerCase(),
    text: data.text ?? '',
    platforms: (data.platforms ?? []).map((p) => String(p).toLowerCase()),
    status: data.status ?? 'DRAFT',
    media: (data.media ?? []).map(String),
  };

  return `\`\`\`${POST_CARD_LANG}\n${JSON.stringify(payload)}\n\`\`\``;
}

/**
 * Parses a block's contents into card data, or null if it is not usable.
 *
 * Returns null rather than throwing for every failure mode — malformed JSON, a
 * bad id, the wrong shape, or a block still being streamed (the JSON is
 * incomplete until the closing brace arrives). The renderer's fallback is to show
 * the raw block, which is honest: the user sees that something was emitted rather
 * than a card silently vanishing.
 */
export function parsePostCard(raw: string): PostCardData | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  const postId = typeof obj.postId === 'string' ? obj.postId.trim().toLowerCase() : '';
  if (!UUID.test(postId)) return null;

  return {
    postId,
    text: typeof obj.text === 'string' ? obj.text : '',
    // Filtered to strings rather than trusted: this JSON came back through a
    // language model, so a stray null in the array must not become "null" on
    // screen or a signing request for a nonexistent path.
    platforms: Array.isArray(obj.platforms)
      ? obj.platforms.filter((p): p is string => typeof p === 'string').map((p) => p.toLowerCase())
      : [],
    status: typeof obj.status === 'string' ? obj.status : 'DRAFT',
    media: Array.isArray(obj.media) ? obj.media.filter((m): m is string => typeof m === 'string') : [],
  };
}

/** True when a react-markdown code node's className marks it as a post block. */
export function isPostCardLang(className: string | undefined): boolean {
  return typeof className === 'string' && className.split(/\s+/).includes(`language-${POST_CARD_LANG}`);
}
