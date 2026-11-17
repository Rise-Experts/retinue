"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { addProjectAsset, getProject, type ProjectAssetRow } from "@/lib/projects/client";
import type { TurnReference } from "@/lib/assistant/turnBlocks";
import { invalidatePanes, paneKey, usePaneData } from "@/lib/assistant/paneCache";
import MediaModal from "../MediaModal";
import { PdfThumb } from "../PdfThumb";
import { isPdfPath } from "@/lib/assistant/pdfThumbnail";
import styles from "./panes.module.css";

type Recent = {
  readonly id: string;
  readonly kind: "image" | "video" | "pdf";
  readonly previewUrl: string | null;
  /** A PDF's storage path — its thumbnail is cached under it. */
  readonly path?: string;
};

type MediaData = { readonly files: readonly ProjectAssetRow[]; readonly recent: readonly Recent[] };

/**
 * Both lists in one read, so the pane has one cached entry per project (#628). A failed read throws, which
 * keeps what the pane last showed rather than blanking it.
 */
const readMedia = async (projectId: string | null): Promise<MediaData> => {
  const [files, recent] = await Promise.all([
    projectId === null ? Promise.resolve([] as readonly ProjectAssetRow[]) : getProject(projectId).then((d) => d.assets),
    fetch("/api/media/recent", { cache: "no-store" }).then(async (r) => {
      if (!r.ok) throw new Error(`media/recent ${r.status}`);
      const body = (await r.json()) as { items?: Recent[] };
      return body.items ?? [];
    }),
  ]);
  return { files, recent };
};

/**
 * Media beside the chat — #546: the project's files (click to add one to the chat) and what was made
 * lately (save it to the project, which adds it to the chat too). Files attached in the chat box are on
 * the message itself; this is for the things you reuse.
 *
 * #628: cached per project and re-read in the background — when it opens, when a media tool result
 * arrives, while a media job runs, on window focus — and printed PDFs are listed with their first page,
 * opening in the viewer.
 */
export function MediaPane({
  project,
  references,
  onAddToChat,
  onClose,
}: {
  project: { readonly id: string; readonly name: string } | null;
  references: readonly TurnReference[];
  onAddToChat: (reference: TurnReference) => void;
  onClose: () => void;
}) {
  const t = useTranslations("assistant.panes");
  const [saving, setSaving] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ url: string; label: string } | null>(null);
  const projectId = project?.id ?? null;
  const read = useCallback(() => readMedia(projectId), [projectId]);
  const { data, loading } = usePaneData(paneKey("media", projectId ?? "none"), read);
  const files = data?.files ?? [];
  const recent = data?.recent ?? [];

  const inChat = new Set(references.map((r) => r.id));
  // #628: a project's PDFs too, shown by their first page.
  const images = files.filter((f) => f.kind === "image" || f.kind === "video" || (f.previewUrl !== null && isPdfPath(f.previewUrl)));

  const saveToProject = async (item: Recent) => {
    if (project === null) return;
    setSaving(item.id);
    try {
      const created = (await addProjectAsset(project.id, { kind: item.kind, generatedAssetId: item.id, label: t("madeInChat") })) as { asset?: { id?: string } };
      if (created.asset?.id) onAddToChat({ kind: "project_asset", id: created.asset.id, label: t("madeInChat") });
      invalidatePanes(["media", "project"]);
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className={styles.pane} aria-label={t("media")}>
      <header className={styles.head}>
        <span className={styles.headTitle}>{t("media")}</span>
        <span className={styles.grow} />
        <button type="button" className={styles.iconBtn} onClick={onClose} aria-label={t("close")}>
          <svg className={styles.ic} viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      <div className={styles.body}>
        {project !== null && (
          <div className={styles.section}>
            <span className={styles.label}>{t("projectFiles", { name: project.name })}</span>
            {images.length === 0 ? (
              <p className={styles.empty}>{t("projectFilesEmpty")}</p>
            ) : (
              <div className={styles.grid}>
                {images.map((file) => (
                  <button
                    key={file.id}
                    type="button"
                    className={styles.thumb}
                    aria-pressed={inChat.has(file.id)}
                    aria-label={t("addFileToChat", { name: file.label || file.kind })}
                    onClick={() => onAddToChat({ kind: "project_asset", id: file.id, label: file.label || file.kind })}
                  >
                    {file.previewUrl && isPdfPath(file.previewUrl) ? (
                      <PdfThumb url={file.previewUrl} cacheKey={`project-asset:${file.id}`} className={styles.thumbPage} fallback={null} />
                    ) : file.previewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed storage URL
                      <img src={file.previewUrl} alt="" />
                    ) : null}
                    <span className={styles.thumbLabel}>{inChat.has(file.id) ? t("inChat") : file.label || file.kind}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className={styles.section}>
          <span className={styles.label}>{t("recent")}</span>
          {recent.length === 0 ? (
            <p className={styles.empty}>{loading ? t("loading") : t("recentEmpty")}</p>
          ) : (
            <div className={styles.grid}>
              {recent.map((item) =>
                item.kind === "pdf" ? (
                  // #628: a printed PDF — its first page, opening in the viewer. Not savable: it has no asset row.
                  <button
                    key={item.id}
                    type="button"
                    className={styles.thumb}
                    disabled={item.previewUrl === null}
                    aria-label={t("openPdf")}
                    title={t("openPdf")}
                    onClick={() => item.previewUrl !== null && setViewing({ url: item.previewUrl, label: t("pdf") })}
                  >
                    {item.previewUrl === null ? null : (
                      <PdfThumb url={item.previewUrl} cacheKey={item.path} className={styles.thumbPage} fallback={null} />
                    )}
                    <span className={styles.thumbLabel}>{t("pdf")}</span>
                  </button>
                ) : (
                <button
                  key={item.id}
                  type="button"
                  className={styles.thumb}
                  disabled={project === null || saving === item.id}
                  aria-label={project === null ? t("recentNoProject") : t("saveToProject")}
                  title={project === null ? t("recentNoProject") : t("saveToProject")}
                  onClick={() => void saveToProject(item)}
                >
                  {item.previewUrl === null ? (
                    <span className={styles.thumbLabel}>{t(item.kind === "video" ? "video" : "image")}</span>
                  ) : item.kind === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed storage URL
                    <img src={item.previewUrl} alt="" />
                  ) : (
                    <>
                      {/* The first frame as the tile: a bare "Video" label left most of the grid blank (#557). */}
                      <video src={`${item.previewUrl}#t=0.1`} muted playsInline preload="metadata" aria-hidden="true" />
                      <span className={styles.thumbLabel}>{t("video")}</span>
                    </>
                  )}
                </button>
                ),
              )}
            </div>
          )}
        </div>
      </div>
      {viewing !== null && <MediaModal url={viewing.url} label={viewing.label} onClose={() => setViewing(null)} />}
    </section>
  );
}
