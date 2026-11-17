/**
 * Document templates — #595 part 2. A one-pager, a report, a brief, a checklist and a campaign plan, each a
 * layer of CSS and a little HTML over the one print pipeline (`document.ts`): the same markdown prints in any
 * of them, in the project's theme, with a themed header (the logo when the project has one) and a footer that
 * numbers the pages.
 *
 * Pure, like the rest of the document builder, so what is printed is tested without a browser.
 *
 * ## Page numbers are Chromium's own
 *
 * The footer is a CSS page-margin box (`@page { @bottom-right { content: counter(page) } }`), which Chromium
 * prints since 131 — measured against the render image's Chromium, 2026-09-28: the counter prints, and the
 * page background reaches into the margin, so a dark theme stays dark to the paper's edge. A template page
 * therefore keeps a printed margin (room for the footer, and a top on page two) where the plain themed page
 * pads its body instead. The CSS margin wins over the printer's (`render.ts` passes none for a themed page).
 */

import { contrastRatio, fontStack, readableOn, type Theme } from "../../design/theme.js";

export const DOCUMENT_TEMPLATES = ["one-pager", "report", "brief", "checklist", "campaign-plan"] as const;
export type DocumentTemplate = (typeof DOCUMENT_TEMPLATES)[number];

export const DOCUMENT_TEMPLATE_LABELS: Readonly<Record<DocumentTemplate, string>> = {
  "one-pager": "One-pager",
  report: "Report",
  brief: "Brief",
  checklist: "Checklist",
  "campaign-plan": "Campaign plan",
};

/** In a template's CSS, so the printer honours the page size it sets (`render.ts`) — a campaign plan is landscape. */
export const TEMPLATE_MARKER = "/* chorus:template */";

export const isDocumentTemplate = (value: unknown): value is DocumentTemplate =>
  typeof value === "string" && (DOCUMENT_TEMPLATES as readonly string[]).includes(value);

/**
 * A template named inside a markdown document — `<!-- template: report -->` — so a document made with
 * `create_artifact` prints in its template wherever it is printed, as a deck's `<!-- format -->` does.
 */
export const documentTemplateDirective = (source: string): DocumentTemplate | undefined => {
  const m = /<!--\s*template\s*:\s*([a-z-]+)\s*-->/i.exec(source);
  const name = m?.[1]?.toLowerCase();
  return isDocumentTemplate(name) ? name : undefined;
};

/** Text for a CSS string: no quote, backslash or line break can end it early. */
const cssString = (text: string): string => `"${text.replace(/["\\\n\r]/g, " ").slice(0, 80)}"`;

const escape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Only an inlined image may be a logo — the print page refuses every request, and a URL would print as nothing. */
export const safeLogo = (logo: string | undefined): string | undefined =>
  logo !== undefined && /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(logo) ? logo : undefined;

/** The first theme colour that reads on `ground` as text — the same rule the themed headings follow. */
const readable = (ground: string, ...candidates: string[]): string =>
  candidates.find((c) => contrastRatio(c, ground) >= 4.5) ?? readableOn(ground);

/** The page box: size, margins that leave room for the footer, and the footer itself. */
const pageCss = (template: DocumentTemplate, theme: Theme, title: string | undefined): string => {
  const size = template === "campaign-plan" ? "A4 landscape" : "A4";
  const footerFont = `9pt/1.2 ${fontStack(theme.fonts.body)}`;
  const footer = `font: ${footerFont}; color: ${theme.palette.muted};`;
  const left = title === undefined ? "" : `@bottom-left { content: ${cssString(title)}; ${footer} text-align: left; }`;
  // The report's cover carries no footer: a number on a cover reads as a mistake.
  // The cover fills its page edge to edge: no margin, so no footer box either.
  const cover = template === "report" ? "@page :first { margin: 0; @bottom-left { content: none; } @bottom-right { content: none; } }" : "";
  return `
  ${TEMPLATE_MARKER}
  @page {
    size: ${size};
    margin: 14mm 16mm 16mm 16mm;
    background: ${theme.palette.background};
    @bottom-right { content: counter(page) " / " counter(pages); ${footer} text-align: right; }
    ${left}
  }
  ${cover}
  body { padding: 0; }
  `;
};

