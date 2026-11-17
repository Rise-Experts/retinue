/**
 * The printable document: one HTML pipeline for every input.
 *
 * The old renderer's first sentence is the design, and it is worth keeping: *"ONE PIPELINE FOR EVERY
 * INPUT: whatever comes in becomes HTML, and Chromium prints that HTML to PDF. Markdown gets converted,
 * plain text gets wrapped in a `<pre>`, images become a page each, and HTML passes through. A second
 * code path per input type would mean four sets of pagination and font bugs instead of one."*
 *
 * ## Diagrams are part of the document, not an attached image
 *
 * The feature this pipeline exists to make possible: a ```mermaid fence becomes `<pre class="mermaid">`
 * and mermaid renders it to inline SVG *in the print page*. Because the path is already HTML → Chromium,
 * *"the vector survives, so there is no rasterisation, no PNG, and no storage round-trip: the diagram is
 * sharp at any zoom and its text is selectable. Before this, a fence printed as literal source and the
 * only workaround was exporting a PNG and passing it as kind='media' — one image per page, prose
 * discarded, so a diagram inside a section was impossible."*
 *
 * Separated from the rendering, for the reason the old file gives: *"the conversion rules are testable
 * without a browser — the part most likely to be wrong is what HTML we build, not whether Chromium can
 * print it."*
 */

import { AgentPlatformError } from "@retinue/agentkit";

import { contrastRatio, resolveTheme, themeCss, type Theme } from "../../design/theme.js";
import {
  checklistItems,
  documentTemplateCss,
  documentTemplateDirective,
  documentTemplateHeader,
  isDocumentTemplate,
  sameTitle,
  takeLeadingTitle,
  type DocumentTemplate,
} from "./document-templates.js";
import { MERMAID_CONFIG_JS, escapeHtml, mermaidThemeScript, repairMermaidLabels } from "./diagram.js";

/** The kinds of content that can become a PDF. */
export const PDF_KINDS = ["text", "markdown", "html", "media"] as const;
export type PdfKind = (typeof PDF_KINDS)[number];

/** *"Chromium layout time grows with content, and a 5 MB HTML document is a mistake rather than a request."* */
export const MAX_DOCUMENT_CHARS = 500_000;
/** How many images a `media` document may hold. One page each, so this is a page count too. */
export const MAX_DOCUMENT_IMAGES = 30;

/**
 * The class mermaid finds its input by, and the marker the detector looks for.
 *
 * One constant, *"so the CSS, the renderer and the detector cannot drift"*.
 */
export const DIAGRAM_CLASS = "mermaid";

/**
 * Print styling, and every rule in it is deliberate.
 *
 * *"Deliberately minimal and self-contained — no webfonts, because a font fetch from inside the
 * container would either hang or silently fall back, and either way the output must be deterministic."*
 * The page this renders in also refuses off-host requests, so a webfont would simply not arrive.
 *
 * The `pre.mermaid` block undoes the code-block styling for a figure — a diagram in a grey card with
 * monospace padding is wrong — and its `break-inside: avoid` is there for *"two real print failures: a
 * diagram sliced in half by a page break, and an SVG wider than the text column being clipped at the
 * margin."*
 */
export const PRINT_CSS = `
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font: 11pt/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
          "Helvetica Neue", Arial, sans-serif;
    color: #111;
    margin: 0;
  }
  h1, h2, h3 { line-height: 1.25; margin: 1.2em 0 0.5em; }
  /* Production, 2026-09-28: "Measurement" printed alone at the foot of page 1, its paragraphs on page 2. */
  h1, h2, h3 { break-after: avoid; page-break-after: avoid; }
  h1 { font-size: 20pt; }
  h2 { font-size: 15pt; }
  h3 { font-size: 12.5pt; }
  p, li { orphans: 3; widows: 3; }
  pre {
    white-space: pre-wrap;
    word-break: break-word;
    font: 9.5pt/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: #f6f6f7;
    padding: 10px 12px;
    border-radius: 6px;
  }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; }
  .media-page { page-break-after: always; text-align: center; }
  .media-page:last-child { page-break-after: auto; }
  tr, img { page-break-inside: avoid; }
  pre.mermaid {
    background: none;
    padding: 0;
    margin: 1.4em 0;
    text-align: center;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  pre.mermaid svg { max-width: 100%; height: auto; }
`;

