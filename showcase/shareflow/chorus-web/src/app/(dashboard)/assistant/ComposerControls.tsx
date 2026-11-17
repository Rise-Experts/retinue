"use client";

/**
 * The row under the chat box — #549 (+ menu, voice), #550 (agent mode), #551 (model, effort), #552 (the
 * circular context and credits meter).
 *
 * Laid out like Claude Code's input: attach, voice and mode on the left, model, effort and the meter on
 * the right, each a small button that opens its own menu above the box. Every menu closes on Escape and
 * on a click outside, and hands focus back to the button that opened it.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { AgentMode, ConversationSettings, Effort, MediaKind, MediaSettings } from "@/lib/assistant/conversationSettings";
import { AGENT_MODES, ASPECT_RATIOS, EFFORTS } from "@/lib/assistant/conversationSettings";
import type { ChatModel } from "@/lib/assistant/retinueClient";
import { DICTATION_LANGS, useDictation, type DictationLang } from "./useDictation";
import { compactTokens, meterBreakdown, nearCondense, type MeterData } from "@/lib/assistant/meterBreakdown";
import styles from "./composer.module.css";

export type { MeterData } from "@/lib/assistant/meterBreakdown";

export type MonthCredits = { readonly used: number; readonly limit: number; readonly plan?: string };

type Dictation = {
  readonly supported: boolean;
  readonly listening: boolean;
  readonly lang: DictationLang;
  readonly setLang: (lang: DictationLang) => void;
  readonly start: () => void;
  readonly stop: () => void;
};

/* ---- a menu that opens above its button ---- */

