"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { updateProject, type ProjectAssetRow } from "@/lib/projects/client";
import styles from "../assistant.module.css";

export type AvatarValue = { name?: string; persona?: string; look?: string; referenceAssetIds?: string[] };

/**
 * A project's AI avatar — #524: a name, a persona (the voice captions are written in), a look (how it
 * appears in images and video) and reference photos chosen from the project's own images. Every chat in
 * the project uses it; generate_media adds the look to each image or video prompt.
 */
export function ProjectAvatar({
  projectId,
  avatar,
  images,
  canEdit,
  onSaved,
}: {
  projectId: string;
  avatar: AvatarValue;
  images: readonly ProjectAssetRow[];
  canEdit: boolean;
  onSaved: () => void;
}) {
  const t = useTranslations("assistant.projects");
  const [name, setName] = useState(avatar.name ?? "");
  const [persona, setPersona] = useState(avatar.persona ?? "");
  const [look, setLook] = useState(avatar.look ?? "");
  const [refs, setRefs] = useState<readonly string[]>(avatar.referenceAssetIds ?? []);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    name !== (avatar.name ?? "") ||
    persona !== (avatar.persona ?? "") ||
    look !== (avatar.look ?? "") ||
    refs.join() !== (avatar.referenceAssetIds ?? []).join();

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateProject(projectId, {
        avatar: {
          ...(name.trim() === "" ? {} : { name: name.trim() }),
          ...(persona.trim() === "" ? {} : { persona: persona.trim() }),
          ...(look.trim() === "" ? {} : { look: look.trim() }),
          ...(refs.length === 0 ? {} : { referenceAssetIds: [...refs] }),
        },
      });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (id: string) => setRefs((current) => (current.includes(id) ? current.filter((r) => r !== id) : current.length >= 8 ? current : [...current, id]));

  return (
    <div className={styles.projectField}>
      <span className={styles.threadListLabel}>{t("avatar")}</span>
      <span className={styles.threadEmpty}>{t("avatarHint")}</span>
      <input className={styles.threadFilter} value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} readOnly={!canEdit} placeholder={t("avatarNamePlaceholder")} aria-label={t("avatarName")} maxLength={80} />
      <textarea className={styles.projectInstructions} value={persona} onChange={(e) => { setPersona(e.target.value); setSaved(false); }} readOnly={!canEdit} placeholder={t("avatarPersonaPlaceholder")} aria-label={t("avatarPersona")} maxLength={2000} rows={3} />
      <textarea className={styles.projectInstructions} value={look} onChange={(e) => { setLook(e.target.value); setSaved(false); }} readOnly={!canEdit} placeholder={t("avatarLookPlaceholder")} aria-label={t("avatarLook")} maxLength={2000} rows={3} />
      <span className={styles.threadEmpty}>{images.length === 0 ? t("avatarNoImages") : t("avatarPick")}</span>
      {images.length > 0 && (
        <div className={styles.projectAssetGrid}>
          {images.map((image) => {
            const chosen = refs.includes(image.id);
            return (
              <button
                key={image.id}
                type="button"
                className={chosen ? `${styles.projectAsset} ${styles.threadItemActive}` : styles.projectAsset}
                aria-pressed={chosen}
                disabled={!canEdit}
                onClick={() => { toggle(image.id); setSaved(false); }}
              >
                {image.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed storage URL
                  <img className={styles.projectAssetThumb} src={image.previewUrl} alt="" />
                ) : null}
                <span className={styles.threadTitle}>{image.label || t("assetKind.image")}</span>
              </button>
            );
          })}
        </div>
      )}
      {canEdit && (
        <div className={styles.projectActions}>
          <button type="button" className={styles.newChat} onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? t("saving") : t("saveAvatar")}
          </button>
          {saved && !dirty && <span className={styles.threadEmpty} role="status">{t("saved")}</span>}
          {error !== null && <span className={styles.errorText} role="alert">{error}</span>}
        </div>
      )}
    </div>
  );
}
