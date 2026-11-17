/**
 * The `chorus-media:` reference contract (SPEC #321).
 *
 * How the assistant refers to a workspace file in its reply so the chat can
 * render it:
 *
 *   ![Q3 chart](chorus-media:<workspace-id>/<uuid>.png)
 *   [Q3 deck.pdf](chorus-media:<workspace-id>/<uuid>.pdf)
 *
 * WHY A SCHEME AND NOT A SIGNED URL: signed URLs expire after
 * `SIGNED_URL_TTL_SECONDS` (1h), and message text is persisted into AgentOS run
 * history. Embedding one means a session reopened tomorrow renders dead images,
 * and a credential-bearing URL is written into conversation storage. A path is
 * stable and carries no authority on its own — the reader signs it, scoped to
 * their own session (see `/api/media/sign`).
 *
 * This module is deliberately pure. Component behaviour cannot be unit-tested in
 * this repo (no jsdom, no @testing-library — `vitest.config.ts` uses the node
 * environment), so every rule that could be wrong lives here instead of inside
 * the renderer.
 */

export const MEDIA_REF_SCHEME = 'chorus-media:';

/**
 * A storage path: a workspace-id segment, optional subfolders, then a filename
 * with an extension.
 *
 * Subfolders are REQUIRED to be allowed: derived files live at
 * `{workspace}/converted/{digest}.png` (`media-convert.ts`) and
 * `{workspace}/edited/{uuid}.mp4` (`/api/media/edit-video`), and those are
 * precisely the files the assistant most often has reason to show. A
 * single-segment pattern would reject every converted file.
 *
 * The extension is anchored to the END, so a trailing segment cannot masquerade
 * as one (`a.png/evil` does not match). Backslash is excluded throughout.
 *
 * This is a SHAPE check, not the security boundary — the tenancy boundary is
 * `decideSignRequest`, which compares the workspace segment against the caller's
 * own session. So the first segment is not required to be a UUID: workspace ids
 * are UUIDs in production, but hard-coding that here would only add a way for a
 * legitimate path to be silently dropped.
 */
const STORAGE_PATH = /^[A-Za-z0-9_-]{1,64}(?:\/[^/\\]+)*\/[^/\\]+\.[a-z0-9]{1,8}$/i;

/**
 * Parses a markdown href into a storage path, or null if it is not a *complete*
 * reference.
 *
 * COMPLETENESS IS THE POINT. Assistant text arrives token by token, so a
 * partially-streamed href like `chorus-media:ws-id/abc` genuinely exists for a
 * frame or two. Requiring the full shape — including a file extension — means a
 * truncated path never resolves, so the renderer cannot fire a signing request
 * for a path that does not exist yet (SPEC #322 AC-4).
 *
 * Returns null rather than throwing: an unparseable reference degrades to plain
 * text in the reply, which is the specified fallback.
 */
export function parseMediaRef(href: string | undefined | null): string | null {
  if (typeof href !== 'string') return null;

  const trimmed = href.trim();
  if (!trimmed.toLowerCase().startsWith(MEDIA_REF_SCHEME)) return null;

  const path = trimmed.slice(MEDIA_REF_SCHEME.length);

  // Traversal and encoded traversal are rejected here as well as at the signing
  // route. This one is not the security boundary — the route is — but a ref that
  // cannot be trusted should never reach the network in the first place.
  if (path.includes('..') || path.includes('%2e%2e') || path.toLowerCase().includes('%2f')) {
    return null;
  }

  return STORAGE_PATH.test(path) ? path : null;
}

/** True when this href is a `chorus-media:` reference at all, complete or not. */
export function isMediaRef(href: string | undefined | null): boolean {
  return typeof href === 'string' && href.trim().toLowerCase().startsWith(MEDIA_REF_SCHEME);
}

/**
 * Builds a reference for a storage path.
 *
 * Used server-side so the agent copies a ready-made string instead of composing
 * one from a path it half-remembers — see the `reference` field the internal
 * routes return. Returns null for anything that is not a storage path, so a
 * signed URL or an external link can never be dressed up as a workspace file.
 */
export function formatMediaRef(path: string): string | null {
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  return STORAGE_PATH.test(trimmed) ? `${MEDIA_REF_SCHEME}${trimmed}` : null;
}

/** Filename portion of a path or reference, for labels and document chips. */
export function fileNameOfRef(pathOrRef: string): string {
  const path = parseMediaRef(pathOrRef) ?? pathOrRef;
  return path.split('/').pop() ?? path;
}
