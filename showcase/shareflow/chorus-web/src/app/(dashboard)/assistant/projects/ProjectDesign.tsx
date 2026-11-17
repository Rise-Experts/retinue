"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { updateProject, type ProjectAssetRow } from "@/lib/projects/client";
import { FACEBOOK_BACKGROUNDS } from "@/lib/facebook-backgrounds";
import {
  CURATED_FONT_NAMES, LOGO_PLACEMENTS, MOOD_MAX, PALETTE_ROLES, PICTURE_STYLE_IDS, RADIUS_MAX, THEME_IDS, THEME_PRESETS,
  fontStack, resolveTheme, type CuratedFont, type PaletteRole,
} from "@/lib/projects/theme";
import { applyPreset, buildKitDesign, initialKit, type DesignValue, type KitState } from "@/lib/projects/kitDesign";
import { KitPreviews, PresetMini } from "./KitPreviews";
import styles from "../assistant.module.css";
import kit from "./kitEditor.module.css";

export type { DesignValue };

/** The shapes the channels take; the first one picked is what generate_media uses when none is asked for. */
const RATIOS = ["4:5", "1:1", "9:16", "16:9", "3:4", "3:2"] as const;

/** The six presets, each resolved once for its gallery card. */
const PRESET_THEMES = THEME_IDS.map((id) => resolveTheme({ themeId: id }));

/**
 * A project's style kit — #525, redesigned as a visual theme editor in #595: pick a preset from a gallery,
 * then adjust its colours by role, its heading and body fonts, its corner radius, its picture look and its
 * logo corner, and see the result live on a post image, a carousel slide, a document page, a code snippet
 * and a diagram. Preferred shapes and the Facebook background stay as they were.
 *
 * What a save writes is decided in `lib/projects/kitDesign.ts` (pure, tested): the theme keys, the legacy
 * `colors`/`fonts` rewritten to agree, and every key this editor does not show carried over.
 */
