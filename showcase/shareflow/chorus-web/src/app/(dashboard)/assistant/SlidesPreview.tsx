/**
 * A slides artifact in the panel — #607, redesigned and animated in #620: the current slide large, prev/next, a
 * strip of thumbnails, and a Present button for full screen.
 *
 * The deck is parsed with the same rules the export uses (`@/lib/assistant/slides`, diffed against the agent
 * service's module in a test) and drawn in the same markup as the print page, styled by the same stylesheet
 * (`@/lib/assistant/slideDesign`, a verbatim copy held equal by the same test) — so the preview is the PDF, the
 * carousel and the video at a smaller size. A `chorus-media:` image is resolved through the viewer's own signed
 * URL, where the export inlines the bytes.
 *
 * ## Motion
 *
 * A slide arrives with its transition (`<!-- transition: … -->`, fade by default) and plays its build-ins — the
 * heading, then the bullets in turn, a figure counting up, a ring filling, a timeline stepping in. Nothing moves
 * on first render, on a thumbnail, or at all under `prefers-reduced-motion`: the design only animates a slide
 * carrying `s-play`, and this component never adds it then.
 */

"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { parseMediaRef } from "@/lib/assistant/mediaRef";
import { SlideMarkdown } from "@/lib/assistant/slideMarkdown";
import {
  DEFAULT_SLIDE_FORMAT,
  countUpText,
  hasDeco,
  hidesIndex,
  parseSlides,
  slideClasses,
  slideIndexText,
  slideNumber,
  slideParts,
  slideTransition,
  statRing,
  type Deck,
  type Slide,
  type SlideFormat,
  type SlideImage,
  type SlideParts,
} from "@/lib/assistant/slides";
import { SLIDE_DESIGN_CSS, SLIDE_TRANSITION_EASING, SLIDE_TRANSITION_MS, transitionFrames } from "@/lib/assistant/slideDesign";
import { isDarkThemeVars, slideGroundVars, withDeckStyleVars, type SlideLogo, type ThemeVars } from "@/lib/assistant/artifactTheme";
import { useSignedMedia } from "./useSignedMedia";
import styles from "./slides.module.css";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const subscribeReducedMotion = (onChange: () => void) => {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
/** True under `prefers-reduced-motion`, and on the server, where nothing should animate anyway. */
function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, () => window.matchMedia(REDUCED_MOTION).matches, () => true);
}

/** A `chorus-media:` reference through the viewer's signed URL; an https source as it is. */
function useSlideSource(src: string | undefined): string | undefined {
  const path = src?.startsWith("chorus-media:") ? parseMediaRef(src) : null;
  const { media, failed } = useSignedMedia(path);
  if (src === undefined || failed) return undefined;
  return path ? media?.url : src;
}

/** The theme's variables, and (#620) its radius as the bare number the design scales by the slide's unit. */
const deckStyle = (theme: ThemeVars): CSSProperties => ({ ...theme, "--r": Number.parseFloat(theme["--t-radius"] ?? "8") || 0 }) as CSSProperties;

const cssUrl = (url: string) => `url("${url.replace(/["\\\n\r]/g, "")}")`;

/** #615/#620: the full-bleed picture, graded to the theme by the design, and the shade that keeps text legible. */
function SlideBackground({ src }: { src: string }) {
  const url = useSlideSource(src);
  return (
    <>
      {url && <div className="s-bg" style={{ "--bg": cssUrl(url) } as CSSProperties} />}
      <div className="s-shade" />
    </>
  );
}

function SlideLogoMark({ logo }: { logo: SlideLogo }) {
  const url = useSlideSource(logo.reference);
  if (!url || logo.placement === "none") return null;
  // eslint-disable-next-line @next/next/no-img-element -- a signed storage URL
  return <img className={`s-logo ${logo.placement}`} src={url} alt="" referrerPolicy="no-referrer" />;
}