function Pop({
  label,
  trigger,
  children,
  align = "left",
  width,
  disabled = false,
  active = false,
}: {
  label: string;
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  width?: number;
  disabled?: boolean;
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const triggerId = `${id}-trigger`;
  /** Focus back to the button that opened the menu — by id, so nothing reads a ref during render. */
  const refocus = () => requestAnimationFrame(() => document.getElementById(triggerId)?.focus());
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current !== null && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      document.getElementById(triggerId)?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, triggerId]);
  const close = () => {
    setOpen(false);
    refocus();
  };
  return (
    <div className={styles.popRoot} ref={root}>
      <button
        id={triggerId}
        type="button"
        className={`${styles.tb} ${open || active ? styles.tbOn : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
      </button>
      {open && (
        <div id={id} className={`${styles.menu} ${align === "right" ? styles.menuRight : ""}`} style={width === undefined ? undefined : { width }} role="menu" aria-label={label}>
          {children(close)}
        </div>
      )}
    </div>
  );
}

/* ---- icons: inline stroke glyphs, sized by the button ---- */

const Icon = ({ d, children }: { d?: string; children?: ReactNode }) => (
  <svg className={styles.ic} viewBox="0 0 16 16" aria-hidden="true">
    {d === undefined ? children : <path d={d} />}
  </svg>
);
const PLUS = "M8 3v10M3 8h10";
const CHEV = "M4 6l4 4 4-4";
const RIGHT = "M6 4l4 4-4 4";
const CHECK = "M3 8.5l3 3 7-7";

/* ---- the meter ---- */

const CIRC = 2 * Math.PI * 15;

function Ring({ share, level }: { share: number; level: "calm" | "warm" | "full" }) {
  return (
    <svg className={styles.ring} viewBox="0 0 36 36" aria-hidden="true">
      <circle cx="18" cy="18" r="15" className={styles.ringTrack} />
      <circle cx="18" cy="18" r="15" className={`${styles.ringFill} ${styles[level]}`} strokeDasharray={`${(share * CIRC).toFixed(1)} ${CIRC.toFixed(1)}`} transform="rotate(-90 18 18)" />
    </svg>
  );
}

/* ---- the row ---- */

export function ComposerControls({
  disabled,
  canAttach,
  onAddFiles,
  onProjectFiles,
  onMediaLibrary,
  onSlash,
  hasProject,
  dictation,
  settings,
  onSettingsChange,
  models,
  defaultModelId,
  meter,
  month,
}: {
  disabled: boolean;
  canAttach: boolean;
  onAddFiles: () => void;
  onProjectFiles: () => void;
  onMediaLibrary: () => void;
  onSlash: () => void;
  hasProject: boolean;
  dictation: Dictation;
  settings: ConversationSettings;
  onSettingsChange: (next: ConversationSettings) => void;
  models: readonly ChatModel[];
  defaultModelId: string | null;
  meter: MeterData | undefined;
  month: MonthCredits;
}) {
  const t = useTranslations("assistant.box");
  const chosenModel = models.find((m) => m.id === (settings.model ?? defaultModelId)) ?? models.find((m) => m.id === defaultModelId);
  const share = meter !== undefined && meter.limit > 0 && meter.measured ? Math.min(1, meter.used / meter.limit) : 0;
  const level = share >= 0.9 ? "full" : share >= 0.7 ? "warm" : "calm";
  const percent = Math.round(share * 100);
  const monthShare = month.limit > 0 ? Math.min(1, month.used / month.limit) : 0;

  return (
    <div className={styles.controls}>
      <Pop label={t("add")} trigger={<Icon d={PLUS} />} disabled={disabled} width={320}>
        {(close) => (
          <>
            <button type="button" role="menuitem" className={styles.mi} disabled={!canAttach} onClick={() => { close(); onAddFiles(); }}>
              <Icon d="M13 7.5l-5.3 5.3a3 3 0 01-4.2-4.2L9 3.1a2 2 0 012.8 2.8L6.4 11.3a1 1 0 01-1.4-1.4L10 5" />
              <span className={styles.miText}>{t("addFiles")}</span>
            </button>
            <button type="button" role="menuitem" className={styles.mi} disabled={!hasProject} onClick={() => { close(); onProjectFiles(); }}>
              <Icon d="M2 4.5h4l1.5 1.5H14v6.5H2z" />
              <span className={styles.miText}>{t("projectFiles")}{!hasProject && <span className={styles.miSub}>{t("projectFilesNone")}</span>}</span>
            </button>
            <button type="button" role="menuitem" className={styles.mi} onClick={() => { close(); onMediaLibrary(); }}>
              <Icon>
                <rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" />
                <path d="M2 11l3.5-3.5 3 3 2-2L14 12" />
              </Icon>
              <span className={styles.miText}>{t("posts")}</span>
            </button>
            <button type="button" role="menuitem" className={styles.mi} onClick={() => { close(); onSlash(); }}>
              <Icon>
                <rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="none" />
                <path d="M9.5 5l-3 6" />
              </Icon>
              <span className={styles.miText}>{t("commands")}</span>
            </button>
            <div className={styles.sep} />
            <Link role="menuitem" className={styles.mi} href="/settings/apps">
              <Icon>
                <rect x="2.5" y="7" width="5" height="6.5" rx="1" fill="none" />
                <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" fill="none" />
                <path d="M7.5 10h2.5V7" />
              </Icon>
              <span className={styles.miText}>{t("connectors")}<span className={styles.miSub}>{t("connectorsHint")}</span></span>
              <Icon d={RIGHT} />
            </Link>
          </>
        )}
      </Pop>

      {dictation.supported && (
        <>
          <button
            type="button"
            className={`${styles.tb} ${dictation.listening ? styles.tbRec : ""}`}
            aria-label={dictation.listening ? t("dictating") : t("dictate")}
            title={t("dictate")}
            aria-pressed={dictation.listening}
            disabled={disabled}
            onPointerDown={(e) => {
              e.preventDefault();
              dictation.start();
            }}
            onPointerUp={() => dictation.stop()}
            onPointerLeave={() => dictation.listening && dictation.stop()}
            onKeyDown={(e) => {
              if ((e.key === " " || e.key === "Enter") && !dictation.listening) {
                e.preventDefault();
                dictation.start();
              }
            }}
            onKeyUp={(e) => {
              if (e.key === " " || e.key === "Enter") dictation.stop();
            }}
          >
            <Icon>
              <rect x="6" y="2" width="4" height="8" rx="2" fill="none" />
              <path d="M3.5 8a4.5 4.5 0 009 0M8 12.5V14" />
            </Icon>
          </button>
          <Pop label={t("dictationLanguage")} trigger={<Icon d={CHEV} />} width={200}>
            {(close) =>
              DICTATION_LANGS.map((lang) => (
                <button key={lang} type="button" role="menuitemradio" aria-checked={dictation.lang === lang} className={styles.mi} onClick={() => { dictation.setLang(lang); close(); }}>
                  <span className={styles.miText}>{t(`langs.${lang}`)}</span>
                  {dictation.lang === lang && <Icon d={CHECK} />}
                </button>
              ))
            }
          </Pop>
        </>
      )}

      <Pop label={t("modeLabel")} trigger={<span className={styles.tbText}>{t(`modes.${settings.mode}.name`)}</span>} width={360} active={settings.mode !== "auto"}>
        {(close) => (
          <>
            <div className={styles.mh}>{t("modeLabel")}</div>
            {AGENT_MODES.map((mode, index) => (
              <button key={mode} type="button" role="menuitemradio" aria-checked={settings.mode === mode} className={styles.mi} onClick={() => { onSettingsChange({ ...settings, mode: mode as AgentMode }); close(); }}>
                <span className={styles.miText}>
                  <span>
                    {t(`modes.${mode}.name`)}
                    {mode === "auto" && <span className={styles.tag}>{t("default")}</span>}
                  </span>
                  <span className={styles.miSub}>{t(`modes.${mode}.hint`)}</span>
                </span>
                {settings.mode === mode ? <Icon d={CHECK} /> : <span className={styles.num}>{index + 1}</span>}
              </button>
            ))}
          </>
        )}
      </Pop>

      {/*
        #575: image and video settings, like Google Flow — what to make, its shape, the generator and a
        reference photo. Added beside the mode; nothing else in the row moves.
      */}
      <Pop
        label={t("media")}
        trigger={
          <>
            <Icon d={settings.media?.kind === "video" ? VIDEO : IMAGE} />
            {settings.media !== undefined && <span className={styles.tbText}>{mediaSummary(settings.media, t)}</span>}
          </>
        }
        width={320}
        active={settings.media !== undefined}
      >
        {(close) => <MediaMenu settings={settings} onSettingsChange={onSettingsChange} onReference={() => { close(); onAddFiles(); }} canAttach={canAttach} />}
      </Pop>

      <div className={styles.spacer} />

      {models.length > 0 && (
        <Pop label={t("modelLabel")} trigger={<span className={styles.tbText}>{chosenModel?.label ?? t("modelDefault")}</span>} align="right" width={340}>
          {(close) => (
            <>
              {models.map((model) => {
                const on = model.id === (settings.model ?? defaultModelId);
                return (
                  <button
                    key={model.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={on}
                    className={styles.mi}
                    onClick={() => {
                      onSettingsChange(model.id === defaultModelId ? { mode: settings.mode, effort: settings.effort, ...(settings.media === undefined ? {} : { media: settings.media }) } : { ...settings, model: model.id });
                      close();
                    }}
                  >
                    <span className={styles.miText}>
                      {model.label}
                      <span className={styles.miSub}>{model.source === "workspace" ? t("modelOwnKey") : t("modelChorus")}</span>
                    </span>
                    {on && <Icon d={CHECK} />}
                  </button>
                );
              })}
              <div className={styles.sep} />
              <Link role="menuitem" className={styles.mi} href="/settings/providers">
                <span className={styles.miText}>{t("moreModels")}<span className={styles.miSub}>{t("moreModelsHint")}</span></span>
                <Icon d={RIGHT} />
              </Link>
            </>
          )}
        </Pop>
      )}

      <Pop label={t("effortLabel")} trigger={<span className={styles.tbText}>{t(`efforts.${settings.effort}`)}</span>} align="right" width={320} active={settings.effort !== "medium"}>
        {() => (
          <div className={styles.effort}>
            <div className={styles.effortHead}>
              <span className={styles.muted}>{t("effortLabel")}</span>
              <span>{t(`efforts.${settings.effort}`)}</span>
            </div>
            <div className={styles.effortEnds}>
              <span>{t("faster")}</span>
              <span>{t("smarter")}</span>
            </div>
            <div className={styles.effortTrack} role="radiogroup" aria-label={t("effortLabel")}>
              {EFFORTS.map((effort) => (
                <button
                  key={effort}
                  type="button"
                  role="radio"
                  aria-checked={settings.effort === effort}
                  aria-label={t(`efforts.${effort}`)}
                  className={settings.effort === effort ? styles.effortThumb : styles.effortDot}
                  onClick={() => onSettingsChange({ ...settings, effort: effort as Effort })}
                />
              ))}
            </div>
            <p className={styles.effortHint}>{t("effortHint")}</p>
          </div>
        )}
      </Pop>

      <Pop
        label={meter !== undefined && meter.measured ? t("meterLabel", { percent }) : t("meterLabelNone")}
        trigger={
          <span className={styles.meterBtn}>
            <Ring share={share} level={level} />
            {/* Visible, not screen-reader only: a bare ring with a small arc read as a loading spinner on
                production, so a finished chat looked stuck. The number makes it a meter. */}
            <span className={styles.meterPct}>{meter !== undefined && meter.measured ? `${percent}%` : "–"}</span>
          </span>
        }
        align="right"
        width={380}
      >
        {() => (
          <div className={styles.meterPop}>
            <div className={styles.meterRow}>
              <span className={styles.muted}>{t("context")}</span>
              <span>
                {meter !== undefined && meter.measured
                  ? t("contextOf", { used: compactTokens(meter.used), limit: compactTokens(meter.limit), percent })
                  : t("contextNone")}
              </span>
            </div>
            {meter !== undefined && meter.measured && (
              <>
                <div className={styles.stack} aria-hidden="true">
                  {meterBreakdown(meter).map((part) => (
                    <span key={part.key} className={`${styles.stackPart} ${styles[`src_${part.key}`]}`} style={{ width: `${Math.max(1, (part.tokens / Math.max(meter.limit, 1)) * 100)}%` }} />
                  ))}
                </div>
                <ul className={styles.legend}>
                  {meterBreakdown(meter).map((part) => (
                    <li key={part.key}>
                      <span className={`${styles.swatch} ${styles[`src_${part.key}`]}`} aria-hidden="true" />
                      {t(`sources.${part.key}`)} <span className={styles.muted}>{compactTokens(part.tokens)}</span>
                    </li>
                  ))}
                </ul>
                <div className={styles.muted}>{t("turnTokens", { tokens: compactTokens(meter.turnTokens), steps: meter.steps })}</div>
                {meter.cached !== undefined && meter.cached > 0 && (
                  <div className={styles.muted}>{t("cachedTokens", { tokens: compactTokens(meter.cached) })}</div>
                )}
                {/* #630: which model the bar is measured against, and what happens as it fills. */}
                {meter.modelId !== undefined && meter.window !== undefined && (
                  <div className={styles.muted}>{t("modelWindow", { model: meter.modelId, window: compactTokens(meter.window) })}</div>
                )}
                {meter.compactAt !== undefined && <div className={styles.muted}>{t("condensesAt", { tokens: compactTokens(meter.compactAt) })}</div>}
                {meter.condensed === true && <div className={styles.muted}>{t("condensed")}</div>}
                {nearCondense(meter) && <div className={styles.muted}>{t("condensingSoon")}</div>}
              </>
            )}
            <div className={styles.sep} />
            <div className={styles.meterRow}>
              <span className={styles.muted}>{month.plan === undefined ? t("credits") : t("creditsPlan", { plan: month.plan })}</span>
              <Link href="/settings/billing" className={styles.linkSmall}>→</Link>
            </div>
            <div className={styles.meterRow}>
              <span>{t("thisMonth")}</span>
              <span className={styles.muted}>{t("monthOf", { used: month.used.toLocaleString(), limit: month.limit.toLocaleString(), percent: Math.round(monthShare * 100) })}</span>
            </div>
            <div className={styles.bar} aria-hidden="true">
              <span style={{ width: `${Math.max(2, monthShare * 100)}%` }} />
            </div>
            {meter !== undefined && meter.credits > 0 && (
              <div className={styles.meterRow}>
                <span>{meter.creditsScope === "conversation" ? t("thisChat") : t("thisTurn")}</span>
                <span className={styles.muted}>{t("creditsCount", { count: meter.credits })}</span>
              </div>
            )}
            <div className={styles.sep} />
            <Link href="/settings/billing" className={styles.linkSmall}>{t("breakdown")}</Link>
          </div>
        )}
      </Pop>
    </div>
  );
}

/* ---- image and video settings (#575) ---- */

const IMAGE = "M2.5 3.5h11v9h-11zM2.5 10.5l3-3 2.5 2.5 2-2 3.5 3.5";
const VIDEO = "M2 4h8.5v8H2zM10.5 7l3.5-2v6l-3.5-2";

const ASPECTS: readonly { readonly ratio: (typeof ASPECT_RATIOS)[number]; readonly key: string; readonly w: number; readonly h: number }[] = [
  { ratio: "16:9", key: "landscape", w: 12, h: 7 },
  { ratio: "9:16", key: "portrait", w: 7, h: 12 },
  { ratio: "1:1", key: "square", w: 10, h: 10 },
  { ratio: "4:5", key: "feed", w: 8, h: 10 },
];

type Translate = ReturnType<typeof useTranslations>;

const mediaSummary = (media: MediaSettings, t: Translate): string =>
  [media.kind === undefined ? null : t(media.kind === "video" ? "mediaVideo" : "mediaImage"), media.aspectRatio ?? null].filter(Boolean).join(" · ");

const Shape = ({ w, h }: { w: number; h: number }) => (
  <svg className={styles.ic} viewBox="0 0 16 16" aria-hidden="true">
    <rect x={(16 - w) / 2} y={(16 - h) / 2} width={w} height={h} rx="1.5" fill="none" />
  </svg>
);

type MediaModel = { readonly id: string; readonly name?: string };

/** The generators the person's Higgsfield account offers for this kind — read when the menu opens. */
function useMediaModels(kind: MediaKind): { models: readonly MediaModel[] | null; connected: boolean } {
  const [state, setState] = useState<{ kind: MediaKind; models: readonly MediaModel[]; connected: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/integrations/higgsfield/models?kind=${kind}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { connected?: boolean; models?: MediaModel[] } | null) => {
        if (live) setState({ kind, models: body?.models ?? [], connected: body?.connected === true });
      })
      .catch(() => live && setState({ kind, models: [], connected: false }));
    return () => {
      live = false;
    };
  }, [kind]);
  return state === null || state.kind !== kind ? { models: null, connected: true } : { models: state.models, connected: state.connected };
}

function MediaMenu({
  settings,
  onSettingsChange,
  onReference,
  canAttach,
}: {
  settings: ConversationSettings;
  onSettingsChange: (next: ConversationSettings) => void;
  onReference: () => void;
  canAttach: boolean;
}) {
  const t = useTranslations("assistant.box");
  const media = settings.media;
  const kind: MediaKind = media?.kind ?? "image";
  const { models, connected } = useMediaModels(kind);
  const set = (next: MediaSettings | undefined) => {
    const { media: _drop, ...rest } = settings;
    void _drop;
    onSettingsChange(next === undefined ? rest : { ...rest, media: next });
  };
  return (
    <>
      <div className={styles.mh}>{t("mediaCreate")}</div>
      <div className={styles.seg} role="group" aria-label={t("mediaCreate")}>
        {(["image", "video"] as const).map((k) => (
          <button
            key={k}
            type="button"
            className={`${styles.segBtn} ${media?.kind === k ? styles.segOn : ""}`}
            aria-pressed={media?.kind === k}
            // A different kind keeps the shape but not the model: generators are per kind.
            onClick={() => set({ kind: k, ...(media?.aspectRatio === undefined ? {} : { aspectRatio: media.aspectRatio }) })}
          >
            <Icon d={k === "video" ? VIDEO : IMAGE} />
            {t(k === "video" ? "mediaVideo" : "mediaImage")}
          </button>
        ))}
      </div>

      <div className={styles.mh}>{t("aspectRatio")}</div>
      {ASPECTS.map((a) => (
        <button
          key={a.ratio}
          type="button"
          role="menuitemradio"
          aria-checked={media?.aspectRatio === a.ratio}
          className={`${styles.mi} ${media?.aspectRatio === a.ratio ? styles.miActive : ""}`}
          onClick={() => set({ ...media, kind, aspectRatio: a.ratio })}
        >
          <Shape w={a.w} h={a.h} />
          <span className={styles.miText}>{t(`aspects.${a.key}`, { ratio: a.ratio })}</span>
          {media?.aspectRatio === a.ratio && <Icon d={CHECK} />}
        </button>
      ))}

      <div className={styles.mh}>{t("mediaModel")}</div>
      <button type="button" role="menuitemradio" aria-checked={media?.model === undefined} className={styles.mi} onClick={() => set({ ...media, kind, model: undefined })}>
        <span className={styles.miText}>
          {t("mediaModelDefault")}
          <span className={styles.miSub}>{t("mediaModelDefaultHint")}</span>
        </span>
        {media?.model === undefined && <Icon d={CHECK} />}
      </button>
      {models === null ? <div className={styles.mh}>{t("mediaModelsLoading")}</div> : null}
      {models !== null && !connected ? <div className={styles.mh}>{t("mediaModelsConnect")}</div> : null}
      {(models ?? []).slice(0, 12).map((m, _i, all) => (
        <button key={m.id} type="button" role="menuitemradio" aria-checked={media?.model === m.id} className={styles.mi} onClick={() => set({ ...media, kind, model: m.id })}>
          <span className={styles.miText}>
            {m.name ?? m.id}
            {/* Higgsfield lists different models under one name ("Cinema Studio Video" twice): the id tells them apart. */}
            {m.name !== undefined && all.filter((o) => o.name === m.name).length > 1 && <span className={styles.miSub}>{m.id}</span>}
          </span>
          {media?.model === m.id && <Icon d={CHECK} />}
        </button>
      ))}

      <div className={styles.sep} />
      <button type="button" role="menuitem" className={styles.mi} disabled={!canAttach} onClick={onReference}>
        <Icon d="M3 3.5h10v9H3zM6 12.5l2.5-3 2 2M10 5.5v3M8.5 7h3" />
        <span className={styles.miText}>
          {t("mediaReference")}
          <span className={styles.miSub}>{t("mediaReferenceHint")}</span>
        </span>
      </button>
      {media !== undefined && (
        <button type="button" role="menuitem" className={styles.mi} onClick={() => set(undefined)}>
          <span className={styles.miText}>
            {t("mediaOff")}
            <span className={styles.miSub}>{t("mediaOffHint")}</span>
          </span>
        </button>
      )}
    </>
  );
}

/**
 * The chat box's row of controls for the start screen — #576. The start screen's box had only its own
 * chips; the same attach, voice, mode, image/video, model, effort and meter now sit under its text
 * field, and what is chosen there applies to the first turn. Voice types into the start screen's own
 * field, through `append`.
 */
export function StartControls(
  props: Omit<Parameters<typeof ComposerControls>[0], "dictation" | "onProjectFiles" | "onMediaLibrary" | "onSlash" | "hasProject"> & {
    readonly append: (text: string) => void;
  },
) {
  const { append, ...rest } = props;
  const dictation = useDictation(append, "en-US");
  return <ComposerControls {...rest} dictation={dictation} hasProject={false} onProjectFiles={() => undefined} onMediaLibrary={() => undefined} onSlash={() => undefined} />;
}