export function ProjectDesign({
  projectId,
  design,
  images,
  canEdit,
  onSaved,
}: {
  projectId: string;
  design: DesignValue;
  images: readonly ProjectAssetRow[];
  canEdit: boolean;
  onSaved: () => void;
}) {
  const t = useTranslations("assistant.projects");
  const [state, setState] = useState<KitState>(() => initialKit(design));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = useMemo(() => buildKitDesign(design, state), [design, state]);
  const theme = useMemo(() => resolveTheme(next), [next]);
  const base = THEME_PRESETS[state.themeId ?? "minimal"];

  const change = (patch: Partial<KitState> | ((s: KitState) => KitState)) => {
    setState((s) => (typeof patch === "function" ? patch(s) : { ...s, ...patch }));
    setDirty(true);
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateProject(projectId, { design: next });
      setSaved(true);
      setDirty(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const setRole = (role: PaletteRole, hex: string) => change((s) => ({ ...s, overrides: { ...s.overrides, [role]: hex.toLowerCase() } }));
  const resetRole = (role: PaletteRole) =>
    change((s) => {
      const { [role]: _dropped, ...rest } = s.overrides;
      return { ...s, overrides: rest };
    });
  const toggleRatio = (ratio: string) =>
    change((s) => ({ ...s, ratios: s.ratios.includes(ratio) ? s.ratios.filter((r) => r !== ratio) : [...s.ratios, ratio] }));

  const logoUrl = state.logo === null ? null : images.find((i) => i.id === state.logo)?.previewUrl ?? null;
  const textAdjusted = state.overrides.text !== undefined && state.overrides.text !== theme.palette.text;
  const chip = (on: boolean) => (on ? `${kit.chip} ${kit.chipOn}` : kit.chip);

  const fontSelect = (which: "headingFont" | "bodyFont") => {
    const current = state[which];
    const resolved = which === "headingFont" ? theme.fonts.heading : theme.fonts.body;
    const id = `kit-${which}-${projectId}`;
    return (
      <div className={kit.field}>
        <label className={kit.fieldLabel} htmlFor={id}>{t(which === "headingFont" ? "kit.headingFont" : "kit.bodyFont")}</label>
        <select
          id={id}
          className={kit.select}
          value={current ?? ""}
          disabled={!canEdit}
          style={{ fontFamily: fontStack(resolved) }}
          onChange={(e) => change({ [which]: e.target.value === "" ? null : (e.target.value as CuratedFont) })}
        >
          <option value="">{t("kit.fontDefault", { font: which === "headingFont" ? base.fonts.heading : base.fonts.body })}</option>
          {CURATED_FONT_NAMES.map((font) => (
            // Browsers that style options show each in its own face; the rest show the name, and the sample below.
            <option key={font} value={font} style={{ fontFamily: fontStack(font) }}>
              {font}
            </option>
          ))}
        </select>
        <span className={kit.fontSample} style={{ fontFamily: fontStack(resolved), fontWeight: which === "headingFont" ? 700 : 400 }}>
          {t(which === "headingFont" ? "kit.headingSample" : "kit.bodySample")}
        </span>
      </div>
    );
  };

  return (
    <div className={`${styles.projectField} ${kit.wrap}`}>
      <span className={styles.threadListLabel}>{t("design")}</span>
      <span className={styles.threadEmpty}>{t("designHint")}</span>

      <div className={kit.kit}>
        <div className={kit.controls}>
          {/* (a) the preset gallery */}
          <section className={kit.section} aria-labelledby={`kit-presets-${projectId}`}>
            <span className={kit.fieldLabel} id={`kit-presets-${projectId}`}>{t("kit.presets")}</span>
            <p className={kit.hint}>{t("kit.presetsHint")}</p>
            <div className={kit.presets} role="radiogroup" aria-labelledby={`kit-presets-${projectId}`}>
              {PRESET_THEMES.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  role="radio"
                  aria-checked={state.themeId === preset.id}
                  className={kit.preset}
                  disabled={!canEdit}
                  onClick={() => change((s) => applyPreset(s, preset.id))}
                >
                  <PresetMini theme={preset} />
                  <span className={kit.presetName}>{t(`kit.preset.${preset.id}`)}</span>
                </button>
              ))}
            </div>
          </section>

          {/* (b) the palette by role */}
          <section className={kit.section} aria-labelledby={`kit-palette-${projectId}`}>
            <div className={kit.sectionHead}>
              <span className={kit.fieldLabel} id={`kit-palette-${projectId}`}>{t("kit.palette")}</span>
              {canEdit && (
                <button type="button" className={kit.linkButton} disabled={Object.keys(state.overrides).length === 0} onClick={() => change({ overrides: {} })}>
                  {t("kit.resetPalette")}
                </button>
              )}
            </div>
            <div className={kit.roles}>
              {PALETTE_ROLES.map((role) => {
                const id = `kit-role-${role}-${projectId}`;
                const name = t(`kit.role.${role}`);
                return (
                  <div key={role} className={kit.role}>
                    <input id={id} type="color" className={kit.swatch} value={theme.palette[role]} disabled={!canEdit} onChange={(e) => setRole(role, e.target.value)} />
                    <label className={kit.roleText} htmlFor={id}>
                      <span className={kit.roleName}>{name}</span>
                      <span className={kit.roleHex}>{theme.palette[role]}</span>
                    </label>
                    {canEdit && state.overrides[role] !== undefined && (
                      <button type="button" className={kit.roleReset} aria-label={t("kit.resetRole", { role: name })} title={t("kit.resetRole", { role: name })} onClick={() => resetRole(role)}>
                        ↺
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {textAdjusted && <p className={kit.hint} role="status">{t("kit.textAdjusted")}</p>}
          </section>

          {/* (c) fonts from the curated list */}
          <section className={kit.section}>
            <div className={kit.fontGrid}>
              {fontSelect("headingFont")}
              {fontSelect("bodyFont")}
            </div>
            <p className={kit.hint}>{t("kit.fontsHint")}</p>
          </section>

          {/* (d) corner radius */}
          <section className={kit.section}>
            <label className={kit.fieldLabel} htmlFor={`kit-radius-${projectId}`}>{t("kit.radius")}</label>
            <div className={kit.range}>
              <input
                id={`kit-radius-${projectId}`}
                type="range"
                min={0}
                max={RADIUS_MAX}
                step={1}
                value={theme.radius}
                disabled={!canEdit}
                onChange={(e) => change({ radius: Number(e.target.value) })}
              />
              <span className={kit.rangeValue}>{t("kit.radiusValue", { value: theme.radius })}</span>
            </div>
          </section>

          {/* (e) the picture look generate_media receives */}
          <section className={kit.section} aria-labelledby={`kit-picture-${projectId}`}>
            <span className={kit.fieldLabel} id={`kit-picture-${projectId}`}>{t("kit.picture")}</span>
            <p className={kit.hint}>{t("kit.pictureHint")}</p>
            <div className={kit.chips} role="radiogroup" aria-labelledby={`kit-picture-${projectId}`}>
              {PICTURE_STYLE_IDS.map((style) => (
                <button
                  key={style}
                  type="button"
                  role="radio"
                  aria-checked={theme.picture.style === style}
                  className={chip(theme.picture.style === style)}
                  title={t(`kit.pictureStyle.${style}.hint`)}
                  disabled={!canEdit}
                  onClick={() => change({ pictureStyle: style })}
                >
                  {t(`kit.pictureStyle.${style}.name`)}
                </button>
              ))}
            </div>
            <p className={kit.styleHint}>{t(`kit.pictureStyle.${theme.picture.style}.hint`)}</p>
            <div className={kit.field}>
              <label className={kit.fieldLabel} htmlFor={`kit-mood-${projectId}`}>{t("kit.mood")}</label>
              <input
                id={`kit-mood-${projectId}`}
                className={styles.threadFilter}
                value={state.mood}
                onChange={(e) => change({ mood: e.target.value })}
                readOnly={!canEdit}
                placeholder={base.picture.mood}
                maxLength={MOOD_MAX}
              />
            </div>
            <div className={kit.field}>
              <label className={kit.fieldLabel} htmlFor={`kit-notes-${projectId}`}>{t("designStyle")}</label>
              <textarea
                id={`kit-notes-${projectId}`}
                className={kit.notes}
                value={state.imageStyle}
                onChange={(e) => change({ imageStyle: e.target.value })}
                readOnly={!canEdit}
                placeholder={t("designStylePlaceholder")}
                maxLength={2000}
                rows={2}
              />
            </div>
          </section>

          {/* (f) the logo and its corner */}
          <section className={kit.section} aria-labelledby={`kit-logo-${projectId}`}>
            <span className={kit.fieldLabel} id={`kit-logo-${projectId}`}>{t("designLogo")}</span>
            <div className={styles.projectAssetGrid} role="radiogroup" aria-labelledby={`kit-logo-${projectId}`}>
              <button type="button" role="radio" aria-checked={state.logo === null} className={state.logo === null ? `${styles.projectAsset} ${styles.threadItemActive}` : styles.projectAsset} disabled={!canEdit} onClick={() => change({ logo: null })}>
                <span className={styles.threadTitle}>{t("designNoLogo")}</span>
              </button>
              {images.map((image) => (
                <button
                  key={image.id}
                  type="button"
                  role="radio"
                  aria-checked={state.logo === image.id}
                  className={state.logo === image.id ? `${styles.projectAsset} ${styles.threadItemActive}` : styles.projectAsset}
                  disabled={!canEdit}
                  onClick={() => change({ logo: image.id })}
                >
                  {image.previewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed storage URL
                    <img className={styles.projectAssetThumb} src={image.previewUrl} alt="" />
                  ) : null}
                  <span className={styles.threadTitle}>{image.label || t("assetKind.image")}</span>
                </button>
              ))}
            </div>
            <span className={kit.fieldLabel} id={`kit-corner-${projectId}`}>{t("kit.logoPlacement")}</span>
            <div className={kit.chips} role="radiogroup" aria-labelledby={`kit-corner-${projectId}`}>
              {LOGO_PLACEMENTS.map((placement) => (
                <button
                  key={placement}
                  type="button"
                  role="radio"
                  aria-checked={theme.logoPlacement === placement}
                  className={chip(theme.logoPlacement === placement)}
                  disabled={!canEdit}
                  onClick={() => change({ logoPlacement: placement })}
                >
                  {t(`kit.placement.${placement}`)}
                </button>
              ))}
            </div>
          </section>

          {/* (g) shapes and the Facebook background, as before */}
          <section className={kit.section}>
            <span className={kit.fieldLabel}>{t("designRatios")}</span>
            <div className={kit.chips} role="group" aria-label={t("designRatios")}>
              {RATIOS.map((ratio) => {
                const at = state.ratios.indexOf(ratio);
                return (
                  <button key={ratio} type="button" className={chip(at >= 0)} aria-pressed={at >= 0} disabled={!canEdit} onClick={() => toggleRatio(ratio)}>
                    {at === 0 ? `${ratio} ★` : ratio}
                  </button>
                );
              })}
            </div>
          </section>

          <section className={kit.section}>
            <span className={kit.fieldLabel}>{t("designFacebook")}</span>
            <div className={kit.chips} role="radiogroup" aria-label={t("designFacebook")}>
              {[{ id: null as string | null, label: t("designNoBackground") }, ...FACEBOOK_BACKGROUNDS.map((b) => ({ id: b.id as string | null, label: `${b.category}: ${b.label}` }))].map((option) => (
                <button
                  key={option.id ?? "none"}
                  type="button"
                  role="radio"
                  aria-checked={state.background === option.id}
                  className={chip(state.background === option.id)}
                  disabled={!canEdit}
                  onClick={() => change({ background: option.id })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </section>

          {canEdit && (
            <div className={kit.saveRow}>
              <button type="button" className={styles.newChat} onClick={() => void save()} disabled={!dirty || saving}>
                {saving ? t("saving") : t("saveDesign")}
              </button>
              {saved && !dirty && <span className={styles.threadEmpty} role="status">{t("saved")}</span>}
              {error !== null && <span className={styles.errorText} role="alert">{error}</span>}
            </div>
          )}
        </div>

        {/* (h) the live preview, in the resolved theme */}
        <KitPreviews theme={theme} ratio={state.ratios[0]} logoUrl={logoUrl} />
      </div>
    </div>
  );
}
