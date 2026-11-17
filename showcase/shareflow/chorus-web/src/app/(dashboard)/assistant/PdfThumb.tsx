"use client";

import { useEffect, useState, type ReactNode } from "react";
import { pdfKeyOf, pdfThumbnail, peekPdfThumbnail } from "@/lib/assistant/pdfThumbnail";

/**
 * A PDF's first page as a tile image — #628. Drawn in the browser by pdf.js (`lib/assistant/pdfThumbnail.ts`
 * says why), cached for the session under the file's storage path; `fallback` shows while it draws and if
 * the file cannot be drawn, so a tile keeps its footprint in every state.
 */
export function PdfThumb({
  url,
  cacheKey,
  className,
  fallback,
}: {
  /** A URL the browser can fetch — a signed storage URL. */
  url: string;
  /** The storage path, when known: a signed URL changes every hour, the path does not. */
  cacheKey?: string;
  className?: string;
  fallback: ReactNode;
}) {
  const key = cacheKey ?? pdfKeyOf(url);
  // Read during render, so a thumbnail drawn for another tile of the same file shows without a second render.
  const cached = peekPdfThumbnail(key);
  const [drawn, setDrawn] = useState<{ key: string; image: string | null } | null>(null);

  useEffect(() => {
    if (peekPdfThumbnail(key) !== undefined) return;
    let live = true;
    void pdfThumbnail(key, url).then((image) => {
      if (live) setDrawn({ key, image });
    });
    return () => {
      live = false;
    };
  }, [key, url]);

  const image = cached ?? (drawn !== null && drawn.key === key ? drawn.image : null);
  // eslint-disable-next-line @next/next/no-img-element -- a data URL drawn in the browser
  return image ? <img className={className} src={image} alt="" /> : <>{fallback}</>;
}
