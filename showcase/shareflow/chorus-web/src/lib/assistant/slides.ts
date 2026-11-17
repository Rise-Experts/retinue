/**
 * Slides in the panel — #607, redesigned in #620. The agent service splits a deck, infers each slide's layout
 * and splits each slide into the parts it draws (`shareflow/src/adapters/web/slides.ts`) when it prints the PDF,
 * draws the carousel or records the video; the panel has to reach the same answer or its preview is of a
 * different deck. So this is a transcription of that module's parsing rules, and
 * `__tests__/artifactSlides.test.ts` imports the agent's module and diffs the two over one matrix.
 *
 * Only the parsing is here. The panel draws a slide with React (so a `chorus-media:` image resolves through the
 * viewer's own signed URL) in the same markup as the print page, styled by the same stylesheet
 * (`slideDesign.ts`), with the unit in container units instead of px.
 */

import { CURATED_FONT_NAMES, normaliseHex, type CuratedFont } from "@/lib/projects/theme";
import type { ThemeOverlay } from "./artifactTheme";

/** #615: `image-left` / `image-right` put one picture beside the text. #620 added the rest after them. */
export const SLIDE_LAYOUTS = [
  "title",
  "bullets",
  "stat",
  "quote",
  "image",
  "cta",
  "image-left",
  "image-right",
  "section",
  "agenda",
  "timeline",
  "stat-grid",
  "two-column",
  "comparison",
  "team",
  "logos",
  "columns",
] as const;
export type SlideLayout = (typeof SLIDE_LAYOUTS)[number];

/** #620: how a slide arrives in present mode and in the video. */
export const SLIDE_TRANSITIONS = ["fade", "slide", "zoom", "none"] as const;
export type SlideTransition = (typeof SLIDE_TRANSITIONS)[number];
export const DEFAULT_SLIDE_TRANSITION: SlideTransition = "fade";

export const SLIDE_FORMATS = {
  "4:5": { width: 1080, height: 1350 },
  "16:9": { width: 1920, height: 1080 },
} as const;
export type SlideFormat = keyof typeof SLIDE_FORMATS;
export const SLIDE_FORMAT_IDS = Object.keys(SLIDE_FORMATS) as readonly SlideFormat[];
export const DEFAULT_SLIDE_FORMAT: SlideFormat = "4:5";

/** A deck longer than this is a document, and its render time grows with it. */
export const MAX_SLIDES = 30;
/** Instagram's carousel ceiling — the tightest of the channels that take one. */
export const CAROUSEL_MAX_SLIDES = 10;

export type Slide = {
  /** 0-based. */
  readonly index: number;
  readonly layout: SlideLayout;
  /** True when a `<!-- layout: … -->` comment chose the layout rather than the content. */
  readonly forced: boolean;
  /** The slide's markdown with the directives (and the eyebrow line) removed. */
  readonly body: string;
  /** #615: a full-bleed background picture, from `<!-- background: chorus-media:… -->`. */
  readonly background?: string;
  /** #615: a small credit line, from `<!-- credit: Photo by … on Pexels -->`. */
  readonly credit?: string;
  /** #620: a kicker above the heading — `<!-- eyebrow: … -->`, or a short line written above it. */
  readonly eyebrow?: string;
  /** #620: this slide's own `<!-- transition: … -->`, when it names one. */
  readonly transition?: SlideTransition;
  /** #663: this slide's own `<!-- bg-color: #hex -->`, normalised; an invalid colour is reported, not kept. */
  readonly bgColor?: string;
};

/** #663: the deck's style directives that held a valid value — laid over the theme by `withDeckStyleVars`. */
export type DeckStyle = ThemeOverlay;

export type Deck = {
  /** From a `<!-- format: … -->` directive, when the deck has one. */
  readonly format?: SlideFormat;
  /** #620: the deck's transition — a `<!-- transition: … -->` before the first `---`. */
  readonly transition?: SlideTransition;
  /** #663: palette, fonts and mode from the deck's own directives, when it has any valid one. */
  readonly style?: DeckStyle;
  readonly slides: readonly Slide[];
};

