"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/utils/supabase/client";
import { MEDIA_BUCKET, mediaKindOf, validateMediaFile } from "@/lib/media";
import { addProjectAsset, removeProjectAsset, type ProjectAssetRow } from "@/lib/projects/client";
import styles from "../assistant.module.css";

/**
 * A project's files and links — #523. Uploaded once here, then attached to any post in the project's
 * chats without uploading again (`attach_project_asset`). Files go to the media bucket under the
 * workspace's own folder, the rule the bucket's policy enforces; removing one here unlinks it from the
 * project and leaves the file in storage.
 */
export function ProjectAssets({
  projectId,
  workspaceId,
  assets,
  canEdit,
  onChanged,
}: {
  projectId: string;
  workspaceId: string | null;
  assets: readonly ProjectAssetRow[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const t = useTranslations("assistant.projects");
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkLabel, setLinkLabel] = useState("");

  const upload = async (files: FileList | null) => {
    if (files === null || files.length === 0 || workspaceId === null) return;
    setBusy(true);
    setError(null);
    const supabase = createClient();
    try {
      for (const file of Array.from(files)) {
        const violation = validateMediaFile(file);
        if (violation !== null) {
          setError(violation === "too_large" ? t("assetTooLarge") : t("assetBadType"));
          continue;
        }
        const ext = (file.name.split(".").pop() ?? file.type.split("/").pop() ?? "bin").toLowerCase();
        const path = `${workspaceId}/projects/${projectId}/${crypto.randomUUID()}.${ext}`;
        const { error: uploadError } = await supabase.storage.from(MEDIA_BUCKET).upload(path, file, { contentType: file.type });
        if (uploadError) {
          setError(uploadError.message || t("assetUploadFailed"));
          continue;
        }
        const kind = mediaKindOf(path);
        await addProjectAsset(projectId, { kind, storagePath: path, label: file.name.slice(0, 200) });
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("assetUploadFailed"));
    } finally {
      setBusy(false);
    }
  };

  const addLink = async () => {
    if (linkUrl.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      await addProjectAsset(projectId, { kind: "link", url: linkUrl.trim(), label: linkLabel.trim() });
      setLinkUrl("");
      setLinkLabel("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("assetUploadFailed"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (assetId: string) => {
    setError(null);
    try {
      await removeProjectAsset(projectId, assetId);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("saveFailed"));
    }
  };

  return (
    <div className={styles.projectField}>
      <span className={styles.threadListLabel}>{t("assets")}</span>
      <span className={styles.threadEmpty}>{t("assetsHint")}</span>
      {assets.length === 0 && <span className={styles.threadEmpty}>{t("noAssets")}</span>}
      <div className={styles.projectAssetGrid}>
        {assets.map((asset) => (
          <div key={asset.id} className={styles.projectAsset}>
            {asset.kind === "image" && asset.previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed storage URL, not an optimisable asset
              <img className={styles.projectAssetThumb} src={asset.previewUrl} alt="" />
            ) : asset.kind === "link" && asset.url ? (
              <a className={styles.projectAssetLink} href={asset.url} target="_blank" rel="noreferrer">
                {asset.url.replace(/^https?:\/\//, "").slice(0, 40)}
              </a>
            ) : (
              <span className={styles.projectAssetKind}>{t(`assetKind.${asset.kind}`)}</span>
            )}
            <span className={styles.threadTitle}>{asset.label || t(`assetKind.${asset.kind}`)}</span>
            {canEdit && (
              <button type="button" className={styles.projectsAdd} onClick={() => void remove(asset.id)} aria-label={t("removeAsset", { label: asset.label || asset.kind })}>
                ×
              </button>
            )}
          </div>
        ))}
      </div>
      {canEdit && (
        <div className={styles.projectActions}>
          <button type="button" className={styles.projectsAdd} onClick={() => fileRef.current?.click()} disabled={busy || workspaceId === null}>
            {busy ? t("saving") : t("uploadAsset")}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*,video/*,application/pdf"
            multiple
            hidden
            onChange={(e) => {
              void upload(e.target.files);
              e.target.value = "";
            }}
          />
          <input className={styles.threadFilter} value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://…" aria-label={t("linkUrl")} />
          <input className={styles.threadFilter} value={linkLabel} onChange={(e) => setLinkLabel(e.target.value)} placeholder={t("linkLabel")} aria-label={t("linkLabel")} />
          <button type="button" className={styles.projectsAdd} onClick={() => void addLink()} disabled={busy || linkUrl.trim() === ""}>
            {t("addLink")}
          </button>
        </div>
      )}
      {error !== null && <span className={styles.errorText} role="alert">{error}</span>}
    </div>
  );
}
