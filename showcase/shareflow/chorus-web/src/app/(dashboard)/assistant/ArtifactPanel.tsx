/**
 * The artifact side panel — the Claude-style presentation.
 *
 * A long document does not belong in a chat transcript: it pushes the
 * conversation off screen, and after an edit the old copies sit above the new one
 * looking equally current. So the chat holds a compact card and the document opens
 * beside it.
 *
 * Matching the design that works there:
 *  - a header with the title, kind and "Version N"
 *  - Preview / Code tabs, because you sometimes want to read the document and
 *    sometimes need the source to copy
 *  - copy and download
 *  - version history, since every revision is kept
 *
 * #607: in a project chat with a theme, a markdown document previews as a designed page in that theme —
 * the same `--t-*` variables, heading colour and top rule the PDF prints with — and a slides artifact
 * previews as its deck (`SlidesPreview`). Outside a themed project a document looks as it always did.
 *
 * HTML and React previews render in a SANDBOXED IFRAME. The content is model-generated and
 * may legitimately contain scripts and styles; putting it in the page directly
 * would let it read the session, restyle the app, or navigate away. `sandbox` with
 * no `allow-same-origin` gives it a null origin, so it can render and do nothing
 * else — and #607 part 3 adds a strict CSP to the document itself (`sandboxDoc.ts`).
 * An SVG is drawn through an <img> data URL, never innerHTML, so it cannot run script.
 *
 * #607 part 5: a version timeline with Compare (a line diff against the current version) and Restore
 * (saved as a new version), full screen, open in a new tab (`/compose/artifact/[id]`, the same panel,
 * so the same sandbox), and "Edit with Chorus": select text in the preview or the code and ask for a
 * change to just that part.
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { readChatPosts, type ChatPost } from "@/lib/assistant/retinueClient";
import Markdown from "./Markdown";
import MermaidDiagram from "./MermaidDiagram";
import SlidesPreview from "./SlidesPreview";
import { DEFAULT_THEME_VARS, type SlideLogo, type ThemeVars } from "@/lib/assistant/artifactTheme";
import { artifactFilename, type ArtifactKind } from "@/lib/assistant/artifactRef";
import { SANDBOX, buildSandboxDoc, svgDataUrl } from "@/lib/assistant/sandboxDoc";
import { diffLines, diffStats } from "@/lib/assistant/artifactDiff";
import { buildEditRequest } from "@/lib/assistant/artifactEditRequest";
import { documentPlatforms } from "@/lib/platforms";
import styles from "./messages.module.css";

export interface ArtifactData {
  id: string;
  title: string;
  kind: ArtifactKind;
  content: string;
  version: number;
  versions?: number[];
  /** #607: the chat's project theme as CSS variables, or null outside a themed project. */
  theme?: ThemeVars | null;
  /** #615: the chat's project logo and its corner, for the slide preview. */
  logo?: SlideLogo | null;
}

/** #607: how an artifact can go on a post — a carousel is a deck's slides as images. */
export type AttachFormat = "pdf" | "image" | "carousel" | "video";

/** An archived revision, as `?version=N` returns it. */
type VersionView = { version: number; title: string; content: string };

/** Where the "Ask Chorus to change this" button sits, relative to the panel body, and what it quotes. */
type Pick = { text: string; top: number; left: number };

