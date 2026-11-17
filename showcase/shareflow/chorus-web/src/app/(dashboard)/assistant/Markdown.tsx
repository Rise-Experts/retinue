/**
 * The chat's markdown renderer, with custom handling for images and links.
 *
 * `read_url` now returns markdown that carries the page's own images and links
 * (see ai_backend/app/core/readpage.py), and `search_web` returns linked
 * sources, so an assistant reply routinely contains `![alt](url)` and
 * `[text](url)` pointing at arbitrary external hosts. Rendered raw those would
 * blow out the message column and open in the same tab.
 *
 * Two overrides:
 *
 *  - `img` → constrained, lazy-loaded, with the alt text shown as a caption and
 *    a text fallback if the image fails to load. A broken-image icon in a chat
 *    reply is worse than the filename.
 *  - `a`  → external targets open in a new tab with `rel="noopener noreferrer"`,
 *    so a cited source never navigates the app away and cannot reach
 *    `window.opener`.
 *
 * `next/image` is deliberately not used: these hosts are whatever page the
 * assistant read, and cannot be enumerated in `next.config` remotePatterns.
 */

"use client";

import { createContext, useContext, useState } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslations } from "next-intl";
import { fileNameOf, hostOf } from "@/lib/assistant/messageMedia";
import { isTrustedImageUrl } from "@/lib/assistant/trustedImages";
import { MEDIA_REF_SCHEME, isMediaRef, parseMediaRef, fileNameOfRef } from "@/lib/assistant/mediaRef";
import { POST_TOKEN_SCHEME, isPostToken, parsePostToken } from "@/lib/assistant/postToken";
import { isMermaidLang, parseMermaid } from "@/lib/assistant/mermaid";
import { ARTIFACT_ICON, ARTIFACT_KIND_KEY, ARTIFACT_SCHEME, isArtifactRef, parseArtifactRef } from "@/lib/assistant/artifactRef";
import { useArtifactKind } from "./useArtifactKind";
import MermaidDiagram from "./MermaidDiagram";
import PostHoverCard from "./PostHoverCard";
import { useSignedMedia } from "./useSignedMedia";
import styles from "./messages.module.css";

/**
 * Lets a message offer "attach this" on the images and links inside it, without
 * threading a callback through react-markdown's component map (which is built
 * once at module scope and cannot close over per-render props).
 *
 * Null when the surrounding message is not attachable — a user's own turn, or a
 * history replay — in which case no button is rendered at all.
 */
type AttachHandler = ((item: { url: string; label: string }) => void) | null;
const AttachContext = createContext<AttachHandler>(null);

/**
 * Whether THIS message may render a post preview card (SPEC #317 AC-2).
 *
 * False for a user's own turn. `UserMessage` renders the same markdown component,
 * so without this a user could type `[x](chorus:post/<uuid>)` and produce
 * something that looks like the assistant vouching for a post — a trivial
 * spoofing vector. The preview endpoint would still refuse a foreign post, but
 * the card must not appear at all in a user bubble.
 */
const PostCardsContext = createContext<boolean>(false);

/**
 * Opens an artifact in the side panel. Same context reasoning as AttachContext:
 * react-markdown's component map is built once at module scope and cannot close
 * over per-render props.
 */
type OpenArtifactHandler = ((artifactId: string) => void) | null;
const OpenArtifactContext = createContext<OpenArtifactHandler>(null);

/**
 * Opens a post in the side panel — #497. Same context reasoning as AttachContext. Null outside the
 * Assistant, where a post chip stays a link to the post's page.
 */
export type OpenPostHandler = ((postId: string) => void) | null;
const OpenPostContext = createContext<OpenPostHandler>(null);

/** Opens the full-size viewer. Same context reasoning as AttachContext. */
type OpenMediaHandler = ((item: { url: string; label: string }) => void) | null;
const OpenMediaContext = createContext<OpenMediaHandler>(null);

/**
 * The button revealed on hover/focus over an image or link. Keyboard-reachable
 * on purpose: hover-only would make this unusable without a mouse.
 */
function AttachButton({ url, label }: { url: string; label: string }) {
  const onAttach = useContext(AttachContext);
  const t = useTranslations("assistant");
  const [done, setDone] = useState(false);
  if (!onAttach) return null;

  return (
    <button
      type="button"
      className={styles.attachFromMessage}
      title={done ? t("attachedFromMessage") : t("attachThis")}
      aria-label={done ? t("attachedFromMessage") : t("attachThis")}
      onClick={() => {
        onAttach({ url, label });
        setDone(true);
      }}
    >
      {done ? "\u2713" : "+"}
    </button>
  );
}

