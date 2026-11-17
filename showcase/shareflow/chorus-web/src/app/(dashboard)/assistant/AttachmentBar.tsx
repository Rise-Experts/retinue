/**
 * The row of attachment chips above the assistant composer.
 *
 * Images get a thumbnail; a video or PDF gets a labelled chip, since neither
 * previews usefully at this size. `next/image` is deliberately not used — these
 * are `blob:` object URLs, which its loader cannot handle.
 */

"use client";

import { useTranslations } from "next-intl";
import type { Attachment } from "./useAttachments";
import styles from "./assistant.module.css";

export default function AttachmentBar({
  attachments,
  onRemove,
}: {
  attachments: Attachment[];
  onRemove: (path: string) => void;
}) {
  const t = useTranslations("assistant");
  if (attachments.length === 0) return null;

  return (
    <div className={styles.attachBar} aria-label={t("attachments")}>
      {attachments.map((item) => (
        <div
          key={item.path}
          className={`${styles.attachChip} ${item.uploading ? styles.attachChipUploading : ""}`.trim()}
          title={item.name}
        >
          {item.previewUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element -- blob: object URL, see file header */
            <img className={styles.attachThumb} src={item.previewUrl} alt={item.name} />
          ) : (
            <span className={styles.attachKind}>
              {item.kind === "document" ? "PDF" : item.kind === "video" ? "VIDEO" : "FILE"}
            </span>
          )}
          <span className={styles.attachName}>{item.name}</span>
          {item.uploading ? (
            <span className={styles.attachSpinner} aria-label={t("attachUploading")} />
          ) : (
            <button
              type="button"
              className={styles.attachRemove}
              onClick={() => onRemove(item.path)}
              aria-label={t("attachRemove")}
              title={t("attachRemove")}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