export default function ArtifactPanel({
  artifactId,
  onClose,
  conversationId = null,
  onAttachToPost = null,
  onEditRequest = null,
  standalone = false,
}: {
  artifactId: string;
  onClose: () => void;
  /** #589: the chat whose posts the document can go on. */
  conversationId?: string | null;
  /** #589: put this artifact on a post, as a PDF (LinkedIn) or an image (any channel). */
  onAttachToPost?: ((post: { readonly id: string; readonly label: string }, as: AttachFormat, title: string) => void) | null;
  /** #607: send a chat message asking for a change to the selected part. Absent, the selection button is not offered. */
  onEditRequest?: ((message: string) => void) | null;
  /** #607: the new-tab page — fills the window, with no close, full-screen or new-tab buttons. */
  standalone?: boolean;
}) {
  const t = useTranslations("assistant");
  const [data, setData] = useState<ArtifactData | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<"preview" | "code" | "compare">("preview");
  const [viewing, setViewing] = useState<VersionView | null>(null);
  const [copied, setCopied] = useState(false);
  const [full, setFull] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [pick, setPick] = useState<Pick | null>(null);
  const [asking, setAsking] = useState(false);
  const [instruction, setInstruction] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);

  // #607: the current version carries the chat's theme, so the preview dresses like the PDF.
  const loadCurrent = useCallback(async () => {
    // NOT reset here: this runs synchronously when called from an effect, and a
    // synchronous setState there triggers a cascading render. It is cleared on
    // success instead, which is the only moment it can actually become false.
    try {
      const url = `/api/artifacts/${artifactId}${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ""}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setData(await res.json());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [artifactId, conversationId]);

  /** An archived revision, kept beside the current one so Compare can diff the two. */
  const loadVersion = useCallback(
    async (version: number) => {
      try {
        const res = await fetch(`/api/artifacts/${artifactId}?version=${version}`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as VersionView;
        setViewing({ version: json.version, title: json.title, content: json.content });
      } catch {
        setFailed(true);
      }
    },
    [artifactId],
  );

  // The artifact id is used as a React key by the caller, so a different artifact
  // mounts a fresh panel rather than reusing this one — which means no state needs
  // clearing here, and clearing it synchronously would only cost an extra render.
  useEffect(() => {
    // `loadCurrent` is async and every setState inside it happens AFTER an await, so
    // nothing here is synchronous — the rule cannot see through the async
    // boundary. Same disable, and same reason, as compose/page.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setState occurs after await, not synchronously
    void loadCurrent();
  }, [loadCurrent]);

  // Escape leaves full screen before it does anything else.
  useEffect(() => {
    if (!full) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  /** What is on screen: the revision being looked at, or the current version. */
  const shown = useMemo(
    () => (data === null ? null : viewing === null ? data : { ...data, title: viewing.title, content: viewing.content, version: viewing.version }),
    [data, viewing],
  );

  const diff = useMemo(() => (data !== null && viewing !== null ? diffLines(viewing.content, data.content) : null), [data, viewing]);

  const copy = useCallback(async () => {
    if (!shown) return;
    try {
      await navigator.clipboard.writeText(shown.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard is permission-gated and can simply refuse; the Code tab still
      // shows the source for a manual copy, so this is not worth an error state.
    }
  }, [shown]);

  const download = useCallback(() => {
    if (!shown) return;
    // A blob download, not a server round-trip: the content is already here, and
    // this keeps the artifact out of a URL that could be shared by accident.
    const type = shown.kind === "svg" ? "image/svg+xml;charset=utf-8" : "text/plain;charset=utf-8";
    const blob = new Blob([shown.content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = artifactFilename(shown.title, shown.kind);
    a.click();
    URL.revokeObjectURL(url);
  }, [shown]);

  /** Saves the revision being viewed as a new version — nothing is overwritten (the route archives first). */
  const restore = useCallback(async () => {
    if (viewing === null) return;
    setRestoring(true);
    setRestoreFailed(false);
    try {
      const res = await fetch(`/api/artifacts/${artifactId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restoreVersion: viewing.version }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setViewing(null);
      setTab("preview");
      await loadCurrent();
    } catch {
      setRestoreFailed(true);
    } finally {
      setRestoring(false);
    }
  }, [artifactId, loadCurrent, viewing]);

  /** A selection inside the preview or the code becomes a small "Ask Chorus to change this" button beside it. */
  const onSelect = useCallback(() => {
    if (onEditRequest === null || asking) return;
    const body = bodyRef.current;
    const selection = window.getSelection();
    const text = selection?.toString() ?? "";
    if (!body || !selection || selection.rangeCount === 0 || text.trim() === "") {
      setPick(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!body.contains(range.commonAncestorContainer)) {
      setPick(null);
      return;
    }
    const box = range.getBoundingClientRect();
    const frame = body.getBoundingClientRect();
    setPick({
      text,
      top: box.bottom - frame.top + body.scrollTop + 6,
      left: Math.max(8, Math.min(box.left - frame.left, frame.width - 240)),
    });
  }, [asking, onEditRequest]);

  const sendEdit = useCallback(() => {
    if (onEditRequest === null || pick === null || shown === null) return;
    const message = buildEditRequest({ title: shown.title, artifactId, selected: pick.text, instruction });
    if (message === null) return;
    onEditRequest(message);
    setPick(null);
    setAsking(false);
    setInstruction("");
  }, [artifactId, instruction, onEditRequest, pick, shown]);

  if (failed) {
    return (
      <aside className={styles.artifactPanel}>
        <header className={styles.artifactHead}>
          <span className={styles.artifactTitle}>{t("artifactUnavailable")}</span>
          {!standalone && (
            <button type="button" className={styles.artifactClose} onClick={onClose} aria-label={t("close")}>
              ×
            </button>
          )}
        </header>
      </aside>
    );
  }

  const newTabHref = `/compose/artifact/${artifactId}${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ""}`;

  const panel = (
    <aside
      className={`${styles.artifactPanel}${full ? ` ${styles.artifactPanelFull}` : ""}${standalone ? ` ${styles.artifactPanelPage}` : ""}`}
      aria-label={t("artifact")}
    >
      <header className={styles.artifactHead}>
        <div className={styles.artifactHeadMain}>
          <span className={styles.artifactTitle}>{shown?.title ?? "…"}</span>
          {shown && (
            <span className={styles.artifactMeta}>
              {shown.kind} · {t("artifactVersion", { version: shown.version })}
            </span>
          )}
        </div>
        {!standalone && (
          <>
            <button
              type="button"
              className={styles.artifactHeadAction}
              onClick={() => setFull((v) => !v)}
              aria-pressed={full}
              title={full ? t("artifactExitFullScreen") : t("artifactFullScreen")}
            >
              {full ? t("artifactExitFullScreen") : t("artifactFullScreen")}
            </button>
            <a className={styles.artifactHeadAction} href={newTabHref} target="_blank" rel="noopener noreferrer">
              {t("artifactOpenNewTab")}
            </a>
            <button type="button" className={styles.artifactClose} onClick={onClose} aria-label={t("close")}>
              ×
            </button>
          </>
        )}
      </header>

      {shown && (
        <div className={styles.artifactToolbar}>
          <div className={styles.artifactTabs}>
            <button
              type="button"
              className={tab === "preview" ? styles.artifactTabActive : styles.artifactTab}
              onClick={() => setTab("preview")}
            >
              {t("artifactPreview")}
            </button>
            <button
              type="button"
              className={tab === "code" ? styles.artifactTabActive : styles.artifactTab}
              onClick={() => setTab("code")}
            >
              {t("artifactCode")}
            </button>
            {viewing !== null && (
              <button
                type="button"
                className={tab === "compare" ? styles.artifactTabActive : styles.artifactTab}
                onClick={() => setTab("compare")}
              >
                {t("artifactCompare")}
              </button>
            )}
          </div>

          <div className={styles.artifactActions}>
            {viewing !== null && !standalone && (
              <button type="button" className={styles.artifactAction} onClick={() => void restore()} disabled={restoring}>
                {restoring ? t("artifactRestoring") : t("artifactRestore", { version: viewing.version })}
              </button>
            )}
            <button type="button" className={styles.artifactAction} onClick={copy}>
              {copied ? t("copied") : t("copy")}
            </button>
            <button type="button" className={styles.artifactAction} onClick={download}>
              {t("download")}
            </button>
            {/* A React component only runs in this sandbox, so it cannot become a file for a post. */}
            {onAttachToPost !== null && conversationId !== null && data !== null && data.kind !== "react" && (
              <AttachToPost conversationId={conversationId} kind={data.kind} onPick={(post, as) => onAttachToPost(post, as, data.title)} />
            )}
          </div>
        </div>
      )}

      {data && data.versions && data.versions.length > 0 && (
        <div className={styles.artifactVersions} role="group" aria-label={t("artifactHistory")}>
          <button
            type="button"
            className={viewing === null ? styles.artifactVersionActive : styles.artifactVersion}
            onClick={() => {
              setViewing(null);
              if (tab === "compare") setTab("preview");
            }}
          >
            {t("artifactLatest")} · v{data.version}
          </button>
          {data.versions.map((v) => (
            <button
              key={v}
              type="button"
              className={viewing?.version === v ? styles.artifactVersionActive : styles.artifactVersion}
              onClick={() => void loadVersion(v)}
            >
              v{v}
            </button>
          ))}
        </div>
      )}
      {restoreFailed && <div className={styles.artifactNotice}>{t("artifactRestoreFailed")}</div>}

      <div className={styles.artifactBody} ref={bodyRef} onMouseUp={onSelect} onKeyUp={onSelect}>
        {!shown ? (
          <div className={styles.artifactLoading}>…</div>
        ) : tab === "compare" && diff !== null && viewing !== null ? (
          <DiffView lines={diff} from={viewing.version} to={data?.version ?? 0} />
        ) : tab === "code" ? (
          <pre className={styles.artifactSource}>{shown.content}</pre>
        ) : (
          <Preview artifact={shown} />
        )}

        {pick !== null && onEditRequest !== null && (
          <div className={styles.editPick} style={{ top: pick.top, left: pick.left }} onMouseUp={(e) => e.stopPropagation()}>
            {asking ? (
              <form
                className={styles.editPickForm}
                onSubmit={(event) => {
                  event.preventDefault();
                  sendEdit();
                }}
              >
                <input
                  className={styles.editPickInput}
                  autoFocus
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  onKeyUp={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      setAsking(false);
                      setPick(null);
                    }
                  }}
                  placeholder={t("artifactAskPlaceholder")}
                  aria-label={t("artifactAskPlaceholder")}
                />
                <button type="submit" className={styles.artifactAction} disabled={instruction.trim() === ""}>
                  {t("artifactAskSend")}
                </button>
              </form>
            ) : (
              <button type="button" className={styles.artifactAction} onClick={() => setAsking(true)}>
                {t("artifactAskChorus")}
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  );

  // Full screen is drawn at the document's root: the pane host clips and positions its children.
  return full && typeof document !== "undefined" ? createPortal(panel, document.body) : panel;
}

/** The preview of one kind. Scripted kinds only ever run inside the sandbox; an SVG only ever as an image. */
function Preview({ artifact }: { artifact: ArtifactData }): ReactNode {
  const srcDoc = useMemo(
    () =>
      artifact.kind === "html" || artifact.kind === "react"
        ? buildSandboxDoc({ kind: artifact.kind, content: artifact.content, theme: artifact.theme ?? null })
        : null,
    [artifact.kind, artifact.content, artifact.theme],
  );
  if (srcDoc !== null) {
    return (
      <iframe
        className={styles.artifactFrame}
        // No allow-same-origin: the document gets a null origin, so it can
        // render but cannot read cookies, storage, or reach into this page.
        // allow-scripts is included because an HTML artifact is often
        // interactive and the two together are only dangerous when combined
        // with same-origin. The CSP inside srcDoc limits where scripts come from.
        sandbox={SANDBOX}
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
        title={artifact.title}
      />
    );
  }
  if (artifact.kind === "svg") {
    // eslint-disable-next-line @next/next/no-img-element -- a data URL of a drawing; next/image adds nothing here
    return <img className={styles.artifactSvg} src={svgDataUrl(artifact.content)} alt={artifact.title} />;
  }
  if (artifact.kind === "mermaid") return <MermaidDiagram source={artifact.content} />;
  // A deck always has a design: the project's, or the default preset the export uses too.
  if (artifact.kind === "slides") return <SlidesPreview source={artifact.content} theme={artifact.theme ?? DEFAULT_THEME_VARS} logo={artifact.logo ?? null} />;
  if (artifact.theme) {
    return (
      <div className={styles.themedDoc} style={artifact.theme as CSSProperties}>
        <div className={styles.themedRule} />
        <Markdown>{artifact.content}</Markdown>
      </div>
    );
  }
  return <Markdown>{artifact.content}</Markdown>;
}

/** #607: the lines that changed between a revision and the current version. */
function DiffView({ lines, from, to }: { lines: ReturnType<typeof diffLines>; from: number; to: number }) {
  const t = useTranslations("assistant");
  const { added, removed } = diffStats(lines);
  return (
    <div className={styles.diff}>
      <div className={styles.diffSummary}>
        {t("artifactCompareSummary", { from, to, added, removed })}
      </div>
      {added === 0 && removed === 0 ? (
        <div className={styles.artifactLoading}>{t("artifactNoChanges")}</div>
      ) : (
        <pre className={styles.diffLines}>
          {lines.map((line, i) => (
            <div key={i} className={line.type === "add" ? styles.diffAdd : line.type === "del" ? styles.diffDel : styles.diffSame}>
              <span aria-hidden="true" className={styles.diffMark}>{line.type === "add" ? "+" : line.type === "del" ? "−" : " "}</span>
              {line.text || " "}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

/**
 * #589: "Attach to post" — this chat's posts, each with the shapes a post can carry. A PDF publishes on
 * LinkedIn only (a document post), and the whole draft is refused when any of its channels has no document
 * post type (`validateMediaForPlatform`), so PDF is offered only when EVERY channel takes one; a diagram and
 * every other post get an image. Production, 2026-09-28: PDF was offered on an Instagram post and then on
 * an Instagram + Facebook + LinkedIn post, and the tool refused both.
 */
const DOCUMENT_PLATFORMS: ReadonlySet<string> = new Set(documentPlatforms());

function AttachToPost({
  conversationId,
  kind,
  onPick,
}: {
  conversationId: string;
  kind: ArtifactKind;
  onPick: (post: { readonly id: string; readonly label: string }, as: AttachFormat) => void;
}) {
  // #607: an SVG is a drawing too — it goes on as an image, never a PDF.
  const diagram = kind === "mermaid" || kind === "svg";
  // #607: a deck goes on as a PDF (LinkedIn) or as a carousel of its slides — never one flattened image.
  const deck = kind === "slides";
  const t = useTranslations("assistant");
  const [open, setOpen] = useState(false);
  const [posts, setPosts] = useState<readonly ChatPost[] | null>(null);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && posts === null) void readChatPosts(conversationId).then(setPosts);
  };
  return (
    <div className={styles.attachRoot}>
      <button type="button" className={styles.artifactAction} aria-expanded={open} onClick={toggle}>
        {t("attachToPost")}
      </button>
      {open && (
        <div className={styles.attachMenu} role="menu" aria-label={t("attachToPost")}>
          {posts === null ? <div className={styles.attachHint}>{t("attachLoading")}</div> : null}
          {posts !== null && posts.length === 0 ? <div className={styles.attachHint}>{t("attachNoPosts")}</div> : null}
          {(posts ?? []).map((post) => {
            const label = post.caption.split("\n")[0]?.slice(0, 60) || post.id.slice(0, 8);
            const pdf = !diagram && post.platforms.length > 0 && post.platforms.every((p) => DOCUMENT_PLATFORMS.has(p));
            return (
              <div key={post.id} className={styles.attachRow}>
                {/* No title of the whole caption: it drew a tooltip over the entire panel. */}
                <span className={styles.attachLabel}>
                  <span className={styles.attachName}>{label}</span>
                  <span className={styles.attachSub}>{post.platforms.join(", ")}</span>
                </span>
                {pdf && (
                  <button type="button" role="menuitem" className={styles.artifactAction} onClick={() => { setOpen(false); onPick({ id: post.id, label }, "pdf"); }}>
                    {t("attachAsPdf")}
                  </button>
                )}
                <button type="button" role="menuitem" className={styles.artifactAction} onClick={() => { setOpen(false); onPick({ id: post.id, label }, deck ? "carousel" : "image"); }}>
                  {deck ? t("attachAsCarousel") : t("attachAsImage")}
                </button>
                {/* #620: a deck can also go on as an MP4 of it playing — for Reels, TikTok and LinkedIn video. */}
                {deck && (
                  <button type="button" role="menuitem" className={styles.artifactAction} onClick={() => { setOpen(false); onPick({ id: post.id, label }, "video"); }}>
                    {t("attachAsVideo")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