/**
 * Whether this href leaves the app — and therefore must open in a new tab with `rel`.
 *
 * `^https?://` alone missed the **protocol-relative** form. `//evil.example/login` has a `/` before
 * its first `:`, so `defaultUrlTransform` classifies it as relative and passes it through (verified
 * against the real function), while this predicate called it internal — so it rendered through the
 * bare `<a href>` fallback with no `target="_blank"` and no `rel="noopener noreferrer"`, and a click
 * navigated the app away in the same tab, handing the destination a `window.opener`.
 *
 * That matters here specifically because reply text is model output steered by pages the model just
 * read, which is the threat model this file's own header describes. It claims "external targets open
 * in a new tab with `rel`, so a cited source never navigates the app away" — true for two of the three
 * ways to write an absolute URL.
 *
 * Also covers a bare scheme-relative host with no path (`//evil.example`), and stays false for a
 * genuine in-app path (`/accounts`) and for the custom schemes, which are intercepted before this.
 */
function isExternal(href: string | undefined): boolean {
  return /^(?:https?:)?\/\//i.test(href ?? "");
}

/**
 * An image reference in the prose. Renders as CLICKABLE TEXT, never an inline
 * `<img>`.
 *
 * Inline images made replies unreadable: a page read can carry a dozen, and
 * rendering them in the flow pushed the actual answer off screen and re-laid out
 * the message as each one loaded. The media itself is shown in the gallery below
 * the text, at a fixed tile size.
 *
 * Hover or focus shows a PREVIEW POPOVER; clicking opens the modal. The popover
 * is deliberately not the only way to see the image — it cannot be dismissed, so
 * a click target has to exist too.
 */
function MarkdownImage({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
  const onOpen = useContext(OpenMediaContext);
  const [hovered, setHovered] = useState(false);
  const [broken, setBroken] = useState(false);
  const label = (alt || title || "").trim();

  if (!src) return <span className={styles.mdImageFallback}>{label || "image"}</span>;

  const caption = label || fileNameOf(src);

  /*
   * #652: an image from a host we do not serve is never loaded by itself — not even as a hover preview, since
   * a hover is not a decision to contact that host. It is a link that names the host; opening it is the choice.
   */
  if (!isTrustedImageUrl(src)) {
    return (
      <a className={styles.mdLink} href={src} target="_blank" rel="noopener noreferrer" title={src}>
        <span aria-hidden="true">🖼</span> {caption} ({hostOf(src)})
      </a>
    );
  }

  return (
    <span
      className={styles.mdRefWrap}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className={styles.mdRef}
        onClick={() => onOpen?.({ url: src, label: caption })}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        title={caption}
      >
        <span aria-hidden="true">🖼</span> {caption}
      </button>
      <AttachButton url={src} label={caption} />
      {hovered && !broken && (
        <span className={styles.mdPreview} role="presentation">
          {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary external host */}
          <img
            className={styles.mdPreviewImage}
            src={src}
            alt={caption}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setBroken(true)}
          />
        </span>
      )}
    </span>
  );
}

/**
 * A workspace file the assistant referenced as `chorus-media:<path>` (SPEC #321).
 *
 * The reference is not loadable on its own — it must be signed for this session
 * first (`/api/media/sign`). Three states matter, and each has a specified
 * behaviour:
 *
 *  - INCOMPLETE reference (still streaming): render the label as plain text and
 *    fire NO request. `parseMediaRef` returns null until the path is whole,
 *    which is what makes this safe (SPEC #322 AC-4).
 *  - signing FAILED: fall back to the filename as text. A broken tile in a reply
 *    is worse than a filename, and the rest of the message must still render
 *    (AC-5).
 *  - resolved: behave exactly like an external image — clickable text, hover
 *    preview, gallery tile — so workspace files and web images look the same in
 *    the conversation.
 */