const FENCE = /^\s*(```+|~~~+)/;
const SEPARATOR = /^\s*---\s*$/;
const LAYOUT_DIRECTIVE = /<!--\s*layout\s*:\s*([a-z-]+)\s*-->/i;
const FORMAT_DIRECTIVE = /<!--\s*format\s*:\s*(4:5|16:9)\s*-->/i;
const DIRECTIVES = /<!--\s*(?:layout|format|background|credit|eyebrow|transition|palette|heading-font|body-font|mode|bg-color)\s*:[^>]*-->/gi;
/** #615: the picture behind a slide — a workspace reference or an https image, as an image line takes. */
export const BACKGROUND_DIRECTIVE = /<!--\s*background\s*:\s*<?((?:chorus-media:|https:\/\/)[^\s>]+?)>?\s*-->/i;
export const CREDIT_DIRECTIVE = /<!--\s*credit\s*:\s*([^>]*?)\s*-->/i;
export const EYEBROW_DIRECTIVE = /<!--\s*eyebrow\s*:\s*([^>]*?)\s*-->/i;
export const TRANSITION_DIRECTIVE = /<!--\s*transition\s*:\s*([a-z]+)\s*-->/i;
/** #663: the deck's style — anywhere in the deck, the first of each wins, as `format` does. See `deckStyleOf`. */
const PALETTE_DIRECTIVE = /<!--\s*palette\s*:\s*([^>]*?)\s*-->/i;
const HEADING_FONT_DIRECTIVE = /<!--\s*heading-font\s*:\s*([^>]*?)\s*-->/i;
const BODY_FONT_DIRECTIVE = /<!--\s*body-font\s*:\s*([^>]*?)\s*-->/i;
const MODE_DIRECTIVE = /<!--\s*mode\s*:\s*([^>]*?)\s*-->/i;
/** #663: one slide's own background colour. */
const BG_COLOR_DIRECTIVE = /<!--\s*bg-color\s*:\s*([^>]*?)\s*-->/i;
/** A credit line is a caption, not a paragraph. */
export const MAX_CREDIT_CHARS = 120;
/** An eyebrow is a kicker: a few words. A longer line above a heading is an intro paragraph. */
export const MAX_EYEBROW_CHARS = 48;

/** `![alt](chorus-media:…)` or an https image, alone on its line. */
export const IMAGE_LINE = /^!\[([^\]]*)\]\(\s*<?((?:chorus-media:|https:\/\/)[^)\s>]+)>?(?:\s+"[^"]*")?\s*\)$/;
/** A lone figure: 87%, $1.2m, 3.5x, 10,000+, optionally bold or as a heading. */
export const STAT_LINE = /^(?:#{1,6}\s+)?(?:\*\*|__)?\s*[~≈+\-−]?\s*[$€£¥]?\s*\d[\d.,]*\s*(?:%|x|×|k|m|bn|b|\+)?\s*(?:\*\*|__)?$/i;

/**
 * A figure leading a short label on one line — "3x More Engagement", "45% of buyers", "$2M raised". Production,
 * 2026-09-28: the model wrote the stat slide as "3x More Engagement" and it drew as a plain line, because only a
 * lone figure counted. The figure needs a unit or a currency, so "3 tips for better posts" stays text.
 */
export const LEADING_STAT = /^(?:#{1,6}\s+)?(?:\*\*|__)?\s*((?:[~≈+\-−]?\s*[$€£¥]\s*\d[\d.,]*\s*(?:%|x|×|k|m|bn|b|\+)?)|(?:[~≈+\-−]?\s*\d[\d.,]*\s*(?:%|x|×|k|m|bn|b|\+)))(?:\*\*|__)?\s+(\S.{0,59})$/i;

/** The figure and the label of a stat line, whether the figure stands alone or leads a label. */
export const statParts = (line: string): { readonly figure: string; readonly label: string } | null => {
  const trimmed = line.trim();
  if (STAT_LINE.test(trimmed)) return { figure: trimmed.replace(/^#{1,6}\s+/, "").replace(/\*\*|__/g, "").trim(), label: "" };
  const m = LEADING_STAT.exec(trimmed);
  return m === null ? null : { figure: (m[1] ?? "").replace(/\s+/g, ""), label: (m[2] ?? "").replace(/\*\*|__/g, "").trim() };
};
/**
 * #615: a percentage from 0 to 100 draws as a ring filled to it; any other figure gets an accent bar. So a
 * stat slide carries a visual without an image.
 */
export const statRing = (figure: string): number | null => {
  const m = /^[~≈+]?\s*(\d{1,3}(?:[.,]\d+)?)\s*%$/.exec(figure.trim());
  if (m === null) return null;
  const value = Number((m[1] ?? "").replace(",", "."));
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
};

/** #615: layouts that put a picture beside the text. */
export const isSplitLayout = (layout: SlideLayout): boolean => layout === "image-left" || layout === "image-right";

const H1 = /^#\s+\S/;
const HEADING = /^#{1,6}\s+\S/;
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s+\S/;
const LIST_MARKER = /^(?:[-*+]|\d+[.)])\s+/;
export const ATTRIBUTION = /^(?:—|–|--|~)\s*\S/;
/** #620: a line that is only a link, a URL, a web address or a handle — what a call to action points at. */
export const LINK_LINE = /^(?:\[[^\]]+\]\(\s*[^)\s]+\s*\)|<?https?:\/\/\S+?>?|www\.\S+|@[\w.]{2,30}|[\w.+-]+@[\w-]+\.[\w.]+)$/i;
/** #620: a heading that asks for something — a closing slide, even without a link on it. */
const CTA_HEADING = /^#{1,3}\s+(?:\*\*)?(?:follow|subscribe|join|try|get started|start|sign up|book|contact|learn more|visit|download|shop|order|register|apply|let'?s talk|jetzt|folge|folgt|abonniere|kontakt|melde|buche|starte|probier)\b/i;
/** #620: a heading that introduces a list of what is coming. */
const AGENDA_HEADING = /^#{1,3}\s+(?:\*\*)?(?:agenda\b.*|(?:overview|contents|table of contents|today|what we'?ll cover|in this (?:deck|talk|post)|outline|inhalt|tagesordnung|übersicht|themen|heute)(?:\*\*)?\s*[:.!]?)$/i;
/** #620: a numbered section heading — "## 02 Results", "# Part 2: Growth", "## Chapter one". */
/** A line under a heading that names it a section — "Section 01: Overview", "Part 2", "02 · Results". */
const SECTION_MARKER = /^(?:\*\*)?(?:(?:section|part|chapter|act|teil|kapitel|abschnitt)\s+\w+|0?\d{1,2}\s*[·:.—–-]\s*\S)/i;
const SECTION_HEADING = /^#{1,3}\s+(?:\*\*)?(?:(?:\d{1,2}[.:)]|\d{1,2}\s*[—–-]|0\d)\s+\S|(?:part|chapter|section|act|teil|kapitel|abschnitt)\s+\w+)/i;
/** #620: a list item that starts with a time — a year, a quarter, a month, a step, a week. */
const TIME_ITEM =
  /^(?:\*\*|__)?(?:(?:19|20)\d{2}|Q[1-4](?:\s*(?:19|20)?\d{2})?|H[12](?:\s*(?:19|20)\d{2})?|(?:jan(?:uary|uar)?|feb(?:ruary|ruar)?|mar(?:ch)?|märz|apr(?:il)?|may|mai|jun[ei]?|jul[yi]?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|okt(?:ober)?|nov(?:ember)?|dec(?:ember)?|dez(?:ember)?)\.?(?:\s+\d{1,4})?|(?:step|week|day|phase|month|stage|sprint|milestone|schritt|woche|tag|monat|stufe)\s*\d+|(?:today|now|next|later|soon|heute|jetzt|bald|später))\s*(?:[:—–|-])?\s*(?:\*\*|__)?\s*(?:[:—–|-])?\s+\S/i;
/** #620: two column headings that set one thing against another. */
const CONTRAST = /^#{1,6}\s+(?:\*\*)?(?:before|after|pros?|cons?|old|new|then|now|without|with|do|don'?t|myth|fact|us|them|problem|solution|good|bad|yes|no|today|tomorrow|vorher|nachher|ohne|mit|früher|heute|alt|neu|mythos|fakt|problem|lösung)\b/i;
const VERSUS = /\bvs\.?(?=\s|$)|\bversus\b|\bgegen\b/i;

const stripDirectives = (text: string): string => text.replace(DIRECTIVES, "").trim();

/**
 * #653: an HTML comment that is not one of `DIRECTIVES`. Production, 2026-09-30: the model invented
 * `<!-- theme: dark-tech -->`, and slide 1 showed "<!-- THEME: DARK-TECH -->" as its eyebrow — a short line above
 * a heading reads as one, and nothing removed a comment it did not know. Removed outside code blocks; a code
 * block may legitimately show an HTML comment.
 */
const UNKNOWN_COMMENT = /<!--(?!\s*(?:layout|format|background|credit|eyebrow|transition|palette|heading-font|body-font|mode|bg-color)\s*:)[\s\S]*?-->/gi;
const NAMED_COMMENT = /<!--\s*([a-z][\w-]*)\s*:/i;

/** The deck's lines outside code blocks, each with a flag. */
const linesOf = (source: string): { readonly line: string; readonly code: boolean }[] => {
  const out: { line: string; code: boolean }[] = [];
  let fence: string | null = null;
  for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
    const opener = FENCE.exec(line);
    if (opener !== null) {
      const marker = opener[1] ?? "";
      if (fence === null) fence = marker;
      else if (line.trim().startsWith(fence)) fence = null;
      out.push({ line, code: true });
      continue;
    }
    out.push({ line, code: fence !== null });
  }
  return out;
};

/**
 * The names of comments written as directives that no slide understands — `["theme"]` for
 * `<!-- theme: dark -->` — once each, in order. For the tools to report, so the agent can correct itself.
 */
export const unknownDirectives = (source: string): string[] => {
  const names: string[] = [];
  for (const { line, code } of linesOf(source)) {
    if (code) continue;
    for (const comment of line.match(UNKNOWN_COMMENT) ?? []) {
      const name = NAMED_COMMENT.exec(comment)?.[1]?.toLowerCase();
      if (name !== undefined && !names.includes(name)) names.push(name);
    }
  }
  return names;
};

/** The deck's chunks as written, before empty ones are dropped. Unknown comments are gone (#653). */
const rawChunks = (source: string): string[] => {
  const chunks: string[][] = [[]];
  for (const { line, code } of linesOf(source)) {
    if (!code && SEPARATOR.test(line)) {
      chunks.push([]);
      continue;
    }
    chunks[chunks.length - 1]?.push(code ? line : line.replace(UNKNOWN_COMMENT, ""));
  }
  return chunks.map((chunk) => chunk.join("\n").trim());
};

/**
 * The deck's slides as markdown chunks. A `---` inside a fenced code block is code, not a break; a chunk
 * that holds nothing but directives is dropped, so a deck may open with `<!-- format: 16:9 -->\n---`.
 */
export const splitSlides = (source: string): string[] =>
  // A slide that is only a background picture is still a slide (#615).
  rawChunks(source).filter((chunk) => stripDirectives(chunk) !== "" || BACKGROUND_DIRECTIVE.test(chunk));

const meaningfulLines = (body: string): string[] =>
  stripDirectives(body)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

const isPlain = (line: string): boolean =>
  !HEADING.test(line) && !LIST_ITEM.test(line) && !line.startsWith(">") && !line.startsWith("|") && !IMAGE_LINE.test(line) && !FENCE.test(line);

/** Markdown emphasis, code and links reduced to their text — for the short strings a layout draws itself. */
export const plainText = (text: string): string =>
  text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/(^|\s)[*_](\S(?:.*?\S)?)[*_](?=\s|$|[.,;:!?])/g, "$1$2")
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * #620: a short plain line written directly above the first heading is its eyebrow — "Q3 REVIEW" over
 * "# Growth". Not a figure (that is a stat), not a sentence (it ends in a full stop), and not long.
 */
const lineEyebrow = (lines: readonly string[]): string | undefined => {
  const [first, second] = lines;
  if (first === undefined || second === undefined || !HEADING.test(second) || !isPlain(first)) return undefined;
  if (STAT_LINE.test(first) || LEADING_STAT.test(first) || LINK_LINE.test(first) || /[.!?]$/.test(first)) return undefined;
  const text = plainText(first);
  return text === "" || text.length > MAX_EYEBROW_CHARS ? undefined : text;
};

/** The chunk without its eyebrow line, and the eyebrow — a directive's, or the line's. */
const splitEyebrow = (chunk: string): { readonly chunk: string; readonly eyebrow?: string } => {
  const named = EYEBROW_DIRECTIVE.exec(chunk)?.[1]?.trim();
  if (named !== undefined && named !== "") return { chunk, eyebrow: plainText(named).slice(0, MAX_EYEBROW_CHARS * 2) };
  const eyebrow = lineEyebrow(meaningfulLines(chunk));
  if (eyebrow === undefined) return { chunk };
  // Remove the first non-directive, non-blank line — the one the eyebrow was read from.
  const lines = chunk.split("\n");
  const at = lines.findIndex((line) => stripDirectives(line).trim() !== "");
  return { chunk: lines.filter((_, i) => i !== at).join("\n"), eyebrow };
};

/** #620: the stat-grid's cells — a figure, and a label beside it or on the line under it. */
const statCells = (lines: readonly string[]): { readonly figure: string; readonly label: string }[] | null => {
  const cells: { figure: string; label: string }[] = [];
  for (const raw of lines) {
    const line = raw.replace(LIST_MARKER, "");
    const parts = statParts(line);
    if (parts !== null) cells.push({ figure: parts.figure, label: parts.label });
    else if (cells.length > 0 && cells[cells.length - 1]!.label === "" && isPlain(raw)) cells[cells.length - 1]!.label = plainText(raw);
    else return null;
  }
  return cells;
};

/** #620: where two columns start — the last two headings, when they are siblings under any top heading. */
const columnSplit = (lines: readonly string[]): { readonly top: number; readonly a: number; readonly b: number } | null => {
  const headings = lines.flatMap((line, i) => (HEADING.test(line) ? [i] : []));
  if (headings.length < 2) return null;
  const a = headings[headings.length - 2]!;
  const b = headings[headings.length - 1]!;
  const level = (i: number) => /^#+/.exec(lines[i] ?? "")?.[0].length ?? 0;
  if (level(a) !== level(b) || b === a + 1 || b === lines.length - 1) return null;
  // Anything above the columns is the slide's head: headings of a higher rank, and at most one line.
  const above = lines.slice(0, a);
  if (above.some((line) => HEADING.test(line) && level(lines.indexOf(line)) >= level(a))) return null;
  if (above.filter((line) => !HEADING.test(line)).length > 1) return null;
  return { top: a, a, b };
};

/** #664: a `columns` slide holds two to four columns — more and none of them reads at a feed's size. */
const MAX_COLUMNS = 4;

/**
 * #664: where each column starts — every heading after the slide's head, all siblings at one level, each with
 * something under it. Above the first column only headings of a higher rank and at most one line, as in `columnSplit`.
 */
const columnStarts = (lines: readonly string[]): readonly number[] | null => {
  const headings = lines.flatMap((line, i) => (HEADING.test(line) ? [i] : []));
  if (headings.length < 2) return null;
  const level = (i: number) => /^#+/.exec(lines[i] ?? "")?.[0].length ?? 0;
  const depth = level(headings[headings.length - 1]!);
  const starts = headings.filter((i) => level(i) === depth);
  const first = starts[0]!;
  if (headings.some((i) => (i < first ? level(i) >= depth : level(i) !== depth))) return null;
  if (lines.slice(0, first).filter((line) => !HEADING.test(line)).length > 1) return null;
  const ends = [...starts.slice(1), lines.length];
  if (starts.some((start, k) => ends[k] === start + 1)) return null;
  return starts;
};

/** A slide's layout from its content, unless a directive names one. */
export const inferLayout = (source: string): { readonly layout: SlideLayout; readonly forced: boolean } => {
  const named = LAYOUT_DIRECTIVE.exec(source)?.[1]?.toLowerCase();
  if (named !== undefined && (SLIDE_LAYOUTS as readonly string[]).includes(named)) {
    return { layout: named as SlideLayout, forced: true };
  }
  const lines = meaningfulLines(splitEyebrow(source).chunk);
  const first = lines[0];
  const images = lines.filter((line) => IMAGE_LINE.test(line));
  const others = lines.filter((line) => !IMAGE_LINE.test(line));
  const body = lines.filter((line) => !HEADING.test(line));

  // #620: a section divider — a lone `##` heading, or a numbered section heading with at most one line.
  if (first !== undefined && HEADING.test(first) && !H1.test(first) && !STAT_LINE.test(first) && lines.length === 1) return { layout: "section", forced: false };
  if (first !== undefined && SECTION_HEADING.test(first) && !STAT_LINE.test(first) && lines.length <= 2 && lines.slice(1).every(isPlain)) {
    return { layout: "section", forced: false };
  }
  // A `##` heading over a section marker ("Section 01: …") is a divider too (production, 2026-09-29).
  if (first !== undefined && HEADING.test(first) && !H1.test(first) && !STAT_LINE.test(first) && lines.length === 2 && isPlain(lines[1] ?? "") && SECTION_MARKER.test(lines[1] ?? "")) {
    return { layout: "section", forced: false };
  }

  // A title: one `#` heading and at most one plain line under it.
  // A heading that is itself a figure ("# 87%") is a stat, not a title.
  if (first !== undefined && H1.test(first) && !STAT_LINE.test(first) && lines.length <= 2 && lines.slice(1).every(isPlain)) {
    return { layout: "title", forced: false };
  }

  // #620: two to eight pictures — people when they carry names, logos otherwise.
  if (images.length >= 2 && images.length <= 8 && others.every((line) => HEADING.test(line) || isPlain(line))) {
    const heading = others.find((line) => HEADING.test(line)) ?? "";
    const captions = others.filter((line) => !HEADING.test(line)).length;
    const people = /\b(?:team|people|founders?|speakers?|meet|hosts?|crew|leadership|who we are|unser team|gründer|sprecher)\b/i.test(heading);
    const brands = /\b(?:logos?|clients?|partners?|customers?|trusted|featured|brands?|backed|as seen|kunden|marken)\b/i.test(heading);
    return { layout: brands || (!people && captions === 0) ? "logos" : "team", forced: false };
  }

  // An image: exactly one image line, with at most a heading and a caption beside it.
  if (images.length === 1 && others.length <= 2 && others.every((line) => HEADING.test(line) || isPlain(line))) {
    return { layout: "image", forced: false };
  }
  // #615: one picture with more to say beside it — a heading and bullets, or a few lines — sits on the right.
  if (images.length === 1 && others.length > 0 && others.every((line) => HEADING.test(line) || LIST_ITEM.test(line) || isPlain(line))) {
    return { layout: "image-right", forced: false };
  }

  // A quote: a `>` block, with at most a heading, one attribution line and (#620) one portrait.
  if (lines.some((line) => line.startsWith(">"))) {
    const rest = lines.filter((line) => !line.startsWith(">") && !HEADING.test(line) && !IMAGE_LINE.test(line));
    const portraits = lines.filter((line) => IMAGE_LINE.test(line)).length;
    if (portraits <= 1 && (rest.length === 0 || (rest.length === 1 && ATTRIBUTION.test(rest[0] ?? "")))) return { layout: "quote", forced: false };
  }

  // A stat: exactly one lone figure, with at most two short lines of context and no list.
  const stats = lines.filter((line) => STAT_LINE.test(line));
  if (stats.length === 1 && lines.length <= 3 && lines.every((line) => STAT_LINE.test(line) || HEADING.test(line) || isPlain(line))) {
    return { layout: "stat", forced: false };
  }
  // Or a figure leading its label, alone on the slide or under one heading.
  const led = lines.filter((line) => LEADING_STAT.test(line));
  if (stats.length === 0 && led.length === 1 && lines.length <= 2 && lines.every((line) => LEADING_STAT.test(line) || HEADING.test(line))) {
    return { layout: "stat", forced: false };
  }

  const headings = lines.length - body.length;
  const leadingHeading = headings === 0 || (headings === 1 && HEADING.test(first ?? ""));
  // #620: two to four figures, each with its label — beside it, under it, or as list items.
  if (leadingHeading && body.length >= 2) {
    const cells = statCells(body);
    if (cells !== null && cells.length >= 2 && cells.length <= 4) return { layout: "stat-grid", forced: false };
  }
  // #620: three to six list items that each start with a time.
  const items = body.filter((line) => LIST_ITEM.test(line));
  if (leadingHeading && items.length >= 3 && items.length <= 6 && items.length === body.length && items.every((line) => TIME_ITEM.test(line.replace(LIST_MARKER, "")))) {
    return { layout: "timeline", forced: false };
  }
  // #620: a list under a heading that announces what is coming.
  if (first !== undefined && AGENDA_HEADING.test(first) && headings === 1 && items.length >= 2 && items.length <= 8 && items.length === body.length) {
    return { layout: "agenda", forced: false };
  }
  // #664: three or four sibling headings — pricing tiers, plans, options — are that many even columns.
  const starts = columnStarts(lines);
  if (starts !== null && starts.length >= 3 && starts.length <= MAX_COLUMNS && lines.every((line) => HEADING.test(line) || LIST_ITEM.test(line) || isPlain(line))) {
    return { layout: "columns", forced: false };
  }
  // #620: two sibling headings, each with something under it — set against each other when they contrast.
  const split = columnSplit(lines);
  if (split !== null && lines.every((line) => HEADING.test(line) || LIST_ITEM.test(line) || isPlain(line))) {
    const a = lines[split.a] ?? "";
    const b = lines[split.b] ?? "";
    const contrast = (CONTRAST.test(a) && CONTRAST.test(b)) || lines.some((line) => HEADING.test(line) && VERSUS.test(line));
    return { layout: contrast ? "comparison" : "two-column", forced: false };
  }
  // #620: a closing slide — a heading that asks, or a heading with a link or a handle under it.
  const last = lines[lines.length - 1] ?? "";
  if (first !== undefined && HEADING.test(first) && lines.length <= 3 && lines.slice(1).every(isPlain)) {
    if (lines.length >= 2 && LINK_LINE.test(last.replace(/\*\*|__/g, ""))) return { layout: "cta", forced: false };
    if (CTA_HEADING.test(first)) return { layout: "cta", forced: false };
  }

  return { layout: "bullets", forced: false };
};