/** A picture the deck names, or its alt text where it cannot be shown — as the print page draws a missing one. */
function SlidePicture({ image, fallback }: { image: SlideImage | undefined; fallback: string }) {
  const url = useSlideSource(image?.src);
  const [broken, setBroken] = useState(false);
  if (!url || broken) return <div className="s-missing">{fallback || "Image"}</div>;
  // eslint-disable-next-line @next/next/no-img-element -- a signed storage URL or the deck's own https image
  return <img src={url} alt={image?.alt ?? ""} referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
}

function SlideFigure({ image, className = "s-figure" }: { image: SlideImage | undefined; className?: string }) {
  return (
    <figure className={className}>
      <SlidePicture image={image} fallback={image?.alt ?? ""} />
    </figure>
  );
}

/** #620: a figure counting up to itself while its slide plays, from the same function the video uses. */
function useCountUp(figure: string, play: boolean): string {
  const [text, setText] = useState(() => (play ? countUpText(figure, 0) : figure));
  useEffect(() => {
    if (!play) return;
    const start = performance.now() + 250;
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, Math.max(0, (now - start) / 1400));
      setText(countUpText(figure, progress));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [figure, play]);
  return play ? text : figure;
}

function StatNumber({ figure, play }: { figure: string; play: boolean }) {
  const text = useCountUp(figure, play);
  return (
    <div className="s-stat" style={{ "--n": Math.max(figure.length, 2) } as CSSProperties} data-figure={figure}>
      {text}
    </div>
  );
}

/** #615: a percentage in a ring filled to it; any other figure over an accent bar — as the export draws it. */
function StatFigure({ figure, play }: { figure: string; play: boolean }) {
  const ring = statRing(figure);
  if (ring === null) {
    return (
      <>
        <StatNumber figure={figure} play={play} />
        {figure !== "" && <div className="s-bar" />}
      </>
    );
  }
  return (
    <div className="s-ring" style={{ "--p": ring } as CSSProperties}>
      <StatNumber figure={figure} play={play} />
    </div>
  );
}

function Head({ eyebrow, before }: { eyebrow: string | undefined; before: string }) {
  if (eyebrow === undefined && before.trim() === "") return null;
  return (
    <div className="s-head">
      {eyebrow !== undefined && <div className="s-eyebrow">{eyebrow}</div>}
      <SlideMarkdown>{before}</SlideMarkdown>
    </div>
  );
}

const joinText = (parts: SlideParts) => [parts.before, parts.after].filter((part) => part.trim() !== "").join("\n\n");

