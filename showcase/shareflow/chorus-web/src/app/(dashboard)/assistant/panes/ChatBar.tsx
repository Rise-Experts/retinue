"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import styles from "./panes.module.css";

export const PANES = ["post", "posts", "media", "documents", "project", "calendar"] as const;
export type PaneId = (typeof PANES)[number];

const GLYPH: Record<PaneId, React.ReactNode> = {
  post: (
    <>
      <path d="M4 2h6l3 3v9H4z" />
      <path d="M10 2v3h3" />
    </>
  ),
  posts: <path d="M3 4h10M3 8h10M3 12h10" />,
  media: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 11l3.5-3.5 3 3 2-2L14 12" />
    </>
  ),
  // #628: stacked pages — the chat's documents, decks and diagrams.
  documents: (
    <>
      <path d="M5 4.5h6.5l2 2V14H5z" />
      <path d="M3 12V2.5h6.5" />
    </>
  ),
  project: <path d="M2 4.5h4l1.5 1.5H14v6.5H2z" />,
  calendar: (
    <>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
    </>
  ),
};

/**
 * The chat's part of the top bar — #544, #546: which conversation this is, its project, whether the
 * assistant is working, and the pane toggles (Claude Code's row of buttons for its side panes).
 *
 * A toggle with news on it — a post the agent wrote while its pane was closed — carries a dot rather
 * than opening itself (#546 AC-2).
 */
export function ChatBar({
  title,
  project,
  streaming,
  open,
  onToggle,
  news,
}: {
  title: string | undefined;
  project: { readonly id: string; readonly name: string } | null;
  streaming: boolean;
  open: PaneId | null;
  onToggle: (pane: PaneId) => void;
  news: ReadonlySet<PaneId>;
}) {
  const t = useTranslations("assistant");
  return (
    <div className={styles.bar}>
      <span className={styles.barTitle}>{title ?? t("panes.newChat")}</span>
      {project !== null && (
        <Link href={`/compose/p/${project.id}`} className={styles.barChip}>
          {t("projects.inProject", { name: project.name })}
        </Link>
      )}
      {streaming && <span className={styles.barStatus} role="status">{t("thinking")}</span>}
      <span className={styles.grow} />
      <div className={styles.toggles} role="group" aria-label={t("panes.label")}>
        {PANES.map((pane) => (
          <button
            key={pane}
            type="button"
            className={styles.toggle}
            aria-pressed={open === pane}
            aria-label={news.has(pane) ? t("panes.withNews", { name: t(`panes.${pane}`) }) : t(`panes.${pane}`)}
            title={t(`panes.${pane}`)}
            onClick={() => onToggle(pane)}
          >
            <svg className={styles.ic} viewBox="0 0 16 16" aria-hidden="true">
              {GLYPH[pane]}
            </svg>
            {news.has(pane) && <span className={styles.dot} aria-hidden="true" />}
          </button>
        ))}
      </div>
    </div>
  );
}