const transitionOf = (chunk: string | undefined): SlideTransition | undefined => {
  const named = TRANSITION_DIRECTIVE.exec(chunk ?? "")?.[1]?.toLowerCase();
  return named !== undefined && (SLIDE_TRANSITIONS as readonly string[]).includes(named) ? (named as SlideTransition) : undefined;
};

/** #663: the palette's three roles, in the order a bare list of colours fills them. */
const PALETTE_ORDER = ["background", "text", "accent"] as const;
type PaletteKey = (typeof PALETTE_ORDER)[number];
const PALETTE_KEY = /^(background|bg|text|accent)\s*[:=]?\s*(.*)$/i;

/**
 * #663: a `palette` value — up to three colours, `#0b1020 #f5f5f5 #ff5a36` filling background, text and accent in
 * that order, or named (`background #0b1020, accent #ff5a36`, `bg:#0b1020`). What is not a hex colour, or one
 * colour too many, comes back in `bad`.
 */
export const readPalette = (value: string): { readonly colours: Partial<Record<PaletteKey, string>>; readonly bad: readonly string[] } => {
  const colours: Partial<Record<PaletteKey, string>> = {};
  const bad: string[] = [];
  let next = 0;
  let named: PaletteKey | undefined;
  for (const token of value.split(/[\s,;]+/).filter((t) => t !== "")) {
    const key = PALETTE_KEY.exec(token);
    let colour = token;
    if (key !== null) {
      const word = (key[1] ?? "").toLowerCase();
      named = word === "bg" ? "background" : (word as PaletteKey);
      colour = key[2] ?? "";
      if (colour === "") continue;
    }
    const role = named ?? PALETTE_ORDER[next++];
    named = undefined;
    const hex = normaliseHex(colour);
    if (role === undefined || hex === undefined) bad.push(colour);
    else colours[role] = hex;
  }
  return { colours, bad };
};

