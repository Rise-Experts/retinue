/**
 * The `chorus-artifact:` reference contract.
 *
 * THE CONTRACT:
 *
 *     [Q3 launch plan](chorus-artifact:<uuid>)
 *
 * A link, for the same reasons as `chorus:post/` (see ./postToken.ts):
 * react-markdown parses it as an ordinary anchor so one `a` override handles it,
 * and it degrades to readable link text if the override is ever missing.
 *
 * WHY A REFERENCE AND NOT INLINE CONTENT: an artifact is a DOCUMENT — often long,
 * and revised in place. Inlining it would flood the transcript with the same
 * document repeated at every version, and an edit would leave the old copies
 * sitting above the new one looking equally current. A reference always resolves to
 * the latest version, and one card in the chat opens it.
 *
 * Pure so the rules are testable — the renderer is not, since this repo has no
 * jsdom.
 */

export const ARTIFACT_SCHEME = 'chorus-artifact:';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when this href uses the artifact scheme at all, valid id or not. */
export function isArtifactRef(href: string | undefined | null): boolean {
  return typeof href === 'string' && href.trim().toLowerCase().startsWith(ARTIFACT_SCHEME);
}

/**
 * Extracts the artifact id, or null when this is not a complete reference.
 *
 * Null also covers the streaming case: a reply arrives token by token, so
 * `chorus-artifact:8f14e45` exists for a frame, and rendering a card for it would
 * fetch an artifact that cannot be found.
 */
export function parseArtifactRef(href: string | undefined | null): string | null {
  if (!isArtifactRef(href)) return null;
  const id = (href as string).trim().slice(ARTIFACT_SCHEME.length);
  return UUID.test(id) ? id.toLowerCase() : null;
}

/** Builds a reference for an artifact id, or null if the id is not a uuid. */
export function formatArtifactRef(artifactId: string): string | null {
  if (typeof artifactId !== 'string') return null;
  const id = artifactId.trim();
  return UUID.test(id) ? `${ARTIFACT_SCHEME}${id.toLowerCase()}` : null;
}

export type ArtifactKind = 'markdown' | 'html' | 'mermaid' | 'slides' | 'react' | 'svg';

/**
 * The kinds an artifact may be, matching the DB check constraint. `slides` since #607
 * (20260928120000_artifact_slides_kind.sql): a deck as markdown split at lines of `---`. `react` and `svg`
 * since #607 part 3 (20260929090000_artifact_react_svg_kinds.sql): a single-file component run in the
 * panel's sandbox, and a vector drawing the agent service sanitizes before it is stored.
 */
export const ARTIFACT_KINDS: readonly ArtifactKind[] = ['markdown', 'html', 'mermaid', 'slides', 'react', 'svg'];

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === 'string' && (ARTIFACT_KINDS as readonly string[]).includes(value);
}

/**
 * Filename for downloading an artifact.
 *
 * Derived from the title so a download is recognisable, but sanitised hard: this
 * string reaches a Content-Disposition header and a filesystem, and a title is
 * model-generated text that may contain quotes, slashes or newlines.
 */
export function artifactFilename(title: string, kind: ArtifactKind): string {
  // A deck's source is markdown, so it downloads as .md like a document.
  const ext = kind === 'html' ? 'html' : kind === 'mermaid' ? 'mmd' : kind === 'react' ? 'jsx' : kind === 'svg' ? 'svg' : 'md';
  const base = (title || 'artifact')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  return `${base || 'artifact'}.${ext}`;
}

/** #607: what an artifact card says it is — a deck reads as a deck before it is opened. Shared with the Documents pane (#628). */
export const ARTIFACT_ICON: Record<ArtifactKind, string> = { markdown: "📄", html: "🌐", mermaid: "🔀", slides: "🎞️", react: "🧩", svg: "🖼️" };

/** The `assistant.*` message key naming each kind. */
export const ARTIFACT_KIND_KEY = {
  markdown: "artifactKindMarkdown",
  html: "artifactKindHtml",
  mermaid: "artifactKindMermaid",
  slides: "artifactKindSlides",
  react: "artifactKindReact",
  svg: "artifactKindSvg",
} as const satisfies Record<ArtifactKind, string>;
