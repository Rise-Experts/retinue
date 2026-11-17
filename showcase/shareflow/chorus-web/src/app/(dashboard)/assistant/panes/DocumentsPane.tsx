"use client";

import { useCallback, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { paneKey, usePaneData } from "@/lib/assistant/paneCache";
import { ARTIFACT_ICON, ARTIFACT_KIND_KEY, isArtifactKind, type ArtifactKind } from "@/lib/assistant/artifactRef";
import styles from "./panes.module.css";

export type DocumentRow = {
  readonly id: string;
  readonly title: string;
  readonly kind: ArtifactKind;
  readonly version: number;
  readonly updatedAt: string;
};

type Scope = "chat" | "workspace";

/** This chat's artifacts, or the workspace's — `/api/artifacts`. A failed read throws, keeping what was shown. */
export const readDocuments = async (scope: Scope, conversationId: string): Promise<DocumentRow[]> => {
  const query = scope === "workspace" ? "scope=workspace" : `conversationId=${encodeURIComponent(conversationId)}`;
  const response = await fetch(`/api/artifacts?${query}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`artifacts ${response.status}`);
  const body = (await response.json()) as { items?: DocumentRow[] };
  return (body.items ?? []).map((row) => ({ ...row, kind: isArtifactKind(row.kind) ? row.kind : "markdown" }));
};

/**
 * The chat's documents, decks and diagrams — #628. The side panel listed the chat's posts, its media, its
 * project and the calendar, and nothing the assistant wrote as an artifact: finding last week's deck meant
 * scrolling the chat for its card. Newest first, with kind, title, version and when it last changed;
 * clicking one opens the artifact panel. "All in this workspace" lists every chat's.
 *
 * Cached per chat and re-read in the background — when it opens, when `create_artifact`, `update_artifact`
 * or `generate_pdf` returns, on window focus.
 */
export function DocumentsPane({
  conversationId,
  openArtifactId,
  onOpen,
  onClose,
}: {
  conversationId: string;
  openArtifactId: string | null;
  onOpen: (artifactId: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("assistant");
  const locale = useLocale();
  const [scope, setScope] = useState<Scope>("chat");
  const read = useCallback(() => readDocuments(scope, conversationId), [scope, conversationId]);
  const { data, loading } = usePaneData(paneKey("documents", scope === "workspace" ? "workspace" : conversationId), read);
  const documents = data ?? [];
  const when = (iso: string) =>
    new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

  return (
    <section className={styles.pane} aria-label={t("panes.documents")}>
      <header className={styles.head}>
        <span className={styles.headTitle}>{t("panes.documents")}</span>
        {documents.length > 0 && <span className={styles.count}>{documents.length}</span>}
        <span className={styles.grow} />
        <button type="button" className={styles.iconBtn} onClick={onClose} aria-label={t("panes.close")}>
          <svg className={styles.ic} viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      <div className={styles.body}>
        <div className={styles.actions} role="group" aria-label={t("panes.documentsScope")}>
          {(["chat", "workspace"] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`${styles.pill} ${scope === option ? styles.pillOn : ""}`}
              aria-pressed={scope === option}
              onClick={() => setScope(option)}
            >
              {t(option === "chat" ? "panes.documentsChat" : "panes.documentsWorkspace")}
            </button>
          ))}
        </div>
        {documents.length === 0 ? (
          <p className={styles.empty}>
            {loading ? t("panes.loading") : t(scope === "chat" ? "panes.documentsEmpty" : "panes.documentsEmptyWorkspace")}
          </p>
        ) : (
          documents.map((doc) => (
            <button
              key={doc.id}
              type="button"
              className={`${styles.card} ${styles.docRow} ${doc.id === openArtifactId ? styles.cardOn : ""}`}
              onClick={() => onOpen(doc.id)}
            >
              <span className={styles.cardHead}>
                <span className={styles.docIcon} aria-hidden="true">
                  {ARTIFACT_ICON[doc.kind]}
                </span>
                <span className={styles.cardTitle}>{doc.title}</span>
              </span>
              <span className={styles.meta}>
                {t("panes.documentMeta", { kind: t(ARTIFACT_KIND_KEY[doc.kind]), version: doc.version, when: when(doc.updatedAt) })}
              </span>
            </button>
          ))
        )}
      </div>
    </section>
  );
}
