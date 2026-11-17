"use client";

import type { CSSProperties } from "react";
import { useTranslations } from "next-intl";
import { isDark, themeVars, type LogoPlacement, type Theme } from "@/lib/projects/theme";
import styles from "./kitEditor.module.css";
import { TemplatePreviews } from "./TemplatePreviews";

/*
 * #595 — the kit editor's live previews.
 *
 * The server renderers in the agent service are the source of truth for what the assistant makes:
 * `render_post_template` (web/src/lib/projects/templates.tsx), `render_code_snippet`
 * (shareflow/src/adapters/web/code-snippet.ts), `render_diagram` (shareflow/src/adapters/web/diagram.ts,
 * mermaid `themeVariables`) and `generate_pdf` (shareflow/src/adapters/web/document.ts, `themedPrintCss`).
 * These are CSS/HTML mirrors of them, drawn from the same resolved theme through the same `--t-*` custom
 * properties — close enough to judge a kit by, never a promise of pixel equality. Change one side, check
 * the other.
 */

/** The window colours `render_code_snippet` uses for a themed image: a tuned dark or light set, by background. */
const CODE_PALETTE = {
  dark: { bg: "#1e1e2e", bar: "#181825", text: "#cdd6f4", dim: "#7f849c", k: "#cba6f7", s: "#a6e3a1", c: "#6c7086", n: "#fab387", f: "#89b4fa" },
  light: { bg: "#ffffff", bar: "#f3f4f6", text: "#1f2937", dim: "#6b7280", k: "#7c3aed", s: "#15803d", c: "#9ca3af", n: "#c2410c", f: "#1d4ed8" },
} as const;
/** The terminal frame's bar, always dark whatever the window below it (#595 part 2). */
const TERMINAL_BAR = "#0d1117";
/** The traffic lights on the window bar, as the renderer draws them. */
const MAC_DOTS = ["#ff5f57", "#febc2e", "#28c840"] as const;

const codeVars = (theme: Theme): Record<`--code-${string}`, string> => {
  const p = CODE_PALETTE[isDark(theme.palette.background) ? "dark" : "light"];
  return {
    "--code-bg": p.bg,
    "--code-bar": p.bar,
    "--code-text": p.text,
    "--code-dim": p.dim,
    "--code-k": p.k,
    "--code-s": p.s,
    "--code-c": p.c,
    "--code-n": p.n,
    "--code-f": p.f,
    "--code-term": TERMINAL_BAR,
    // The renderer clamps the window's corners to 4–24 px.
    "--code-radius": `${Math.max(4, Math.min(theme.radius, 24))}px`,
  };
};

/** The theme as inline custom properties — the only way its colours reach the previews. */
export const themeStyle = (theme: Theme): CSSProperties => themeVars(theme) as CSSProperties;

const LOGO_CLASS: Record<Exclude<LogoPlacement, "none">, string> = {
  "top-left": styles.logoTopLeft!,
  "top-right": styles.logoTopRight!,
  "bottom-left": styles.logoBottomLeft!,
  "bottom-right": styles.logoBottomRight!,
};

/** A ratio like "4:5" as a CSS aspect-ratio; the feed shape when none is set. */
const aspect = (ratio: string | undefined): string => {
  const m = ratio === undefined ? null : /^(\d{1,2}):(\d{1,2})$/.exec(ratio);
  return m === null || Number(m[1]) === 0 || Number(m[2]) === 0 ? "4 / 5" : `${m[1]} / ${m[2]}`;
};

/** A preset's card in the gallery: a thumbnail drawn in its own palette, fonts and radius. */
export function PresetMini({ theme }: { theme: Theme }) {
  return (
    <span className={styles.mini} style={themeStyle(theme)} aria-hidden="true">
      <span className={styles.miniHeading}>Aa</span>
      <span className={styles.miniLine} />
      <span className={styles.miniRow}>
        <span className={styles.miniButton}>Aa</span>
        <span className={styles.miniDot} />
        <span className={styles.miniSurface} />
      </span>
    </span>
  );
}

