/**
 * Gallery of every image and link a reply referenced, shown beneath its text.
 *
 * Inline media made replies unreadable — a page read can carry a dozen images,
 * and rendering them in the prose pushed the actual answer off screen. Inline
 * references are now clickable text; the media itself lives here, at a FIXED tile
 * size so no amount of it can change the message's layout.
 */

"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { hostOf, type MessageMediaItem } from "@/lib/assistant/messageMedia";
import { fileNameOfRef } from "@/lib/assistant/mediaRef";
import { useSignedMedia } from "./useSignedMedia";
import { PdfThumb } from "./PdfThumb";
import { isPdfPath } from "@/lib/assistant/pdfThumbnail";
import styles from "./messages.module.css";

/**
 * A tile for a workspace file (`chorus-media:`), which must be signed for this
 * session before it can be shown.
 *
 * Its own component because the signing hook cannot be called inside the `items`
 * loop — hooks may not run conditionally, and only some items are workspace
 * files. Rendering one component per tile keeps the hook order stable.
 *
 * While signing, and if signing fails, the tile shows the filename. That is the
 * specified fallback (AC-5) and it keeps the tile's footprint identical in every
 * state, so the gallery never reflows as files resolve.
 */
function WorkspaceTile({
  item,
  onAttach,
  onOpen,
}: {
  item: MessageMediaItem & { path: string };
  onAttach?: (entry: { url: string; label: string }) => void;
  onOpen: (entry: { url: string; label: string }) => void;
}) {
  const t = useTranslations("assistant");
  const { media, failed } = useSignedMedia(item.path);
  const [broken, setBroken] = useState(false);
  const label = item.label || fileNameOfRef(item.path);

  if (!media || failed) {
    return (
      <div className={styles.galleryTile}>
        <span className={styles.galleryLinkTile} title={label}>
          <span className={styles.galleryLinkHost}>{failed ? t("mediaUnavailable") : "\u2026"}</span>
          <span className={styles.galleryLinkLabel}>{label}</span>
        </span>
      </div>
    );
  }

  const showImage = media.kind === "image" && !broken;
  // #628: a PDF shows its first page and opens in the viewer, rather than a bare link tile.
  const showPdf = media.kind === "document" && isPdfPath(item.path);

  return (
    <div className={styles.galleryTile}>
      {showPdf ? (
        <button
          type="button"
          className={styles.galleryThumbButton}
          onClick={() => onOpen({ url: media.url, label })}
          title={label}
          aria-label={label}
        >
          <PdfThumb
            url={media.url}
            cacheKey={item.path}
            className={`${styles.galleryThumb} ${styles.galleryPdfPage}`}
            fallback={
              <span className={styles.galleryLinkTile}>
                <span className={styles.galleryLinkHost}>{t("pdfLabel")}</span>
                <span className={styles.galleryLinkLabel}>{label}</span>
              </span>
            }
          />
          <span className={styles.galleryPdfBadge} aria-hidden="true">{t("pdfLabel")}</span>
        </button>
      ) : showImage ? (
        <button
          type="button"
          className={styles.galleryThumbButton}
          onClick={() => onOpen({ url: media.url, label })}
          title={label}
          aria-label={label}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- signed Supabase URL, not enumerable in remotePatterns */}
          <img
            className={styles.galleryThumb}
            src={media.url}
            alt={label}
            loading="lazy"
            onError={() => setBroken(true)}
          />
        </button>
      ) : (
        <a
          className={styles.galleryLinkTile}
          href={media.url}
          target="_blank"
          rel="noopener noreferrer"
          title={label}
        >
          <span className={styles.galleryLinkHost}>{media.kind}</span>
          <span className={styles.galleryLinkLabel}>{label}</span>
        </a>
      )}

      {onAttach && (
        <button
          type="button"
          className={styles.galleryAttach}
          onClick={() => onAttach({ url: media.url, label })}
          aria-label={t("attachThis")}
          title={t("attachThis")}
        >
          +
        </button>
      )}
    </div>
  );
}

export default function MessageGallery({
  items,
  onAttach,
  onOpen,
}: {
  items: MessageMediaItem[];
  onAttach?: (item: { url: string; label: string }) => void;
  onOpen: (item: { url: string; label: string }) => void;
}) {
  const t = useTranslations("assistant");
  const [broken, setBroken] = useState<Record<string, boolean>>({});
  if (items.length === 0) return null;

  return (
    <div className={styles.gallery} aria-label={t("gallery")}>
      {items.map((item) => {
        // Workspace files take the signing path; external URLs render directly.
        if (item.path) {
          return (
            <WorkspaceTile
              key={item.url}
              item={item as MessageMediaItem & { path: string }}
              onAttach={onAttach}
              onOpen={onOpen}
            />
          );
        }

        const isImage = item.kind === "image" && !broken[item.url];
        return (
          <div key={item.url} className={styles.galleryTile}>
            {isImage ? (
              <button
                type="button"
                className={styles.galleryThumbButton}
                onClick={() => onOpen(item)}
                title={item.label}
                aria-label={item.label}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary external host */}
                <img
                  className={styles.galleryThumb}
                  src={item.url}
                  alt={item.label}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  onError={() => setBroken((prev) => ({ ...prev, [item.url]: true }))}
                />
              </button>
            ) : (
              <a
                className={styles.galleryLinkTile}
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                title={item.url}
              >
                <span className={styles.galleryLinkHost}>{hostOf(item.url)}</span>
                <span className={styles.galleryLinkLabel}>{item.label}</span>
              </a>
            )}

            {onAttach && (
              <button
                type="button"
                className={styles.galleryAttach}
                onClick={() => onAttach(item)}
                aria-label={t("attachThis")}
                title={t("attachThis")}
              >
                +
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