/** The shared header band: logo, title and the template's name, over a themed rule. */
const headerCss = (theme: Theme): string => {
  const p = theme.palette;
  return `
  .t-head { display: flex; align-items: center; gap: 14px; padding: 0 0 12px; margin: 0 0 20px; border-bottom: 3px solid var(--t-accent); break-inside: avoid; }
  .t-head .t-logo { height: 40px; width: auto; max-width: 140px; object-fit: contain; }
  .t-head .t-titles { flex: 1; min-width: 0; }
  .t-head .t-label { font: 600 8.5pt/1.2 var(--t-font-body); letter-spacing: .12em; text-transform: uppercase; color: ${readable(p.background, p.accent, p.muted)}; }
  .t-head .t-title { font: 700 20pt/1.15 var(--t-font-heading); color: ${readable(p.background, p.primary, p.accent)}; margin: 2px 0 0; padding: 0; border: 0; }
  `;
};

const TEMPLATE_CSS: Readonly<Record<DocumentTemplate, (theme: Theme) => string>> = {
  // Compact: one sheet's worth, the section heads as small labels.
  "one-pager": (theme) => `
  body { font-size: 10pt; line-height: 1.45; }
  h2 { font-size: 10.5pt; letter-spacing: .08em; text-transform: uppercase; color: ${readable(theme.palette.background, theme.palette.accent, theme.palette.primary)}; margin: 1.1em 0 .35em; padding-bottom: .2em; border-bottom: 1px solid var(--t-muted); }
  h3 { font-size: 10.5pt; margin: .9em 0 .3em; }
  p, ul, ol { margin: .35em 0 .6em; }
  li { margin: .15em 0; }
  `,
  // A cover block, then numbered sections.
  report: (theme) => `
  .t-cover { display: flex; flex-direction: column; justify-content: space-between; height: 296mm; margin: 0; padding: 26mm 22mm; background: var(--t-primary); color: var(--t-on-primary); break-after: page; page-break-after: always; }
  .t-cover .t-logo { height: 56px; width: auto; max-width: 200px; object-fit: contain; align-self: flex-start; }
  .t-cover .t-label { font: 600 10pt/1.2 var(--t-font-body); letter-spacing: .16em; text-transform: uppercase; opacity: .85; }
  .t-cover .t-title { font: 700 34pt/1.1 var(--t-font-heading); margin: 10px 0 0; padding: 0; border: 0; color: var(--t-on-primary); }
  .t-cover .t-bar { width: 72px; height: 6px; margin-top: 18px; border-radius: var(--t-radius); background: var(--t-accent); }
  body { counter-reset: t-section; }
  .t-body h2 { counter-increment: t-section; padding-top: .6em; border-top: 1px solid var(--t-muted); }
  .t-body h2::before { content: counter(t-section, decimal-leading-zero) "  "; color: ${readable(theme.palette.background, theme.palette.accent, theme.palette.muted)}; }
  `,
  // A lead summary and labelled sections.
  brief: (theme) => `
  .t-body > p:first-child, .t-body > blockquote:first-child { font-size: 12.5pt; line-height: 1.5; margin: 0 0 1.2em; padding: 12px 16px; background: var(--t-surface); border-left: 4px solid var(--t-accent); border-radius: var(--t-radius); color: var(--t-text); }
  h2 { font-size: 10pt; letter-spacing: .1em; text-transform: uppercase; color: ${readable(theme.palette.background, theme.palette.primary, theme.palette.accent)}; margin: 1.4em 0 .4em; padding-left: 10px; border-left: 3px solid var(--t-primary); }
  `,
  // Every list item a box to tick; `[x]` items ticked.
  checklist: (theme) => `
  .t-body ul { list-style: none; padding-left: 0; }
  .t-body ul li { position: relative; padding: 7px 10px 7px 36px; margin: 6px 0; background: var(--t-surface); border-radius: var(--t-radius); break-inside: avoid; }
  .t-body ul li::before { content: ""; position: absolute; left: 10px; top: 8px; width: 14px; height: 14px; border: 2px solid var(--t-primary); border-radius: 3px; background: var(--t-bg); }
  .t-body ul li.t-done { color: var(--t-muted); text-decoration: line-through; }
  .t-body ul li.t-done::before { background: var(--t-primary); }
  .t-body ul li.t-done::after { content: "\\2713"; position: absolute; left: 12.5px; top: 6px; font: 700 12px/18px sans-serif; color: ${theme.onPrimary}; }
  h2 { margin-top: 1.3em; }
  `,
  // Landscape, and built for tables: filled header row, banded rows, phases as bands.
  "campaign-plan": (theme) => `
  body { font-size: 10pt; }
  table { font-size: 9.5pt; margin: .6em 0 1.2em; border-radius: var(--t-radius); overflow: hidden; }
  th { background: var(--t-primary); color: var(--t-on-primary); border-color: var(--t-primary); font-family: var(--t-font-heading); }
  td { border-color: ${theme.palette.surface}; vertical-align: top; }
  tr:nth-child(even) td { background: var(--t-surface); }
  h2 { font-size: 13pt; margin: 1.2em 0 .5em; padding: 6px 12px; background: var(--t-surface); border-left: 4px solid var(--t-accent); border-bottom: 0; border-radius: var(--t-radius); }
  `,
};