function WorkspaceMediaRef({
  href,
  label,
  isImage,
}: {
  href: string;
  label: string;
  isImage: boolean;
}) {
  const path = parseMediaRef(href);
  const { media, failed } = useSignedMedia(path);
  const onOpen = useContext(OpenMediaContext);
  const [hovered, setHovered] = useState(false);
  const [broken, setBroken] = useState(false);

  const caption = label || (path ? fileNameOfRef(path) : href);

  // Incomplete (mid-stream) or unsignable: plain text, no request, no broken icon.
  if (!path || failed) {
    return <span className={styles.mdImageFallback}>{caption}</span>;
  }

  // Resolved yet? While signing, show the label as text rather than a skeleton:
  // inline references are text-sized, so a placeholder would reflow the sentence.
  if (!media) {
    return <span className={styles.mdImageFallback}>{caption}</span>;
  }

  const showPreview = isImage && media.kind === "image" && !broken;

  return (
    <span
      className={styles.mdRefWrap}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className={styles.mdRef}
        onClick={() => onOpen?.({ url: media.url, label: caption })}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        title={caption}
      >
        <span aria-hidden="true">{media.kind === "image" ? "\ud83d\uddbc" : media.kind === "video" ? "\ud83c\udfac" : "\ud83d\udcc4"}</span> {caption}
      </button>
      <AttachButton url={media.url} label={caption} />
      {hovered && showPreview && (
        <span className={styles.mdPreview} role="presentation">
          {/* eslint-disable-next-line @next/next/no-img-element -- signed Supabase URL, not enumerable in remotePatterns */}
          <img
            className={styles.mdPreviewImage}
            src={media.url}
            alt={caption}
            loading="lazy"
            onError={() => setBroken(true)}
          />
        </span>
      )}
    </span>
  );
}

/**
 * A `chorus:post/<uuid>` reference. Renders as a link in the prose, with the card on hover.
 *
 * It used to render the card itself, inline: a reply mentioning three posts became three cards
 * stacked in the middle of the text, and expanding one pushed the rest of the conversation down.
 * The reference is a reference now, and the card is a popover over it.
 *
 * A malformed uuid still renders as text rather than a link to a card that would then 404 (AC-6) —
 * and `parsePostToken` returns null for a half-streamed token, so nothing appears mid-stream either.
 */
function PostTokenLink({ href, label }: { href: string; label: string }) {
  const allowed = useContext(PostCardsContext);
  const onOpenPost = useContext(OpenPostContext);
  const postId = parsePostToken(href);

  if (!allowed || !postId) {
    return <span className={styles.mdImageFallback}>{label || href}</span>;
  }
  return <PostHoverCard postId={postId} label={label} onOpen={onOpenPost ?? undefined} />;
}

/**
 * The compact inline card for an artifact.
 *
 * Deliberately small: it is a handle, not the document. Clicking opens the panel.
 * A malformed or half-streamed id renders as plain text rather than a card that
 * then fails to load.
 */
/** #607: what the card says it is, once its kind is known — a deck reads as a deck before it is opened. */

function ArtifactRefLink({ href, label }: { href: string; label: string }) {
  const onOpen = useContext(OpenArtifactContext);
  const t = useTranslations("assistant");
  const artifactId = parseArtifactRef(href);
  // Only for a card that can open: a plain-text fallback has nothing to label.
  const kind = useArtifactKind(artifactId && onOpen ? artifactId : null);

  if (!artifactId || !onOpen) {
    return <span className={styles.mdImageFallback}>{label || href}</span>;
  }

  return (
    <button
      type="button"
      className={styles.artifactChip}
      onClick={() => onOpen(artifactId)}
      title={label || t("artifact")}
    >
      <span aria-hidden="true">{ARTIFACT_ICON[kind ?? "markdown"]}</span>
      <span className={styles.artifactChipLabel}>{label || t("artifact")}</span>
      <span className={styles.artifactChipHint}>
        {kind ? `${t(ARTIFACT_KIND_KEY[kind])} · ` : ""}
        {t("artifactOpen")}
      </span>
    </button>
  );
}

/**
 * The app's own URL schemes, kept out of react-markdown's sanitiser.
 *
 * **Without this every one of them was silently deleted.** `defaultUrlTransform` allows
 * `http`, `https`, `mailto`, `irc`, `ircs` and `xmpp`, and returns `''` for anything else — so
 * `[Q3 playbook](chorus-artifact:<uuid>)` reached the DOM as `<a href="">`, `isArtifactRef('')` was
 * false, and the anchor fell through to the plain-link branch. The artifact chip, the post card and the
 * workspace-media reference were all written, unit-tested as pure functions, and **unreachable in a
 * browser**: clicking the link did nothing at all.
 *
 * The system prompt instructs the model to use all three by name — "put a markdown link to it in your
 * reply using the `reference` string a tool returned", "add a markdown link to it: `[short
 * label](chorus:post/<the postId a tool returned>)`" — so this was three product features described in
 * the prompt, implemented in the renderer, and cancelled by a default.
 *
 * `urlTransform` has never appeared anywhere in this repository's history, which is why: the components
 * are unit-testable and were tested, and nothing rendered them in a DOM this repo does not have.
 *
 * Everything else still goes through the sanitiser unchanged — `javascript:`, `data:` and `vbscript:`
 * hrefs in model-written markdown are exactly what it is there to remove.
 */
