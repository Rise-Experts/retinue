/**
 * Media attachments for the assistant composer.
 *
 * Uploads to the same `media` bucket, path convention and validation the
 * compose screen uses (`{workspace_id}/{uuid}.{ext}`, `validateMediaFile`,
 * `MEDIA_MAX_FILES`), so a file attached in chat behaves identically to one
 * attached in compose — including being publishable by the worker without any
 * extra handling.
 *
 * Only the storage PATHS leave this hook. Signing happens later (the worker for
 * publishing, `/api/internal/media-url` for the assistant reading a PDF), and
 * the paths are re-validated against the workspace server-side before the agent
 * sees them — see lib/assistant/attachments.ts.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/utils/supabase/client";
import { useApp } from "@/lib/store";
import {
  MEDIA_BUCKET,
  MEDIA_MAX_FILES,
  validateMediaFile,
  mediaKindOf,
  type MediaKind,
} from "@/lib/media";

export interface Attachment {
  /** Storage path — the only thing sent to the server. */
  path: string;
  name: string;
  kind: MediaKind;
  /** Object URL for an image thumbnail; revoked on removal/unmount. */
  previewUrl: string | null;
  uploading: boolean;
}

/** `image/png` -> `png`, falling back to the filename's own extension. */
function extensionFor(file: File): string {
  const fromName = file.name.includes(".") ? file.name.split(".").pop() : "";
  if (fromName) return fromName.toLowerCase();
  const fromType = file.type.split("/").pop();
  return (fromType || "bin").toLowerCase();
}

export function useAttachments() {
  const t = useTranslations("assistant");
  const { context, showToast } = useApp();
  const workspaceId = context?.workspace?.id ?? null;

  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Mirrors state so the per-file cap check inside the upload loop sees the true
  // latest count rather than a snapshot captured at render — same reason the
  // compose screen keeps a ref.
  const listRef = useRef<Attachment[]>([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    listRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Object URLs outlive the component unless explicitly revoked.
      for (const item of listRef.current) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
    };
  }, []);

  const remove = useCallback((path: string) => {
    setAttachments((prev) => {
      const target = prev.find((item) => item.path === path);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((item) => item.path !== path);
    });
  }, []);

  const clear = useCallback(() => {
    setAttachments((prev) => {
      for (const item of prev) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
      return [];
    });
  }, []);

  const addFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList?.length) return;
      if (!workspaceId) {
        showToast(t("attachNoWorkspace"));
        return;
      }

      const files = Array.from(fileList);
      if (listRef.current.length + files.length > MEDIA_MAX_FILES) {
        showToast(t("attachMaxFiles", { max: MEDIA_MAX_FILES }));
        return;
      }

      const supabase = createClient();
      let capToasted = false;

      for (const file of files) {
        if (listRef.current.length >= MEDIA_MAX_FILES) {
          if (!capToasted) {
            capToasted = true;
            showToast(t("attachMaxFiles", { max: MEDIA_MAX_FILES }));
          }
          continue;
        }

        const violation = validateMediaFile({ size: file.size, type: file.type });
        if (violation === "too_large") {
          showToast(t("attachTooLarge"));
          continue;
        }
        if (violation === "bad_type") {
          showToast(t("attachBadType"));
          continue;
        }

        const path = `${workspaceId}/${crypto.randomUUID()}.${extensionFor(file)}`;
        const kind = mediaKindOf(path);
        const previewUrl = kind === "image" ? URL.createObjectURL(file) : null;

        const pending: Attachment = {
          path,
          name: file.name,
          kind,
          previewUrl,
          uploading: true,
        };
        setAttachments((prev) => [...prev, pending]);
        listRef.current = [...listRef.current, pending];

        const { error } = await supabase.storage
          .from(MEDIA_BUCKET)
          .upload(path, file, { contentType: file.type });

        if (!mountedRef.current) {
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          return;
        }

        // The user may have removed the chip while the upload was in flight; if
        // so its cleanup already ran, so don't resurrect or re-toast it.
        const stillPresent = listRef.current.some((item) => item.path === path);
        if (!stillPresent) continue;

        if (error) {
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          setAttachments((prev) => prev.filter((item) => item.path !== path));
          // Storage's own message, not just "upload failed".
          //
          // Size and type are already checked above with specific toasts, so
          // anything reaching here is a bucket-level refusal — an RLS policy, an
          // expired session, a bucket limit. The generic string made every one of
          // those look identical and left a reported failure with nothing to go on.
          // Matches how the remote-URL path below already surfaces `data.error`.
          console.error("[attachments] upload failed", { path, error });
          showToast(error.message || t("attachUploadFailed"));
          continue;
        }

        setAttachments((prev) =>
          prev.map((item) => (item.path === path ? { ...item, uploading: false } : item)),
        );
      }
    },
    [workspaceId, showToast, t],
  );

  /**
   * Attach a remote URL (an image the assistant surfaced from a page).
   *
   * Downloads via the app's own route rather than `fetch` in the browser: an
   * arbitrary host will not send CORS headers, so a direct client fetch fails for
   * most real images. The route also re-applies the SSRF and size guards.
   */
  const addRemote = useCallback(
    async (item: { url: string; label: string }) => {
      if (!workspaceId) {
        showToast(t("attachNoWorkspace"));
        return;
      }
      if (listRef.current.length >= MEDIA_MAX_FILES) {
        showToast(t("attachMaxFiles", { max: MEDIA_MAX_FILES }));
        return;
      }

      try {
        const res = await fetch("/api/media/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: item.url }),
        });
        const data = (await res.json().catch(() => null)) as
          | { path?: string; error?: string }
          | null;
        if (!res.ok || !data?.path) {
          showToast(data?.error || t("attachUploadFailed"));
          return;
        }
        const added: Attachment = {
          path: data.path,
          name: item.label || data.path.split("/").pop() || "file",
          kind: mediaKindOf(data.path),
          previewUrl: null,
          uploading: false,
        };
        setAttachments((prev) =>
          prev.some((a) => a.path === added.path) ? prev : [...prev, added],
        );
      } catch {
        showToast(t("attachUploadFailed"));
      }
    },
    [workspaceId, showToast, t],
  );

  return {
    attachments,
    addFiles,
    addRemote,
    remove,
    clear,
    /** Paths of fully-uploaded files — the only ones safe to send. */
    readyPaths: attachments.filter((a) => !a.uploading).map((a) => a.path),
    uploading: attachments.some((a) => a.uploading),
    canAddMore: attachments.length < MEDIA_MAX_FILES,
  };
}