/** The template's CSS, after the print and theme CSS so it wins. */
export const documentTemplateCss = (template: DocumentTemplate, theme: Theme, title?: string): string =>
  pageCss(template, theme, title) + headerCss(theme) + TEMPLATE_CSS[template](theme);

/** The top of the first page: the report's cover, or the header band every other template opens with. */
export const documentTemplateHeader = (template: DocumentTemplate, input: { readonly title?: string; readonly logo?: string }): string => {
  const logo = safeLogo(input.logo);
  const img = logo === undefined ? "" : `<img class="t-logo" src="${escape(logo)}" alt="">`;
  const title = input.title === undefined ? "" : `<h1 class="t-title">${escape(input.title)}</h1>`;
  const label = `<div class="t-label">${DOCUMENT_TEMPLATE_LABELS[template]}</div>`;
  if (template === "report") {
    return `<section class="t-cover">${img === "" ? "<div></div>" : img}<div>${label}${title}<div class="t-bar"></div></div></section>`;
  }
  return `<header class="t-head">${img}<div class="t-titles">${label}${title}</div></header>`;
};

/**
 * `- [ ]` and `- [x]` items as boxes to tick. CommonMark has no task lists, so the marker arrives as the
 * item's first text; it is taken off and becomes the item's state.
 */
export const checklistItems = (html: string): string =>
  html.replace(/<li>(\s*(?:<p>)?)\[( |x|X)\]\s*/g, (_m, lead: string, mark: string) => `<li${mark === " " ? "" : ' class="t-done"'}>${lead}`);

/**
 * The document's own opening `# Title`, taken out of the body when it would repeat the header — a
 * template prints the title once, in the header.
 */
export const takeLeadingTitle = (body: string): { readonly title?: string; readonly body: string } => {
  // Leading comments first: production, 2026-09-29, `<!-- template: checklist -->` above `# Title` left the title
  // printed twice — in the header and again as the body's first heading.
  const m = /^((?:\s*<!--[\s\S]*?-->)*)\s*<h1>([\s\S]*?)<\/h1>\s*/.exec(body);
  if (m === null) return { body };
  const text = (m[2] ?? "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  return text === "" ? { body } : { title: text, body: (m[1] ?? "") + body.slice(m[0].length) };
};

/** Whether two titles name the same thing — case, spacing and a trailing "PDF" or "document" aside. */
export const sameTitle = (a: string, b: string): boolean => {
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").replace(/\s*\b(pdf|document|doc)\b\s*$/i, "").trim();
  return norm(a) === norm(b);
};