const APP_SCHEMES: readonly string[] = [ARTIFACT_SCHEME, MEDIA_REF_SCHEME, POST_TOKEN_SCHEME];

export function assistantUrlTransform(value: string): string {
  const lowered = value.trim().toLowerCase();
  return APP_SCHEMES.some((scheme) => lowered.startsWith(scheme)) ? value : defaultUrlTransform(value);
}

const components: Components = {
  /*
   * `node` is pulled out of the rest props on every override that spreads them.
   *
   * react-markdown passes the mdast node as a prop, and spreading it onto a DOM element writes
   * `node="[object Object]"` into the HTML — visible in the deployed app on every inline `code`. It is
   * an invalid attribute, so it does nothing except sit in the markup and confuse the next person to
   * open the inspector.
   */
  code: ({ className, children, node, ...rest }) => {
    if (isMermaidLang(className)) {
      const src = String(Array.isArray(children) ? children.join("") : (children ?? ""));
      const diagram = parseMermaid(src);
      // Not a diagram (yet) -> plain code. parseMermaid returns null for a
      // half-streamed block too, so no error graphic flashes mid-stream.
      return diagram ? <MermaidDiagram source={diagram} /> : <code className={className}>{src}</code>;
    }
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  },

  img: ({ src, alt, title }) => {
    const raw = typeof src === "string" ? src : undefined;
    // Workspace files need signing before they can be shown; external images do
    // not. Checked first so a reference is never handed to an <img> as-is.
    if (isMediaRef(raw)) {
      return <WorkspaceMediaRef href={raw!} label={(alt || title || "").trim()} isImage />;
    }
    return <MarkdownImage src={raw} alt={alt} title={title} />;
  },
  a: ({ href, children, node, ...rest }) =>
    isArtifactRef(href) ? (
      <ArtifactRefLink href={href!} label={typeof children === "string" ? children : ""} />
    ) : isPostToken(href) ? (
      <PostTokenLink href={href!} label={typeof children === "string" ? children : ""} />
    ) : isMediaRef(href) ? (
      <WorkspaceMediaRef
        href={href!}
        label={typeof children === "string" ? children : ""}
        isImage={false}
      />
    ) : isExternal(href) ? (
      <span className={styles.mdLinkWrap}>
        <a {...rest} href={href} target="_blank" rel="noopener noreferrer" className={styles.mdLink}>
          {children}
        </a>
        <AttachButton url={href ?? ""} label={typeof children === "string" ? children : (href ?? "")} />
      </span>
    ) : (
      <a {...rest} href={href} className={styles.mdLink}>
        {children}
      </a>
    ),
};

export default function Markdown({
  children,
  onAttach = null,
  onOpenMedia = null,
  allowPostCards = false,
  onOpenArtifact = null,
  onOpenPost = null,
}: {
  children: string;
  /** Provide to offer an attach button on this message's images and links. */
  onAttach?: AttachHandler;
  /** Provide to make image references open the full-size viewer. */
  onOpenMedia?: OpenMediaHandler;
  /**
   * Render `chorus:post/` tokens as preview cards. Assistant turns only — see
   * PostCardsContext.
   */
  allowPostCards?: boolean;
  /** Provide to make artifact references open the side panel. */
  onOpenArtifact?: OpenArtifactHandler;
  /** Provide to make post references open the post panel instead of navigating (#497). */
  onOpenPost?: OpenPostHandler;
}) {
  return (
    <AttachContext.Provider value={onAttach}>
      <PostCardsContext.Provider value={allowPostCards}>
      <OpenArtifactContext.Provider value={onOpenArtifact}>
      <OpenPostContext.Provider value={onOpenPost}>
      <OpenMediaContext.Provider value={onOpenMedia}>
        <div className={styles.markdown}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={assistantUrlTransform}>
            {children}
          </ReactMarkdown>
        </div>
      </OpenMediaContext.Provider>
      </OpenPostContext.Provider>
      </OpenArtifactContext.Provider>
      </PostCardsContext.Provider>
    </AttachContext.Provider>
  );
}