/** #663: an installed family by name, any case, quotes allowed — or nothing. */
export const installedFont = (value: string | undefined): CuratedFont | undefined => {
  const v = (value ?? "").replace(/["']/g, "").trim().toLowerCase();
  return CURATED_FONT_NAMES.find((name) => name.toLowerCase() === v);
};

/** The deck's lines outside code blocks — a directive shown in a code block is an example, not a directive. */
const proseOf = (source: string): string =>
  linesOf(source)
    .filter((l) => !l.code)
    .map((l) => l.line)
    .join("\n");

/**
 * #663 (AR-17): the deck's style directives, with only their valid values. The agent's `deckStyleProblems` reports the rest,
 * as unknown directives are reported (#653), so the agent never says a style was applied when it was not.
 */
export const deckStyleOf = (source: string): DeckStyle | undefined => {
  const prose = proseOf(source);
  const palette = readPalette(PALETTE_DIRECTIVE.exec(prose)?.[1] ?? "").colours;
  const headingFont = installedFont(HEADING_FONT_DIRECTIVE.exec(prose)?.[1]);
  const bodyFont = installedFont(BODY_FONT_DIRECTIVE.exec(prose)?.[1]);
  const mode = MODE_DIRECTIVE.exec(prose)?.[1]?.trim().toLowerCase();
  const style: DeckStyle = {
    ...palette,
    ...(headingFont === undefined ? {} : { headingFont }),
    ...(bodyFont === undefined ? {} : { bodyFont }),
    ...(mode === "dark" || mode === "light" ? { mode } : {}),
  };
  return Object.keys(style).length === 0 ? undefined : style;
};

/** The whole deck: its slides with their layouts, and the format and transition directives asked for. */
export const parseSlides = (source: string): Deck => {
  const format = FORMAT_DIRECTIVE.exec(source)?.[1] as SlideFormat | undefined;
  const style = deckStyleOf(source);
  // #620: a transition before the first `---` is the deck's; one on a later slide is that slide's.
  const transition = transitionOf(rawChunks(source)[0]);
  const slides = splitSlides(source).map((chunk, index): Slide => {
    const { layout, forced } = inferLayout(chunk);
    const { chunk: rest, eyebrow } = splitEyebrow(chunk);
    const background = BACKGROUND_DIRECTIVE.exec(chunk)?.[1];
    const credit = CREDIT_DIRECTIVE.exec(chunk)?.[1]?.trim().slice(0, MAX_CREDIT_CHARS);
    const own = transitionOf(chunk);
    const bgColor = normaliseHex(BG_COLOR_DIRECTIVE.exec(chunk)?.[1]);
    return {
      index,
      layout,
      forced,
      body: stripDirectives(rest),
      ...(background === undefined ? {} : { background }),
      ...(credit === undefined || credit === "" ? {} : { credit }),
      ...(eyebrow === undefined || eyebrow === "" ? {} : { eyebrow }),
      ...(own === undefined ? {} : { transition: own }),
      ...(bgColor === undefined ? {} : { bgColor }),
    };
  });
  return {
    ...(format === undefined ? {} : { format }),
    ...(transition === undefined ? {} : { transition }),
    ...(style === undefined ? {} : { style }),
    slides,
  };
};

/** How a slide arrives: its own transition, the deck's, or a fade. */
export const slideTransition = (deck: Deck, slide: Slide): SlideTransition => slide.transition ?? deck.transition ?? DEFAULT_SLIDE_TRANSITION;

/** Every image source a deck names, in order and once each — what an exporter has to inline. */
export const slideImageSources = (deck: Deck): string[] => {
  const seen = new Set<string>();
  for (const slide of deck.slides) {
    if (slide.background !== undefined) seen.add(slide.background);
    for (const line of meaningfulLines(slide.body)) {
      const src = IMAGE_LINE.exec(line)?.[2];
      if (src !== undefined) seen.add(src);
    }
  }
  return [...seen];
};

/* ------------------------------------------------------------------------------------------------------------
 * The parts of a slide, as both renderers draw them. The print page (below) and the panel (React) each lay out
 * these parts in the same markup; the parity test diffs this function against the panel's copy.
 * ---------------------------------------------------------------------------------------------------------- */

export type SlideImage = { readonly alt: string; readonly src: string };
/** One entry of an agenda, a timeline, a stat grid, a team or a logo wall. */
export type SlideItem = {
  readonly text: string;
  /** A timeline step's time, a person's role. */
  readonly label?: string;
  /** A stat grid cell's figure. */
  readonly figure?: string;
  /** A team member's portrait, a logo. */
  readonly image?: SlideImage;
};
export type SlideColumn = { readonly heading: string; readonly body: string };

export type SlideParts = {
  /** Markdown drawn first — the heading, usually. */
  readonly before: string;
  /** The stat's figure. */
  readonly figure?: string;
  /** The image of an image slide, a split slide, or a quote's portrait. */
  readonly image?: SlideImage;
  readonly attribution?: string;
  readonly items?: readonly SlideItem[];
  readonly columns?: readonly [SlideColumn, SlideColumn];
  /** #664: a `columns` slide's two to four columns; `columns` stays the two sides of a two-column or comparison. */
  readonly grid?: readonly SlideColumn[];
  /** A call to action's button text and the link or handle under it. */
  readonly button?: string;
  readonly link?: string;
  /** Markdown drawn after the main element. */
  readonly after: string;
};

const imageOf = (line: string): SlideImage | undefined => {
  const m = IMAGE_LINE.exec(line.trim());
  return m === null ? undefined : { alt: m[1] ?? "", src: m[2] ?? "" };
};

const joinLines = (lines: readonly string[]): string => lines.join("\n").trim();

/** A link line as the words a person reads: the link's text, or the address without its scheme. */
const linkDisplay = (line: string): { readonly text: string; readonly target?: string } => {
  const md = /^\[([^\]]+)\]\(\s*([^)\s]+)\s*\)$/.exec(line.trim());
  if (md !== null) return { text: plainText(md[1] ?? ""), target: (md[2] ?? "").replace(/^https?:\/\//i, "").replace(/\/$/, "") };
  return { text: line.trim().replace(/^<|>$/g, "").replace(/^https?:\/\//i, "").replace(/\/$/, "") };
};

const itemsFromLines = (lines: readonly string[]): string[] => {
  const listed = lines.filter((line) => LIST_ITEM.test(line));
  return (listed.length > 0 ? listed : lines.filter((line) => !HEADING.test(line))).map((line) => line.replace(LIST_MARKER, ""));
};

/** A timeline step split into its time and its words: "**2024** — Launched", "Q3: Beta", "Step 1 Plan". */
const timelineItem = (line: string): SlideItem => {
  const bold = /^(?:\*\*|__)(.+?)(?:\*\*|__)\s*(?:[:—–|-]\s*)?(.*)$/.exec(line);
  if (bold !== null && (bold[2] ?? "").trim() !== "") return { label: plainText(bold[1] ?? "").replace(/\s*[:—–|-]\s*$/, ""), text: plainText(bold[2] ?? "") };
  const delimited = /^(.{1,24}?)\s*(?::|—|–|\||\s-\s)\s*(.+)$/.exec(line);
  if (delimited !== null && TIME_ITEM.test(line)) return { label: plainText(delimited[1] ?? ""), text: plainText(delimited[2] ?? "") };
  const token = /^((?:step|week|day|phase|month|stage|sprint|milestone|schritt|woche|tag|monat|stufe)\s*\d+|(?:19|20)\d{2}|Q[1-4](?:\s*(?:19|20)?\d{2})?|H[12](?:\s*(?:19|20)\d{2})?)\s+(.+)$/i.exec(line);
  if (token !== null) return { label: plainText(token[1] ?? ""), text: plainText(token[2] ?? "") };
  return { text: plainText(line) };
};

export const slideParts = (slide: Slide): SlideParts => {
  const lines = slide.body.split("\n");
  const trimmed = lines.map((line) => line.trim()).filter((line) => line !== "");
  const headingLines = trimmed.filter((line) => HEADING.test(line));
  switch (slide.layout) {
    case "stat": {
      const at = lines.findIndex((line) => statParts(line) !== null);
      if (at === -1) return { before: slide.body, after: "" };
      const parts = statParts(lines[at] ?? "")!;
      // The heading above the figure; a label that led off the figure's line, and any context, under it.
      const rest = lines.flatMap((line, i) => (i === at ? (parts.label === "" ? [] : [parts.label]) : [line]));
      return {
        before: joinLines(rest.filter((line) => HEADING.test(line.trim()))),
        figure: parts.figure,
        after: joinLines(rest.filter((line) => !HEADING.test(line.trim()))),
      };
    }
    case "stat-grid": {
      const body = trimmed.filter((line) => !HEADING.test(line));
      const cells = statCells(body);
      if (cells === null || cells.length === 0) {
        // A forced grid of lines that are not figures: each line a cell, drawn as its words.
        return { before: joinLines(headingLines), items: body.map((line) => ({ text: plainText(line.replace(LIST_MARKER, "")) })), after: "" };
      }
      return { before: joinLines(headingLines), items: cells.map((cell) => ({ figure: cell.figure, text: cell.label })), after: "" };
    }
    case "quote": {
      const attribution = trimmed.filter((line) => ATTRIBUTION.test(line)).join(" ");
      const portrait = trimmed.map(imageOf).find((image) => image !== undefined);
      return {
        before: joinLines(lines.filter((line) => !ATTRIBUTION.test(line.trim()) && !IMAGE_LINE.test(line.trim()))),
        ...(portrait === undefined ? {} : { image: portrait }),
        ...(attribution === "" ? {} : { attribution }),
        after: "",
      };
    }
    case "image":
    case "image-left":
    case "image-right": {
      const at = lines.findIndex((line) => IMAGE_LINE.test(line.trim()));
      const image = at === -1 ? undefined : imageOf(lines[at] ?? "");
      if (image === undefined) return { before: slide.body, after: "" };
      return { before: joinLines(lines.slice(0, at)), image, after: joinLines(lines.slice(at + 1)) };
    }
    case "bullets": {
      // The head (heading and intro) and the list, so a landscape slide can set them side by side.
      const at = lines.findIndex((line) => LIST_ITEM.test(line.trim()));
      if (at <= 0) return at === 0 ? { before: "", after: slide.body } : { before: slide.body, after: "" };
      return { before: joinLines(lines.slice(0, at)), after: joinLines(lines.slice(at)) };
    }
    case "agenda":
      return { before: joinLines(headingLines), items: itemsFromLines(trimmed).map((line) => ({ text: plainText(line) })), after: "" };
    case "timeline":
      return { before: joinLines(headingLines), items: itemsFromLines(trimmed).map(timelineItem), after: "" };
    case "team":
    case "logos": {
      const items: SlideItem[] = [];
      const rest: string[] = [];
      for (const line of trimmed) {
        const image = imageOf(line);
        const last = items[items.length - 1];
        if (image !== undefined) items.push({ image, text: plainText(image.alt) });
        else if (HEADING.test(line)) continue;
        else if (last !== undefined && last.label === undefined && isPlain(line)) {
          // "Dana Weiss — CTO" names the person and their role; a line without a dash is the name.
          const [name, ...role] = plainText(line).split(/\s+[—–|-]\s+|,\s+/);
          items[items.length - 1] = { ...last, text: name ?? last.text, label: role.join(", ") };
        } else rest.push(line);
      }
      return { before: joinLines(headingLines), items, after: joinLines(rest) };
    }
    case "two-column":
    case "comparison": {
      const split = columnSplit(trimmed);
      if (split !== null) {
        return {
          before: joinLines(trimmed.slice(0, split.a)),
          columns: [
            { heading: trimmed[split.a] ?? "", body: joinLines(trimmed.slice(split.a + 1, split.b)) },
            { heading: trimmed[split.b] ?? "", body: joinLines(trimmed.slice(split.b + 1)) },
          ],
          after: "",
        };
      }
      // No sibling headings: the list is halved, so a forced layout still draws two columns.
      const body = trimmed.filter((line) => !HEADING.test(line));
      const half = Math.ceil(body.length / 2);
      return {
        before: joinLines(headingLines),
        columns: [
          { heading: "", body: joinLines(body.slice(0, half)) },
          { heading: "", body: joinLines(body.slice(half)) },
        ],
        after: "",
      };
    }
    case "columns": {
      const starts = columnStarts(trimmed)?.slice(0, MAX_COLUMNS);
      if (starts !== undefined) {
        // A fifth heading and what follows it stay in the fourth column rather than being dropped.
        const ends = [...starts.slice(1), trimmed.length];
        return {
          before: joinLines(trimmed.slice(0, starts[0])),
          grid: starts.map((start, k) => ({ heading: trimmed[start] ?? "", body: joinLines(trimmed.slice(start + 1, ends[k])) })),
          after: "",
        };
      }
      // No sibling headings: the list is dealt into three, so a forced layout still draws columns.
      const body = trimmed.filter((line) => !HEADING.test(line));
      const size = Math.ceil(body.length / 3);
      return {
        before: joinLines(headingLines),
        grid: [0, 1, 2].map((k) => ({ heading: "", body: joinLines(body.slice(k * size, (k + 1) * size)) })),
        after: "",
      };
    }
    case "cta": {
      const body = trimmed.filter((line) => !HEADING.test(line));
      const linkAt = body.map((line) => LINK_LINE.test(line.replace(/\*\*|__/g, ""))).lastIndexOf(true);
      const link = linkAt === -1 ? undefined : linkDisplay(body[linkAt]!.replace(/\*\*|__/g, ""));
      const rest = body.filter((_, i) => i !== linkAt);
      // The last short line is the button; a link with no line for it lends the button its words.
      const candidate = rest[rest.length - 1];
      const button = candidate !== undefined && plainText(candidate).length <= 60 ? plainText(candidate) : undefined;
      const text = button === undefined ? rest : rest.slice(0, -1);
      const label = button ?? link?.text;
      const under = button === undefined ? link?.target : (link?.target ?? link?.text);
      return {
        before: joinLines([...headingLines, ...text]),
        ...(label === undefined ? {} : { button: label }),
        ...(under === undefined || under === label ? {} : { link: under }),
        after: "",
      };
    }
    case "section": {
      // "## 02 Results": the number is drawn huge behind the heading, and the heading keeps its words.
      const at = lines.findIndex((line) => HEADING.test(line.trim()));
      const m = at === -1 ? null : /^(#{1,6})\s+(?:\*\*)?(\d{1,2})(?:\*\*)?(?:[.:)]|\s*[—–-])?\s+(\S.*)$/.exec(lines[at]!.trim());
      if (m === null) return { before: slide.body, after: "" };
      return { before: joinLines(lines.map((line, i) => (i === at ? `${m[1]} ${m[3]}` : line))), figure: (m[2] ?? "").padStart(2, "0"), after: "" };
    }
    default:
      return { before: slide.body, after: "" };
  }
};

/**
 * #620: a figure part-way through counting up — "87%" at 0.5 is "76%" (eased), "$1.2m" is "$1.0m", "10,000+"
 * keeps its separators. The panel's build-in and the video's both count with this; the video page carries a
 * transcription of it (`SLIDE_PLAYER_JS`), held equal by a test that runs both.
 */
export const countUpText = (figure: string, progress: number): string => {
  const m = /^(\D*?)(\d(?:[\d.,]*\d)?)(.*)$/.exec(figure);
  if (m === null || progress >= 1) return figure;
  const [, prefix = "", digits = "", suffix = ""] = m;
  const last = Math.max(digits.lastIndexOf("."), digits.lastIndexOf(","));
  // A separator with exactly three digits after it groups thousands; any other is the decimal point.
  const decimal = last !== -1 && digits.length - last - 1 !== 3 ? digits[last]! : "";
  const group = decimal === "" ? (last === -1 ? "" : digits[last]!) : digits.slice(0, last).replace(/\d/g, "")[0] ?? "";
  const places = decimal === "" ? 0 : digits.length - last - 1;
  const intPart = decimal === "" ? digits : digits.slice(0, last);
  const value = Number(intPart.split(group === "" ? /(?!)/ : group).join("") + (decimal === "" ? "" : `.${digits.slice(last + 1)}`));
  const t = Math.max(0, progress);
  const eased = 1 - (1 - t) ** 3;
  const [whole = "0", fraction = ""] = (value * eased).toFixed(places).split(".");
  const grouped = group === "" ? whole : whole.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return `${prefix}${grouped}${places > 0 ? decimal + fraction : ""}${suffix}`;
};

/** A slide number as the design prints it: two digits. */
export const slideNumber = (n: number): string => String(n).padStart(2, "0");

/** #620: the big number a slide carries — a section's own number when its heading has one, else its position. */
export const slideIndexText = (slide: Slide, parts: SlideParts): string => (slide.layout === "section" && parts.figure !== undefined ? parts.figure : slideNumber(slide.index + 1));

/** #620: which of the three background compositions a slide wears, so a deck does not repeat one. */
export const slideVariant = (index: number): string => `v${index % 3}`;

/** #620: layouts that are a picture or a full colour field, and so carry no big slide number. */
export const hidesIndex = (layout: SlideLayout): boolean => layout === "title" || layout === "image" || isSplitLayout(layout);
/** #620: layouts that wear the decorative shapes when they have no picture. */
export const hasDeco = (layout: SlideLayout): boolean => layout === "title" || layout === "section" || layout === "cta";

/** The classes on a slide's root — the same list the panel puts on its own. */
export const slideClasses = (slide: Slide, input: { readonly format: SlideFormat; readonly dark: boolean; readonly background: boolean; readonly logo?: string }): string[] => [
  "slide",
  `l-${slide.layout}`,
  input.format === "16:9" ? "f-landscape" : "f-portrait",
  input.dark ? "tone-dark" : "tone-light",
  slideVariant(slide.index),
  ...(input.background ? ["has-bg"] : []),
  ...(input.logo === undefined ? [] : [`logo-${input.logo}`]),
];