export function KitPreviews({ theme, ratio, logoUrl }: { theme: Theme; ratio: string | undefined; logoUrl: string | null }) {
  const t = useTranslations("assistant.projects.kit");
  const shape = { aspectRatio: aspect(ratio) };
  const logo =
    logoUrl === null || theme.logoPlacement === "none" ? null : (
      // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed storage URL
      <img className={`${styles.logo} ${LOGO_CLASS[theme.logoPlacement]}`} src={logoUrl} alt="" />
    );
  const arrow = (
    <svg className={styles.flowArrow} viewBox="0 0 26 12" aria-hidden="true">
      <path d="M1 6h18" />
      <path className={styles.flowArrowHead} d="M18 1.5 25 6l-7 4.5z" />
    </svg>
  );

  return (
    <section className={styles.previews} style={{ ...themeStyle(theme), ...codeVars(theme) } as CSSProperties} aria-label={t("preview")}>
      <div className={styles.sectionHead}>
        <span className={styles.fieldLabel}>{t("preview")}</span>
      </div>
      <p className={styles.hint}>{t("previewHint")}</p>

      <div className={styles.previewGrid}>
        <figure className={styles.previewCard}>
          <div className={`${styles.post} ${logo === null ? "" : theme.logoPlacement.startsWith("top") ? styles.postLogoTop : styles.postLogoBottom}`} style={shape}>
            <span className={styles.postBar} />
            <span className={styles.postQuote}>“{t("sample.quote")}”</span>
            <span className={styles.postFoot}>{t("sample.author")}</span>
            {logo}
          </div>
          <figcaption className={styles.previewLabel}>{t("previewPost")}</figcaption>
        </figure>

        <figure className={styles.previewCard}>
          <div className={styles.slide} style={shape}>
            <span className={styles.slideKicker}>{t("sample.slideKicker")}</span>
            <span className={styles.slideTitle}>{t("sample.slideTitle")}</span>
            <span className={styles.slideBody}>{t("sample.slideBody")}</span>
            <span className={styles.slideDots} aria-hidden="true">
              <span className={styles.slideDot} />
              <span className={`${styles.slideDot} ${styles.slideDotOn}`} />
              <span className={styles.slideDot} />
              <span className={styles.slideDot} />
            </span>
          </div>
          <figcaption className={styles.previewLabel}>{t("previewSlide")}</figcaption>
        </figure>

        <figure className={`${styles.previewCard} ${styles.previewWide}`}>
          <article className={styles.doc}>
            <div className={styles.docRule} />
            <h4 className={styles.docTitle}>{t("sample.docTitle")}</h4>
            <p className={styles.docText}>{t("sample.docIntro")}</p>
            <h5 className={styles.docHeading}>{t("sample.docHeading")}</h5>
            <ul className={styles.docList}>
              <li>{t("sample.docBullet1")}</li>
              <li>{t("sample.docBullet2")}</li>
              <li>{t("sample.docBullet3")}</li>
            </ul>
          </article>
          <figcaption className={styles.previewLabel}>{t("previewDocument")}</figcaption>
        </figure>

        <figure className={`${styles.previewCard} ${styles.previewWide}`}>
          <div className={styles.codeFrame}>
            <div className={styles.codeWindow}>
              <div className={styles.codeBar}>
                {MAC_DOTS.map((color) => (
                  <span key={color} className={styles.codeDot} style={{ background: color }} />
                ))}
                <span className={styles.codeTitle}>launch.ts</span>
              </div>
              {/* A fixed sample, highlighted by hand in the renderer's classes. */}
              <pre className={styles.codeBody}>
                <span className={styles.codeC}>{"// schedule the launch post"}</span>
                {"\n"}
                <span className={styles.codeK}>const</span> post = <span className={styles.codeK}>await</span> <span className={styles.codeF}>schedule</span>({"{"}
                {"\n  "}text: <span className={styles.codeS}>{"\"We're live!\""}</span>,{"\n  "}at: <span className={styles.codeN}>9</span>,{"\n"}
                {"});"}
              </pre>
            </div>
          </div>
          <figcaption className={styles.previewLabel}>{t("previewCode")}</figcaption>
        </figure>

        <figure className={`${styles.previewCard} ${styles.previewWide}`}>
          <div className={styles.flow} role="img" aria-label={[t("sample.flowIdea"), t("sample.flowDraft"), t("sample.flowReview"), t("sample.flowPublish")].join(" → ")}>
            <span className={styles.flowNode}>{t("sample.flowIdea")}</span>
            {/* Each arrow travels with the node it points at, so a narrow card never wraps an arrow alone. */}
            <span className={styles.flowStep}>
              {arrow}
              <span className={styles.flowNode}>{t("sample.flowDraft")}</span>
            </span>
            <span className={styles.flowStep}>
              {arrow}
              <span className={`${styles.flowNode} ${styles.flowDecision}`}>{t("sample.flowReview")}</span>
            </span>
            <span className={styles.flowStep}>
              {arrow}
              <span className={`${styles.flowNode} ${styles.flowEnd}`}>{t("sample.flowPublish")}</span>
            </span>
          </div>
          <figcaption className={styles.previewLabel}>{t("previewDiagram")}</figcaption>
        </figure>
      </div>

      <TemplatePreviews />
    </section>
  );
}
