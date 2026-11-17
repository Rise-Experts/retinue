"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { renderProjectTemplate, type ProjectAssetRow } from "@/lib/projects/client";
import type { TemplateId as Template } from "@/lib/projects/templates";
import styles from "../assistant.module.css";

const TEMPLATES: readonly { id: Template; label: string; text: string; rows: number }[] = [
  { id: "quote", label: "templateQuote", text: "templateTextQuote", rows: 3 },
  { id: "carousel", label: "templateCarousel", text: "templateTextCarousel", rows: 6 },
  { id: "frame", label: "templateFrame", text: "templateTextFrame", rows: 3 },
  { id: "announcement", label: "templateAnnouncement", text: "templateTextAnnouncement", rows: 4 },
  { id: "event", label: "templateEvent", text: "templateTextEvent", rows: 3 },
  { id: "tip", label: "templateTip", text: "templateTextTip", rows: 6 },
  { id: "stat", label: "templateStat", text: "templateTextStat", rows: 3 },
  { id: "testimonial", label: "templateTestimonial", text: "templateTextTestimonial", rows: 4 },
];

/**
 * Post templates — #525 part 2, more layouts in #595: a quote card, carousel slides, a branded frame, an
 * announcement, an event, a tip list, a big stat or a testimonial drawn from text in the project's theme
 * and saved to its files. Editing is rendering again with different text; the chat's render_post_template
 * does the same and attaches the result to a draft.
 */
export function ProjectTemplates({
  projectId,
  images,
  canEdit,
  onRendered,
}: {
  projectId: string;
  images: readonly ProjectAssetRow[];
  canEdit: boolean;
  onRendered: () => void;
}) {
  const t = useTranslations("assistant.projects");
  const [template, setTemplate] = useState<Template>("quote");
  const [text, setText] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!canEdit) return null;
  const current = TEMPLATES.find((x) => x.id === template)!;
  const ready = template === "frame" ? image !== null : text.trim() !== "";

  const render = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const assets = await renderProjectTemplate(projectId, { template, text, ...(template === "frame" && image !== null ? { imageAssetId: image } : {}) });
      setDone(assets.length);
      onRendered();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.projectField}>
      <span className={styles.threadListLabel}>{t("templates")}</span>
      <span className={styles.threadEmpty}>{t("templatesHint")}</span>
      <div className={styles.projectActions} role="radiogroup" aria-label={t("templates")}>
        {TEMPLATES.map((x) => (
          <button
            key={x.id}
            type="button"
            role="radio"
            aria-checked={template === x.id}
            className={template === x.id ? `${styles.projectsAdd} ${styles.threadItemActive}` : styles.projectsAdd}
            onClick={() => { setTemplate(x.id); setDone(null); }}
          >
            {t(x.label)}
          </button>
        ))}
      </div>
      <textarea
        className={styles.projectInstructions}
        value={text}
        onChange={(e) => { setText(e.target.value); setDone(null); }}
        placeholder={t(current.text)}
        aria-label={t(current.text)}
        rows={current.rows}
      />
      {template === "frame" && (
        images.length === 0 ? (
          <span className={styles.threadEmpty}>{t("templateNoImages")}</span>
        ) : (
          <div className={styles.projectAssetGrid} role="radiogroup" aria-label={t("templateImage")}>
            {images.map((img) => (
              <button
                key={img.id}
                type="button"
                role="radio"
                aria-checked={image === img.id}
                className={image === img.id ? `${styles.projectAsset} ${styles.threadItemActive}` : styles.projectAsset}
                onClick={() => { setImage(img.id); setDone(null); }}
              >
                {img.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed storage URL
                  <img className={styles.projectAssetThumb} src={img.previewUrl} alt="" />
                ) : null}
                <span className={styles.threadTitle}>{img.label || t("assetKind.image")}</span>
              </button>
            ))}
          </div>
        )
      )}
      <div className={styles.projectActions}>
        <button type="button" className={styles.newChat} onClick={() => void render()} disabled={!ready || busy}>
          {busy ? t("rendering") : t("renderTemplate")}
        </button>
        {done !== null && <span className={styles.threadEmpty} role="status">{t("rendered", { count: done })}</span>}
        {error !== null && <span className={styles.errorText} role="alert">{error}</span>}
      </div>
    </div>
  );
}