/** The slide's content, in the markup `innerHtml` writes for the print page. */
function SlideBody({ slide, parts, play }: { slide: Slide; parts: SlideParts; play: boolean }) {
  const eyebrow = slide.eyebrow === undefined ? null : <div className="s-eyebrow">{slide.eyebrow}</div>;
  const items = parts.items ?? [];
  const at = (i: number) => ({ "--i": i }) as CSSProperties;
  switch (slide.layout) {
    case "title":
    case "section":
      return (
        <>
          {eyebrow}
          <SlideMarkdown>{parts.before}</SlideMarkdown>
        </>
      );
    case "stat":
      return (
        <>
          <Head eyebrow={slide.eyebrow} before={parts.before} />
          <div className="s-main">
            <StatFigure figure={parts.figure ?? ""} play={play} />
            <SlideMarkdown>{parts.after}</SlideMarkdown>
          </div>
        </>
      );
    case "stat-grid":
      return (
        <>
          <Head eyebrow={slide.eyebrow} before={parts.before} />
          <div className="s-grid" style={{ "--count": items.length } as CSSProperties}>
            {items.map((item, i) => (
              <div className="s-cell" style={at(i)} key={i}>
                {item.figure !== undefined && <StatNumber figure={item.figure} play={play} />}
                {item.text !== "" && <div className="s-label">{item.text}</div>}
              </div>
            ))}
          </div>
        </>
      );
    case "agenda":
      return (
        <>
          <Head eyebrow={slide.eyebrow} before={parts.before} />
          <ol className="s-items">
            {items.map((item, i) => (
              <li className="s-item" style={at(i)} key={i}>
                <span className="s-k">{slideNumber(i + 1)}</span>
                <span className="s-t">{item.text}</span>
              </li>
            ))}
          </ol>
        </>
      );
    case "timeline":
      return (
        <>
          <Head eyebrow={slide.eyebrow} before={parts.before} />
          <ol className="s-steps">
            {items.map((item, i) => (
              <li className="s-step" style={at(i)} key={i}>
                <span className="s-dot" />
                <span className="s-when">{item.label ?? slideNumber(i + 1)}</span>
                <span className="s-what">{item.text}</span>
              </li>
            ))}
          </ol>
        </>
      );
    case "two-column":
    case "comparison": {
      const [a, b] = parts.columns ?? [
        { heading: "", body: "" },
        { heading: "", body: "" },
      ];
      return (
        <>
          <Head eyebrow={slide.eyebrow} before={parts.before} />
          <div className="s-cols">
            <div className="s-col" style={at(0)}>
              <SlideMarkdown>{a.heading}</SlideMarkdown>
              <SlideMarkdown>{a.body}</SlideMarkdown>
            </div>
            {slide.layout === "comparison" && <div className="s-vs">vs</div>}
            <div className="s-col" style={at(1)}>
              <SlideMarkdown>{b.heading}</SlideMarkdown>
              <SlideMarkdown>{b.body}</SlideMarkdown>
            </div>
          </div>
        </>
      );
    }
    case "columns": {
      // #664: even columns side by side, and never a "vs" — that is a comparison's alone.
      const grid = parts.grid ?? [];
      return (
        <>
          <Head eyebrow={slide.eyebrow} before={parts.before} />
          <div className="s-cols" style={{ "--count": grid.length } as CSSProperties}>
            {grid.map((col, i) => (
              <div key={i} className="s-col" style={at(i)}>
                <SlideMarkdown>{col.heading}</SlideMarkdown>
                <SlideMarkdown>{col.body}</SlideMarkdown>
              </div>
            ))}
          </div>
        </>
      );
    }
    case "team":
    case "logos":
      return (
        <>
          <Head eyebrow={slide.eyebrow} before={parts.before} />
          <div className={slide.layout === "team" ? "s-people" : "s-brands"} style={{ "--count": items.length } as CSSProperties}>
            {items.map((item, i) =>
              slide.layout === "team" ? (
                <figure className="s-person" style={at(i)} key={i}>
                  <div className="s-photo">
                    <SlidePicture image={item.image} fallback={item.text} />
                  </div>
                  <figcaption>
                    <strong>{item.text}</strong>
                    {item.label !== undefined && item.label !== "" && <span>{item.label}</span>}
                  </figcaption>
                </figure>
              ) : (
                <div className="s-brand" style={at(i)} key={i}>
                  <SlidePicture image={item.image} fallback={item.text} />
                </div>
              ),
            )}
          </div>
          {parts.after.trim() !== "" && (
            <div className="s-foot">
              <SlideMarkdown>{parts.after}</SlideMarkdown>
            </div>
          )}
        </>
      );
    case "quote":
      return (
        <>
          <div className="s-mark" aria-hidden="true">
            “
          </div>
          {eyebrow}
          <div className="s-main">
            <SlideMarkdown>{parts.before}</SlideMarkdown>
            {(parts.attribution !== undefined || parts.image !== undefined) && (
              <div className="s-cite">
                {parts.image !== undefined && <QuotePortrait image={parts.image} />}
                {parts.attribution !== undefined && <div className="s-attr">{parts.attribution}</div>}
              </div>
            )}
          </div>
        </>
      );
    case "image": {
      const text = joinText(parts);
      return (
        <>
          <SlideFigure image={parts.image} />
          {(text !== "" || eyebrow !== null) && (
            <div className="s-card">
              {eyebrow}
              <SlideMarkdown>{text}</SlideMarkdown>
            </div>
          )}
        </>
      );
    }
    case "image-left":
    case "image-right":
      return (
        <div className="s-split">
          <SlideFigure image={parts.image} />
          <div className="s-text">
            {eyebrow}
            <SlideMarkdown>{joinText(parts)}</SlideMarkdown>
          </div>
        </div>
      );
    case "cta":
      return (
        <>
          <Head eyebrow={slide.eyebrow} before={parts.before} />
          {(parts.button !== undefined || parts.link !== undefined) && (
            <div className="s-action">
              {parts.button !== undefined && (
                <span className="s-button">
                  {parts.button}
                  <i className="s-arrow" />
                </span>
              )}
              {parts.link !== undefined && <span className="s-link">{parts.link}</span>}
            </div>
          )}
        </>
      );
    default:
      return (
        <>
          <Head eyebrow={slide.eyebrow} before={parts.before} />
          {parts.after.trim() !== "" && (
            <div className="s-main">
              <SlideMarkdown>{parts.after}</SlideMarkdown>
            </div>
          )}
        </>
      );
  }
}

