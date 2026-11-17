/**
 * Pulls the images and links out of an assistant reply's markdown, so a message
 * can render them as a gallery beneath its text instead of inline.
 *
 * Why not collect them during render: react-markdown's component map is built
 * once at module scope, so gathering nodes as they render would need refs and an
 * effect, and would run again on every streamed token. Parsing the source string
 * is deterministic, cheap, and — being pure — actually testable, which matters
 * because this repo has no jsdom for component tests.
 */

import { isTrustedImageUrl } from './trustedImages';
import { parseMediaRef, fileNameOfRef } from './mediaRef';
import { mediaKindOf } from '@/lib/media';

export interface MessageImage {
  kind: 'image';
  url: string;
  label: string;
  /**
   * Set when `url` is a `chorus-media:` reference to a workspace file rather than
   * an external URL. The renderer must resolve it through `/api/media/sign`
   * before it can be displayed — the reference itself is not loadable.
   *
   * `url` still holds the reference (not the signed URL) because it is the
   * de-duplication key and the React key, and it stays stable while a signed URL
   * is refreshed on expiry.
   */
  path?: string;
}

export interface MessageLink {
  kind: 'link';
  url: string;
  label: string;
  /** See MessageImage.path. */
  path?: string;
}

export type MessageMediaItem = MessageImage | MessageLink;

/** `![alt](url)`, tolerating html2text's `<url>` form and a trailing "title". */
const IMAGE_RE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;
/** `[text](url)` — the negative lookbehind keeps image syntax out. */
const LINK_RE = /(?<!!)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;

/** Cap on gallery items. A page read can carry dozens; a wall of tiles is noise. */
export const MAX_GALLERY_ITEMS = 12;

function isHttp(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * A workspace file reference, if this target is one (SPEC #321).
 *
 * Returns the storage path only for a COMPLETE reference, so a half-streamed
 * href never becomes a gallery tile that then fails to sign.
 */
function workspacePathOf(url: string): string | null {
  return parseMediaRef(url);
}

/** `https://ex.com/a/b.png?x=1` -> `ex.com`, for a link tile's caption. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Last path segment, for labelling an image with no alt text. */
export function fileNameOf(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split('/').filter(Boolean).pop() ?? '') || hostOf(url);
  } catch {
    return url;
  }
}

/**
 * Extracts images first, then links, deduplicated by URL across BOTH lists.
 *
 * The cross-list dedupe matters: html2text often emits a linked image as
 * `[![alt](img)](href)`, which would otherwise appear once as a tile and again as
 * a link to the same asset.
 *
 * Only http(s) targets and `chorus-media:` workspace references are kept — a
 * `data:` URI cannot be shown at tile size usefully and would bloat the DOM.
 */
export function extractMessageMedia(
  markdown: string,
  limit: number = MAX_GALLERY_ITEMS,
): MessageMediaItem[] {
  const out: MessageMediaItem[] = [];
  const seen = new Set<string>();

  for (const match of markdown.matchAll(IMAGE_RE)) {
    const url = match[2].trim();
    if (seen.has(url)) continue;

    const path = workspacePathOf(url);
    if (!path && !isHttp(url)) continue;

    seen.add(url);
    // #652: an image from a host we do not serve is offered as a link, never loaded by itself.
    if (!path && !isTrustedImageUrl(url)) {
      out.push({ kind: 'link', url, label: match[1].trim() || hostOf(url) });
      continue;
    }
    out.push({
      kind: 'image',
      url,
      label: match[1].trim() || (path ? fileNameOfRef(path) : fileNameOf(url)),
      ...(path ? { path } : {}),
    });
  }

  for (const match of markdown.matchAll(LINK_RE)) {
    const url = match[2].trim();
    if (seen.has(url)) continue;

    const path = workspacePathOf(url);
    if (!path && !isHttp(url)) continue;

    seen.add(url);
    // A workspace file linked (rather than embedded) is a document: label it by
    // filename, since `hostOf` is meaningless for a storage path.
    out.push({
      kind: path ? (mediaKindOf(path) === 'image' ? 'image' : 'link') : 'link',
      url,
      label: match[1].trim() || (path ? fileNameOfRef(path) : hostOf(url)),
      ...(path ? { path } : {}),
    });
  }

  return out.slice(0, limit);
}