/**
 * The project's theme over the print styling — #595: its fonts (installed in the image, so they arrive
 * with no fetch), its colours, headings in the heading font and primary colour, and a themed rule across
 * the top of the document. After `PRINT_CSS`, so it wins; the layout rules are untouched.
 */
/**
 * Headings in the first theme colour that reads on the background — primary, then accent, then the text colour.
 * Production, 2026-09-28: dark-tech's #7B2FF7 headings on #170922 are 3.3:1 and read as dim; an h3 is not
 * large text, so the bar is WCAG's 4.5:1 for normal text.
 */
export const headingColor = (theme: Theme): string =>
  [theme.palette.primary, theme.palette.accent].find((c) => contrastRatio(c, theme.palette.background) >= 4.5) ?? theme.palette.text;

/*
 * The whole page in the theme's background. Production, 2026-09-28: the dark theme printed as a dark block
 * inside white margins, with the text against the block's edge — print margins are never painted. So a themed
 * page has no printed margin (render.ts reads @page), and the body carries the margin as padding, cloned onto
 * every page so page two keeps its top and sides.
 */
/** In a themed document's CSS, so the printer knows to leave the margin to the body (`render.ts`). */
export const FULL_BLEED_MARKER = "/* chorus:full-bleed */";

export const themedPrintCss = (theme: Theme): string =>
  themeCss(theme) +
  `
  ${FULL_BLEED_MARKER}
  @page { size: A4; margin: 0; }
  html, body { background: var(--t-bg); }
  body { font-family: var(--t-font-body); color: var(--t-text); padding: 18mm 16mm; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
  h1, h2, h3 { font-family: var(--t-font-heading); color: ${headingColor(theme)}; }
  h1 { padding-bottom: 0.3em; border-bottom: 2px solid var(--t-accent); }
  a { color: var(--t-accent); }
  blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid var(--t-accent); color: var(--t-muted); }
  pre { background: var(--t-surface); border-radius: var(--t-radius); }
  th { background: var(--t-surface); }
  th, td { border-color: var(--t-muted); }
  .t-rule { height: 6px; margin: 0 0 18px; border-radius: var(--t-radius); background: linear-gradient(90deg, var(--t-primary), var(--t-accent)); }
  pre.mermaid { background: none; }
`;

/**
 * #615: the project's logo at the top of the document, on the side of the theme's corner (a bottom corner
 * reads as the same side of the header — a document's header is where a letterhead puts it).
 */
export const LOGO_HEADER_CSS = `
  .t-head { display: flex; margin: 0 0 12px; }
  .t-head.right { justify-content: flex-end; }
  .t-logo { max-height: 40px; max-width: 180px; object-fit: contain; }
`;

const logoHeader = (logo: string | undefined, theme: Theme | undefined): string => {
  if (logo === undefined) return "";
  const placement = theme?.logoPlacement ?? "top-right";
  if (placement === "none") return "";
  return `<div class='t-head${placement.endsWith("right") ? " right" : ""}'><img class='t-logo' src="${escapeHtml(logo)}" alt=''></div>`;
};

const document_ = (body: string, title?: string, theme?: Theme, logo?: string): string =>
  "<!doctype html><html><head><meta charset='utf-8'>" +
  `<title>${escapeHtml(title ?? "Document")}</title><style>${PRINT_CSS}${theme === undefined ? "" : themedPrintCss(theme)}${logo === undefined ? "" : LOGO_HEADER_CSS}</style>` +
  mermaidThemeScript(theme) +
  "</head><body>" +
  logoHeader(logo, theme) +
  (theme === undefined ? "" : "<div class='t-rule'></div>") +
  body +
  "</body></html>";

/**
 * #615: every image a markdown document names by `chorus-media:` reference or https URL, in order and once
 * each — what the caller reads and inlines, because the print page makes no requests.
 */
