/**
 * The post-reference token contract (SPEC #315 AC-1).
 *
 * THE CONTRACT, cited by both sides:
 *
 *   [Your LinkedIn post](chorus:post/<uuid>)
 *
 * The agent emits this in its reply whenever it creates or references a specific
 * post; the assistant pane renders it as an inline preview card.
 *
 * WHY A CUSTOM-SCHEME LINK rather than the alternatives:
 *  - `react-markdown` parses it as an ordinary `<a>`, so ONE `components={{ a }}`
 *    override is enough, and it degrades to readable link text if the override is
 *    ever missing.
 *  - A fenced ```chorus-post block would need a `code`/`pre` override and renders
 *    as a raw block when unhandled.
 *  - A bare `{{post:uuid}}` placeholder is not markdown at all, so `remark-gfm`
 *    leaves it as literal text and the FE would need text-node regex surgery.
 *
 * The scheme constant and the parser live here, in one module, so the renderer and
 * the instruction text cannot drift apart.
 *
 * Pure by design: this repo has no jsdom, so anything inside a component is
 * untestable — the rules that could be wrong belong here.
 */

export const POST_TOKEN_SCHEME = 'chorus:post/';

/**
 * A post id must be a UUID.
 *
 * Strict on purpose, and it is not a security boundary — the preview endpoint
 * scopes every lookup to the caller's workspace. It is a RENDERING guard: a
 * malformed id must render as ordinary link text rather than as a card that then
 * 404s, which is the specified behaviour (SPEC #317 AC-6).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when this href uses the post scheme at all, valid id or not. */
export function isPostToken(href: string | undefined | null): boolean {
  return typeof href === 'string' && href.trim().toLowerCase().startsWith(POST_TOKEN_SCHEME);
}

/**
 * Extracts the post id, or null when this is not a well-formed post token.
 *
 * Returns null (rather than throwing) for a partially-streamed token too: replies
 * arrive token by token, so `chorus:post/8f14e45` genuinely exists for a frame,
 * and rendering a card for it would fetch a preview for a post that does not
 * exist.
 */
export function parsePostToken(href: string | undefined | null): string | null {
  if (!isPostToken(href)) return null;

  const id = (href as string).trim().slice(POST_TOKEN_SCHEME.length);
  return UUID.test(id) ? id.toLowerCase() : null;
}

/** Builds a token for a post id, or null if the id is not a UUID. */
export function formatPostToken(postId: string): string | null {
  if (typeof postId !== 'string') return null;
  const id = postId.trim();
  return UUID.test(id) ? `${POST_TOKEN_SCHEME}${id.toLowerCase()}` : null;
}