/** A quote's portrait — drawn only when it can be shown, as the print page leaves out one it could not read. */
function QuotePortrait({ image }: { image: SlideImage }) {
  const url = useSlideSource(image.src);
  if (!url) return null;
  return (
    <figure className="s-portrait">
      {/* eslint-disable-next-line @next/next/no-img-element -- a signed storage URL */}
      <img src={url} alt={image.alt} referrerPolicy="no-referrer" />
    </figure>
  );
}

/** #663: `vars` is the deck's theme with its own style directives on it, for a slide's `bg-color` to start from. */
type Look = { readonly format: SlideFormat; readonly logo: SlideLogo | null; readonly dark: boolean; readonly vars: ThemeVars };

function SlideView({ slide, total, look, play = false }: { slide: Slide; total: number; look: Look; play?: boolean }) {
  const parts = slideParts(slide);
  const hasBg = slide.background !== undefined;
  const logo = look.logo !== null && look.logo.placement !== "none" ? look.logo : null;
  // #663: a slide with its own `bg-color` takes its tone, and the colours that follow it, from that ground.
  const ground = slide.bgColor === undefined ? undefined : slideGroundVars(look.vars, slide.bgColor);
  const dark = ground === undefined ? look.dark : isDarkThemeVars(ground);
  const classes = slideClasses(slide, { format: look.format, dark, background: hasBg, ...(logo === null ? {} : { logo: logo.placement }) });
  return (
    <div className={`${styles.frame} ${look.format === "16:9" ? styles.landscape : styles.portrait}`}>
      <div className={[...classes, styles.fill, play ? "s-play" : ""].filter(Boolean).join(" ")} data-layout={slide.layout} style={ground as CSSProperties | undefined}>
        <div className="s-mesh" />
        {hasBg && <SlideBackground src={slide.background!} />}
        {!hasBg && hasDeco(slide.layout) && (
          <div className="s-deco" aria-hidden="true">
            <i className="d1" />
            <i className="d2" />
            <i className="d3" />
          </div>
        )}
        <div className="s-grain" />
        {!hidesIndex(slide.layout) && !hasBg && (
          <div className="s-index" aria-hidden="true">
            {slideIndexText(slide, parts)}
          </div>
        )}
        <div className="s-body">
          <SlideBody slide={slide} parts={parts} play={play} />
        </div>
        {slide.credit !== undefined && <div className="s-credit">{slide.credit}</div>}
        {logo !== null && <SlideLogoMark logo={logo} />}
        <div className="s-num">
          {slideNumber(slide.index + 1)}
          <span> / {slideNumber(total)}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * The current slide, and the one it replaced while the transition runs. The arriving slide is keyed by its
 * index, so its build-ins restart every time it arrives; the leaving one is dropped when its animation ends.
 */
function SlideStage({ deck, index, look, animate }: { deck: Deck; index: number; look: Look; animate: boolean }) {
  const [shown, setShown] = useState({ index, previous: null as number | null, direction: 1, arrived: false });
  if (shown.index !== index) setShown({ index, previous: shown.index, direction: index > shown.index ? 1 : -1, arrived: true });
  const entering = useRef<HTMLDivElement>(null);
  const leaving = useRef<HTMLDivElement>(null);
  const previous = animate && shown.previous !== null && shown.previous < deck.slides.length ? shown.previous : null;

  useLayoutEffect(() => {
    if (previous === null) return;
    const slide = deck.slides[shown.index];
    const frames = transitionFrames(slide === undefined ? "fade" : slideTransition(deck, slide), shown.direction);
    const timing: KeyframeAnimationOptions = { duration: SLIDE_TRANSITION_MS, easing: SLIDE_TRANSITION_EASING, fill: "both" };
    const arrive = frames.in.length === 0 ? undefined : entering.current?.animate(frames.in as Keyframe[], timing);
    const leave = frames.out.length === 0 ? undefined : leaving.current?.animate(frames.out as Keyframe[], timing);
    const done = () => setShown((s) => (s.previous === previous ? { ...s, previous: null } : s));
    let frame = 0;
    if (leave !== undefined) leave.onfinish = done;
    else frame = requestAnimationFrame(done);
    return () => {
      cancelAnimationFrame(frame);
      if (leave !== undefined) leave.onfinish = null;
      arrive?.finish();
    };
  }, [deck, previous, shown.index, shown.direction]);

  const slide = deck.slides[Math.min(shown.index, deck.slides.length - 1)]!;
  const total = deck.slides.length;
  return (
    <div className={styles.layers}>
      <div ref={entering} key={slide.index} className={styles.entering}>
        <SlideView slide={slide} total={total} look={look} play={animate && shown.arrived} />
      </div>
      {previous !== null && (
        <div ref={leaving} key={`leaving-${previous}`} className={styles.leaving} aria-hidden="true">
          <SlideView slide={deck.slides[previous]!} total={total} look={look} play={false} />
        </div>
      )}
    </div>
  );
}

/** #620: full screen — keys, swipes and clicks move through the deck; Esc (or leaving full screen) closes it. */
function PresentMode({
  deck,
  index,
  look,
  animate,
  theme,
  onMove,
  onClose,
}: {
  deck: Deck;
  index: number;
  look: Look;
  animate: boolean;
  theme: ThemeVars;
  onMove: (to: number) => void;
  onClose: () => void;
}) {
  const t = useTranslations("assistant");
  const root = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const total = deck.slides.length;
  const go = useCallback((to: number) => onMove(Math.max(0, Math.min(total - 1, to))), [onMove, total]);

  useEffect(() => {
    const element = root.current;
    element?.focus();
    element?.requestFullscreen?.().catch(() => undefined);
    const onFullscreen = () => {
      if (document.fullscreenElement === null) onClose();
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreen);
      if (document.fullscreenElement !== null) document.exitFullscreen().catch(() => undefined);
    };
  }, [onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(event.key)) go(index + 1);
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(event.key)) go(index - 1);
      else if (event.key === "Home") go(0);
      else if (event.key === "End") go(total - 1);
      else if (event.key === "Escape") onClose();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, index, onClose, total]);

  const onPointerDown = (event: ReactPointerEvent) => {
    pointer.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: ReactPointerEvent) => {
    const start = pointer.current;
    pointer.current = null;
    if (start === null || (event.target as HTMLElement).closest("button") !== null) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    // A swipe moves the way the finger went; a tap moves forward on the right and back on the left.
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) go(index + (dx < 0 ? 1 : -1));
    else if (Math.abs(dx) < 8 && Math.abs(dy) < 8) go(index + (event.clientX > window.innerWidth / 2 ? 1 : -1));
  };

  return createPortal(
    <div
      ref={root}
      className={styles.present}
      style={deckStyle(theme)}
      role="dialog"
      aria-modal="true"
      aria-label={t("slidesPresent")}
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <div className={`${styles.presentStage} ${look.format === "16:9" ? styles.presentLandscape : styles.presentPortrait}`} aria-live="polite">
        <SlideStage deck={deck} index={index} look={look} animate={animate} />
      </div>
      <div className={styles.presentBar}>
        <button type="button" className={styles.presentButton} onClick={() => go(index - 1)} disabled={index === 0} aria-label={t("slidesPrevious")}>
          ‹
        </button>
        <span className={styles.presentPosition}>{t("slidesPosition", { current: index + 1, total })}</span>
        <button type="button" className={styles.presentButton} onClick={() => go(index + 1)} disabled={index === total - 1} aria-label={t("slidesNext")}>
          ›
        </button>
        <span className={styles.presentHint}>{t("slidesPresentHint")}</span>
        <button type="button" className={styles.presentExit} onClick={onClose}>
          {t("slidesExitPresent")}
        </button>
      </div>
    </div>,
    document.body,
  );
}