export const markdownImageSources = (source: string): string[] => {
  const seen = new Set<string>();
  for (const match of source.matchAll(/!\[[^\]]*\]\(\s*<?((?:chorus-media:|https:\/\/)[^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    if (match[1] !== undefined) seen.add(match[1]);
  }
  return [...seen];
};

/** Images the caller inlined replace their sources; any other workspace or web image becomes its alt text. */
const inlineMarkdownImages = (source: string, images: Readonly<Record<string, string>>): string =>
  source.replace(/!\[([^\]]*)\]\(\s*<?((?:chorus-media:|https:\/\/)[^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_all, alt: string, src: string) =>
    images[src] !== undefined ? `![${alt}](${images[src]})` : alt.trim() === "" ? "" : `*${alt}*`,
  );

/**
 * A templated document — #595 part 2: the themed page with the template's CSS over it, its header (or the
 * report's cover) in place of the plain rule, and the body in `.t-body` so a template can style its opening.
 * Outside a project the template is drawn in the Minimal theme, since every template needs colours.
 */
const templatedDocument_ = (body: string, template: DocumentTemplate, input: { readonly title?: string; readonly theme?: Theme; readonly logo?: string }): string => {
  const theme = input.theme ?? resolveTheme(undefined);
  const inner = template === "checklist" ? checklistItems(body) : body;
  return (
    "<!doctype html><html><head><meta charset='utf-8'>" +
    `<title>${escapeHtml(input.title ?? "Document")}</title><style>${PRINT_CSS}${themedPrintCss(theme)}${documentTemplateCss(template, theme, input.title)}</style>` +
    mermaidThemeScript(theme) +
    `</head><body data-template='${template}'>` +
    documentTemplateHeader(template, { ...(input.title === undefined ? {} : { title: input.title }), ...(input.logo === undefined ? {} : { logo: input.logo }) }) +
    `<div class='t-body'>${inner}</div>` +
    "</body></html>"
  );
};

/**
 * Markdown to HTML, with ```mermaid fences turned into render targets.
 *
 * **Why the fence rule**, in the old file's words: *"by default a ```mermaid fence renders as
 * `<pre><code class="language-mermaid">`, and Chromium prints that as the diagram's SOURCE TEXT — which
 * is exactly what it did."*
 *
 * The source is repaired **here**, so the string mermaid parses is the string that was embedded. An
 * empty fence is left as ordinary content: *"an empty fence would make `mermaid.parse()` fail and take
 * the entire document down with it."*
 */
export const markdownToHtml = async (source: string): Promise<string> => renderMarkdown(source, "document");

/**
 * Markdown to HTML for a slide — #666: the markdown the panel previews (react-markdown with remark-gfm and
 * `skipHtml`, `web/src/lib/assistant/slideMarkdown.tsx`) and the markdown the PDF, the carousel and the video
 * print must be the same markdown. Production, 2026-09-30 (F17): raw HTML in a slide rendered in the export
 * but not in the panel, and task lists and strikethrough rendered in the panel but not in the export.
 *
 * - **Task lists** (`- [x] done`) print as a disabled checkbox, in remark-gfm's markup.
 * - **Strikethrough** (`~~old~~`) prints as `<del>`, remark-gfm's element rather than markdown-it's `<s>`.
 * - **Raw HTML is stripped** — the issue's default decision. A slide is styled by the deck's directives and
 *   the theme, never by markup in it; a `<div style>` the panel cannot show is a slide that prints
 *   differently from its preview. An HTML block disappears; inline tags go and the text between them stays.
 *
 * A web test and a shareflow test run the two renderers over one fixture
 * (`__tests__/slide-markdown-fixture.ts`), so the parity is checked on both sides.
 */
export const slideMarkdownToHtml = async (source: string): Promise<string> => renderMarkdown(source, "slide");

/**
 * #666: a GFM task-list item, as remark-gfm reads it — `[ ]`, `[x]` or `[X]` opening a list item's first
 * paragraph, followed by whitespace and some content. A bare `- [x]` is not a task.
 */
const TASK_MARKER = /^\[([ xX])\][ \t]+(?=\S)/;

type MarkdownItModule = typeof import("markdown-it");
type MarkdownItInstance = InstanceType<MarkdownItModule["default"]>;

/** #666: the core rule that turns a list item's leading `[x] ` into a checkbox token, before inline parsing. */
const taskLists = (md: MarkdownItInstance): void => {
  md.core.ruler.after("block", "task_lists", (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i];
      if (inline?.type !== "inline" || tokens[i - 1]?.type !== "paragraph_open" || tokens[i - 2]?.type !== "list_item_open") continue;
      const m = TASK_MARKER.exec(inline.content);
      if (m === null) continue;
      inline.content = inline.content.slice(m[0].length);
      const checkbox = new state.Token("task_checkbox", "input", 0);
      checkbox.meta = { checked: (m[1] ?? " ") !== " " };
      tokens.splice(i, 0, checkbox);
      tokens[i - 2]?.attrJoin("class", "task-list-item");
      // The list that holds it: the nearest list opener at this item's level, walking back.
      const level = tokens[i - 2]?.level ?? 0;
      for (let j = i - 3; j >= 0; j--) {
        const t = tokens[j];
        if ((t?.type === "bullet_list_open" || t?.type === "ordered_list_open") && t.level === level - 1) {
          if (!(t.attrGet("class") ?? "").includes("contains-task-list")) t.attrJoin("class", "contains-task-list");
          break;
        }
      }
      i += 1;
    }
  });
  md.renderer.rules["task_checkbox"] = (tokens, index) =>
    `<input type="checkbox" disabled=""${(tokens[index]?.meta as { checked?: boolean } | undefined)?.checked === true ? ' checked=""' : ""}/> `;
};

const renderMarkdown = async (source: string, flavour: "document" | "slide"): Promise<string> => {
  try {
    const { default: MarkdownIt } = await import("markdown-it");
    const md = new MarkdownIt("commonmark", { linkify: true }).enable("table");
    if (flavour === "slide") {
      md.enable(["strikethrough", "linkify"]);
      md.renderer.rules.s_open = () => "<del>";
      md.renderer.rules.s_close = () => "</del>";
      md.renderer.rules.html_block = () => "";
      md.renderer.rules.html_inline = () => "";
      taskLists(md);
    }
    const defaultFence = md.renderer.rules.fence;
    md.renderer.rules.fence = (tokens, index, options, env, self) => {
      const token = tokens[index];
      if ((token?.info ?? "").trim().toLowerCase() !== DIAGRAM_CLASS) {
        return defaultFence?.(tokens, index, options, env, self) ?? "";
      }
      const repaired = repairMermaidLabels((token?.content ?? "").trim());
      if (repaired === "") return defaultFence?.(tokens, index, options, env, self) ?? "";
      return `<pre class="${DIAGRAM_CLASS}">${escapeHtml(repaired)}</pre>\n`;
    };
    return md.render(source);
  } catch {
    /**
     * *"A missing optional dependency should degrade to an ugly-but-correct PDF rather than failing the
     * user's request."* The markdown arrives as preformatted text: readable, complete, and obviously
     * not rendered.
     */
    return `<pre>${escapeHtml(source)}</pre>`;
  }
};

/**
 * Whether a built document has anything mermaid needs to render.
 *
 * Lets the renderer *"pay for the bundle injection and the render wait only when a document actually has
 * a diagram — the common case is a plain report."* Matching on the marker class also covers a diagram
 * the model supplied directly as `kind: "html"`, which never went through the fence rule.
 */
export const documentHasDiagrams = (html: string): boolean => html.includes(`class="${DIAGRAM_CLASS}"`);

const invalid = (message: string) =>
  new AgentPlatformError({ code: "invalid_input", message, retryable: false });

/**
 * The pages a document can print on — #661.
 *
 * Production, 2026-09-30: `generate_pdf(kind: html, format: "16:9")` printed portrait A4 and cropped every 1920px
 * slide on the right, because `format` belonged to slides alone and a document had exactly one page — A4 with
 * fixed margins. In CSS pixels (96 per inch); 16:9 and 4:5 are the slide sizes (`SLIDE_FORMATS`), so a deck written
 * as HTML at 1920×1080 lands one slide per page with nothing cut off.
 */
export const PAGE_SIZES = {
  A4: { width: 794, height: 1123, css: "A4" },
  Letter: { width: 816, height: 1056, css: "letter" },
  "16:9": { width: 1920, height: 1080, css: undefined },
  "4:5": { width: 1080, height: 1350, css: undefined },
} as const;
export type PageSizeId = keyof typeof PAGE_SIZES;
export const PAGE_SIZE_IDS = Object.keys(PAGE_SIZES) as readonly PageSizeId[];
export const PAGE_ORIENTATIONS = ["portrait", "landscape"] as const;
export type PageOrientation = (typeof PAGE_ORIENTATIONS)[number];

/** The widest margin a page may ask for, in millimetres — more leaves no page to print on. */
export const MAX_PAGE_MARGIN_MM = 50;
/** #661: page numbers print in the bottom margin, so a page that asks for them keeps at least this much there. */
export const PAGE_NUMBER_MARGIN_MM = 12;
/** The document margins every plain page has had since the first renderer — `PRINT_CSS`'s `@page`. */
const DEFAULT_SIDE_MARGIN_MM = 16;

export type PageSetup = {
  readonly page?: PageSizeId;
  readonly orientation?: PageOrientation;
  /** Every side, in millimetres. 0 is full-bleed: the page's background reaches the paper's edge. */
  readonly margin?: number;
  readonly pageNumbers?: boolean;
};

const MM_PX = 96 / 25.4;

/** A slide format is a screen, not paper: it is landscape-or-portrait by its own shape, and has no margin by default. */
const isScreenPage = (page: PageSizeId | undefined): boolean => page === "16:9" || page === "4:5";

/**
 * The page box in CSS pixels, turned for the orientation — absent when nothing was asked of the page size. A4 and
 * Letter are portrait unless told otherwise; 16:9 is landscape and 4:5 portrait by shape.
 */
export const pageBoxOf = (setup: PageSetup): { readonly width: number; readonly height: number } | undefined => {
  if (setup.page === undefined && setup.orientation === undefined) return undefined;
  const size = PAGE_SIZES[setup.page ?? "A4"];
  const naturallyLandscape = size.width > size.height;
  const turn = setup.orientation !== undefined && (setup.orientation === "landscape") !== naturallyLandscape;
  return turn ? { width: size.height, height: size.width } : { width: size.width, height: size.height };
};

/**
 * The width the content is laid out in — the page less its side margins — for the renderer's measurement (#660).
 * Undefined when nothing about the page was asked, so the renderer keeps the width it has always measured against.
 * A margin that was not given is the slide formats' 0 or the document default; an HTML page's own `@page` margin
 * can still differ, which only shifts the overflow measurement, never the print.
 */
export const layoutWidthOf = (setup: PageSetup): number | undefined => {
  const box = pageBoxOf(setup);
  if (box === undefined && setup.margin === undefined) return undefined;
  const width = box?.width ?? PAGE_SIZES.A4.width;
  const margin = setup.margin ?? (isScreenPage(setup.page) ? 0 : DEFAULT_SIDE_MARGIN_MM);
  return Math.max(1, Math.round(width - 2 * margin * MM_PX));
};

/**
 * The page setup as CSS, in two layers — #661.
 *
 * `head` goes after the document's own print styling and holds only what the chosen page *implies* (a slide format
 * is full-bleed), so a `kind: html` page's own `@page` rule — later in the cascade, in the body — still wins over
 * it, as it wins over `PRINT_CSS`'s default margins. `tail` goes at the very end of the body and holds what was
 * **asked for** by name — the size, the orientation, the margin, the page numbers — so an explicit request beats
 * everything. The renderer prints with `preferCSSPageSize`, which is what lets any of these decide the paper:
 * before it, Chromium printed A4 whatever the page said.
 */
export const pageSetupCss = (setup: PageSetup): { readonly head: string; readonly tail: string } => {
  const head = isScreenPage(setup.page) ? "@page { margin: 0; }" : "";
  const rules: string[] = [];
  const box = pageBoxOf(setup);
  if (box !== undefined) {
    const named = PAGE_SIZES[setup.page ?? "A4"].css;
    // A named paper keeps its name, so Chromium writes the exact paper size; a screen format is its pixels.
    rules.push(named !== undefined ? `size: ${named} ${box.width > box.height ? "landscape" : "portrait"};` : `size: ${box.width}px ${box.height}px;`);
  }
  if (setup.margin !== undefined) rules.push(`margin: ${setup.margin}mm;`);
  if (setup.pageNumbers === true) {
    // The numbers live in the bottom margin box: with no margin there they would print nowhere.
    if (setup.margin === undefined || setup.margin < PAGE_NUMBER_MARGIN_MM) rules.push(`margin-bottom: ${PAGE_NUMBER_MARGIN_MM}mm;`);
    rules.push(`@bottom-center { content: counter(page) " / " counter(pages); font: 9pt sans-serif; color: #666; }`);
  }
  return { head, tail: rules.length === 0 ? "" : `@page { ${rules.join(" ")} }` };
};

/**
 * Puts the page setup into a built document: `head` before the first `</head>` (the wrapper's own — a model's
 * html body comes after it) and `tail` before the last `</body>` (the wrapper's own, which closes the document).
 */
const withPageSetup = (html: string, setup: PageSetup | undefined): string => {
  if (setup === undefined) return html;
  const { head, tail } = pageSetupCss(setup);
  let out = html;
  if (head !== "") {
    const at = out.indexOf("</head>");
    if (at !== -1) out = `${out.slice(0, at)}<style>${head}</style>${out.slice(at)}`;
  }
  if (tail !== "") {
    const at = out.lastIndexOf("</body>");
    out = at === -1 ? `${out}<style>${tail}</style>` : `${out.slice(0, at)}<style>${tail}</style>${out.slice(at)}`;
  }
  return out;
};

export type DocumentInput = {
  readonly kind: PdfKind;
  readonly source?: string;
  readonly title?: string;
  /**
   * Images for a `media` document, **already inlined as `data:` URLs**.
   *
   * The old pipeline took signed URLs the caller had resolved, and the page fetched them. These are
   * inlined instead: the page then makes no request at all, so there is no signed-URL expiry, no
   * question about whether the container can reach storage, and nothing for the request guard to weigh.
   * The cost is base64's third — bounded by `MAX_DOCUMENT_IMAGES`.
   */
  readonly images?: readonly string[];
  /** #595: the project's theme. Absent, the document prints in the fixed styling it always had. */
  readonly theme?: Theme;
  /**
   * #595 part 2: a document template. Absent, a markdown source's own `<!-- template: … -->` is used, and
   * without either the document prints as it always did.
   */
  readonly template?: DocumentTemplate;
  /** #615/#595: the project's logo as a `data:` URL — in the themed header, or in a template's header. */
  readonly logo?: string;
  /**
   * #615: images a markdown document names (`![alt](chorus-media:…)`), read and inlined as `data:` URLs keyed
   * by the source — see `markdownImageSources`. A named image not in here prints as its alt text.
   */
  readonly inlineImages?: Readonly<Record<string, string>>;
  /** #661: the paper, its orientation and margin, and page numbers. Absent, the page the document always had. */
  readonly pageSetup?: PageSetup;
};

export const buildDocumentHtml = async (input: DocumentInput): Promise<string> =>
  withPageSetup(await buildDocumentBody(input), input.pageSetup);

const buildDocumentBody = async (input: DocumentInput): Promise<string> => {
  if (!(PDF_KINDS as readonly string[]).includes(input.kind)) {
    throw invalid(`Unsupported kind '${input.kind}'. Use text, markdown, html or media.`);
  }

  if (input.kind === "media") {
    const images = (input.images ?? []).filter((image) => image.trim() !== "");
    if (images.length === 0) throw invalid("No images were given to put in the PDF.");
    if (images.length > MAX_DOCUMENT_IMAGES) {
      throw invalid(`A PDF of images holds at most ${MAX_DOCUMENT_IMAGES} of them.`);
    }
    // One image per page — `.media-page` in the print CSS is what makes that true.
    const pages = images
      .map((image) => `<div class='media-page'><img src="${escapeHtml(image)}" alt=''></div>`)
      .join("");
    if (isDocumentTemplate(input.template)) return templatedDocument_(pages, input.template, input);
    const heading = input.title === undefined ? "" : `<h1>${escapeHtml(input.title)}</h1>`;
    return document_(heading + pages, input.title, input.theme, input.logo);
  }

  const source = input.source ?? "";
  if (source.length > MAX_DOCUMENT_CHARS) {
    throw invalid(`That content is too long to turn into a PDF (limit ${MAX_DOCUMENT_CHARS} characters).`);
  }
  if (source.trim() === "") throw invalid("There is no content to put in the PDF.");

  /**
   * `html` is the document **body**, not the whole document.
   *
   * *"A model-supplied `<html>` wrapper would otherwise silently drop the page setup"* — so the print
   * CSS, the A4 size and the margins always apply. The heading is also skipped for `html`, because a
   * model writing a body has usually written its own.
   */
  const body =
    input.kind === "html"
      ? source
      : input.kind === "markdown"
        ? await markdownToHtml(inlineMarkdownImages(source, input.inlineImages ?? {}))
        : `<pre>${escapeHtml(source)}</pre>`;
  const template = isDocumentTemplate(input.template) ? input.template : input.kind === "markdown" ? documentTemplateDirective(source) : undefined;
  const heading = input.title !== undefined && input.kind !== "html" && template === undefined ? `<h1>${escapeHtml(input.title)}</h1>` : "";
  /*
   * Pictures given with a text document go after the text — #587. They used to be refused outright, and
   * production showed a model resend the same image six times with a markdown PDF, never getting a PDF.
   */
  const pictures = (input.images ?? [])
    .filter((image) => image.trim() !== "")
    .slice(0, MAX_DOCUMENT_IMAGES)
    .map((image) => `<p><img src="${escapeHtml(image)}" alt='' style="max-width:100%;height:auto"></p>`)
    .join("");
  if (template !== undefined) {
    // The title prints once, in the header: a document opening with its own `# Title` gives it up there.
    const lead = takeLeadingTitle(body);
    const title = input.title ?? lead.title;
    const rest = lead.title !== undefined && title !== undefined && sameTitle(lead.title, title) ? lead.body : body;
    return templatedDocument_(rest + pictures, template, { ...input, ...(title === undefined ? {} : { title }) });
  }
  return document_(heading + body + pictures, input.title, input.theme, input.logo);
};

/**
 * Renders every `pre.mermaid` in the page, reporting **which** diagram failed.
 *
 * The 1-based index *"matters here in a way it does not for a standalone diagram, because a report can
 * hold several and 'the second diagram' is the difference between a fixable error and a guess."*
 *
 * `suppressErrorRendering` earns its place twice over here: *"without it mermaid appends its own 'Syntax
 * error in text' block to `document.body` — which in a PRINTED document means that banner lands in the
 * PDF."*
 */
export const RENDER_DIAGRAMS_JS = `async () => {
  const nodes = Array.from(document.querySelectorAll('pre.${DIAGRAM_CLASS}'));
  if (!nodes.length) return { ok: true, count: 0 };
  try {
    window.mermaid.initialize(${MERMAID_CONFIG_JS});
  } catch (error) {
    return { ok: false, index: 0, message: 'mermaid failed to start: ' + String(error && error.message ? error.message : error) };
  }
  for (let i = 0; i < nodes.length; i++) {
    try {
      await window.mermaid.parse(nodes[i].textContent);
    } catch (error) {
      return { ok: false, index: i + 1, message: String(error && error.message ? error.message : error) };
    }
  }
  try {
    await window.mermaid.run();
  } catch (error) {
    return { ok: false, index: 0, message: String(error && error.message ? error.message : error) };
  }
  return { ok: true, count: nodes.length };
}`;

/**
 * A page count, read out of the PDF's own structure.
 *
 * *"Cheap page count from the PDF structure. Best-effort: it is a nicety for the reply text, never
 * something to fail a successful render over."* `/Type /Pages` is the tree node and `/Type /Page` is a
 * leaf, so the difference is the leaves.
 */
export const pageCountOf = (bytes: Uint8Array): number => {
  const text = Buffer.from(bytes).toString("latin1");
  const leaves = text.split("/Type /Page").length - 1;
  const trees = text.split("/Type /Pages").length - 1;
  return Math.max(1, leaves - trees);
};
