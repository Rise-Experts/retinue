/**
 * Full-size viewer for an image, PDF or video the assistant surfaced.
 *
 * Opened by clicking an inline reference or a gallery tile. Deliberately a real
 * modal — dismissible by Escape, by the close button, or by clicking the backdrop
 * — rather than the hover preview, which cannot be dismissed and so must never be
 * the only way to see something.
 */

"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import styles from "./messages.module.css";

/** What the viewer draws, from the file's extension — the query string of a signed URL is ignored. */
export const mediaViewKind = (url: string): "pdf" | "video" | "image" => {
  const path = url.split(/[?#]/)[0]?.toLowerCase() ?? "";
  if (path.endsWith(".pdf")) return "pdf";
  if (/\.(mp4|webm|mov|m4v)$/.test(path)) return "video";
  return "image";
};

export default function MediaModal({
  url,
  label,
  onClose,
}: {
  url: string;
  label: string;
  onClose: () => void;
}) {
  const t = useTranslations("assistant");

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    // The chat pane scrolls; locking the body avoids scrolling the conversation
    // behind an open viewer.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div
      className={styles.modalBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label={label || t("mediaPreview")}
      onClick={onClose}
    >
      {/* Stops a click on the image itself from dismissing. */}
      <div className={styles.modalBody} onClick={(e) => e.stopPropagation()}>
        {/* Production, 2026-09-28: a generated PDF opened here as a broken image — an <img> cannot draw one. */}
        {mediaViewKind(url) === "pdf" ? (
          <iframe className={styles.modalPdf} src={url} title={label || t("mediaPreview")} referrerPolicy="no-referrer" />
        ) : mediaViewKind(url) === "video" ? (
          <video className={styles.modalImage} src={url} controls playsInline aria-label={label} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- arbitrary external host
          <img className={styles.modalImage} src={url} alt={label} referrerPolicy="no-referrer" />
        )}
        <div className={styles.modalFooter}>
          <span className={styles.modalLabel}>{label}</span>
          <a
            className={styles.modalOpen}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("openOriginal")}
          </a>
        </div>
        <button
          type="button"
          className={styles.modalClose}
          onClick={onClose}
          aria-label={t("close")}
          title={t("close")}
        >
          ×
        </button>
      </div>
    </div>
  );
}