export default function SlidesPreview({ source, theme: projectTheme, logo = null }: { source: string; theme: ThemeVars; logo?: SlideLogo | null }) {
  const t = useTranslations("assistant");
  const deck = useMemo(() => parseSlides(source), [source]);
  // #663: the deck's own palette, fonts and mode over the project's theme — `withDeckStyle` in the export.
  const theme = useMemo(() => withDeckStyleVars(projectTheme, deck.style), [projectTheme, deck.style]);
  const [current, setCurrent] = useState(0);
  const [presenting, setPresenting] = useState(false);
  const reducedMotion = useReducedMotion();
  const closePresent = useCallback(() => setPresenting(false), []);
  const total = deck.slides.length;
  const look: Look = useMemo(() => ({ format: deck.format ?? DEFAULT_SLIDE_FORMAT, logo, dark: isDarkThemeVars(theme), vars: theme }), [deck.format, logo, theme]);

  if (total === 0) return <p className={styles.empty}>{t("slidesEmpty")}</p>;
  // A revision can shorten the deck under the cursor; clamp rather than store a second copy of the index.
  const index = Math.min(current, total - 1);

  return (
    <div className={styles.deck} style={deckStyle(theme)}>
      {/* The slide design — a constant of this app, shared verbatim with the export (see slideDesign.ts). */}
      <style dangerouslySetInnerHTML={{ __html: SLIDE_DESIGN_CSS }} />
      <div className={styles.stage} aria-live="polite">
        <SlideStage deck={deck} index={index} look={look} animate={!reducedMotion} />
      </div>
      <div className={styles.nav}>
        <button type="button" className={styles.navButton} onClick={() => setCurrent(index - 1)} disabled={index === 0} aria-label={t("slidesPrevious")}>
          ‹
        </button>
        <span className={styles.position}>{t("slidesPosition", { current: index + 1, total })}</span>
        <button type="button" className={styles.navButton} onClick={() => setCurrent(index + 1)} disabled={index === total - 1} aria-label={t("slidesNext")}>
          ›
        </button>
        <button type="button" className={styles.presentOpen} onClick={() => setPresenting(true)}>
          {t("slidesPresent")}
        </button>
      </div>
      <div className={styles.thumbs} role="tablist" aria-label={t("slidesThumbnails")}>
        {deck.slides.map((s) => (
          <button
            key={s.index}
            type="button"
            role="tab"
            aria-selected={s.index === index}
            aria-label={t("slidesPosition", { current: s.index + 1, total })}
            className={s.index === index ? styles.thumbActive : styles.thumb}
            onClick={() => setCurrent(s.index)}
          >
            <SlideView slide={s} total={total} look={look} />
          </button>
        ))}
      </div>
      {presenting && <PresentMode deck={deck} index={index} look={look} animate={!reducedMotion} theme={theme} onMove={setCurrent} onClose={closePresent} />}
    </div>
  );
}
