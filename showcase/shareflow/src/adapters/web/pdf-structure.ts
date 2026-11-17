/**
 * Recovering a PDF's headings from font size — #321.
 *
 * ## The premise the issue was written on is no longer true
 *
 * #321 says *"`pypdf` extracts text but has no layout model, so true markdown (headings, tables) is
 * not directly available from it"*, and offers three options: heuristics over flat text (*"cheap,
 * unreliable on real decks"*), `pymupdf4llm` (AGPL, and Python), or an ML model (*"far too heavy"*).
 *
 * There is no Python in this stack any more. `read_pdf` uses **`unpdf`**, and `unpdf` exposes
 * `extractTextItems`, which returns a `height` per text item — the rendered font size. Verified
 * against a PDF with two sizes before this was written: a 24pt line came back as `height: 24` and a
 * 10pt line as `height: 10`.
 *
 * So the signal the issue assumed was missing is already there, from a dependency that is already
 * installed and already used by this exact tool. That is what makes this worth doing rather than the
 * heuristic the issue rightly doubted.
 *
 * ## What it does and does not claim
 *
 * A heading is **larger than the body text**. That is the whole rule, and it is deliberately the whole
 * rule: bold-vs-regular needs font-name parsing that differs per producer, position needs a column
 * model, and numbering (`1.2.3`) is a convention rather than a fact. Size is the one signal that is
 * both universal and directly measured.
 *
 * It will miss a heading set in the body size and bolded, and it will invent one from a pull-quote set
 * large. Both are stated in the tool's own output rather than hidden — `headingsFound` is reported so
 * a caller can tell a structured read from a flat one.
 *
 * It does **not** attempt tables. A table is a position problem, not a size one, and pretending
 * otherwise would produce a markdown table whose columns are wrong — which is worse than the prose
 * that is there now, because it looks authoritative.
 */

/**
 * One text item as `unpdf` returns it.
 *
 * `height` is the rendered font size — the signal this whole module turns on. `hasEOL` marks the item
 * that ends a **visual line**, and it is not optional in practice: pdf.js sets it on every item, and
 * without it a wrapped word is destroyed. See `linesFrom`.
 *
 * Typed as optional only because a caller may hand over items from somewhere else, and losing the
 * structure pass is better than refusing the read.
 */
export type PdfTextItem = {
  readonly str: string;
  readonly height: number;
  readonly hasEOL?: boolean;
};

/**
 * The body size: the height that the most **characters** are set in.
 *
 * Weighted by length rather than counted by item, and that is the decision that makes this work on a
 * real document. A page with one 28pt title, four 14pt subheadings and nine hundred words of 10pt body
 * has more *items* at large sizes than you would guess — headings are split across items by every
 * kerning change — while the body dominates on characters by an order of magnitude.
 *
 * Rounded to the nearest half point before counting, because a producer emits 9.96 and 10.04 for the
 * same run and three buckets for one body size defeats the mode entirely.
 */
export const bodySizeOf = (items: readonly PdfTextItem[]): number => {
  const weight = new Map<number, number>();
  for (const item of items) {
    const text = item.str.trim();
    if (text === "" || !Number.isFinite(item.height) || item.height <= 0) continue;
    const size = Math.round(item.height * 2) / 2;
    weight.set(size, (weight.get(size) ?? 0) + text.length);
  }
  let body = 0;
  let most = 0;
  for (const [size, chars] of weight) {
    // Ties go to the smaller size: body text is smaller than headings, and a document whose title and
    // body happen to weigh the same is one where treating the larger as a heading is the safer guess.
    if (chars > most || (chars === most && size < body)) {
      most = chars;
      body = size;
    }
  }
  return body;
};

/**
 * How much larger than the body a line must be to count as a heading.
 *
 * 1.15 rather than something rounder, and it is a judgement rather than a measurement. Below about
 * 1.1 the noise wins: producers emit 10 and 10.8 for the same paragraph when a font falls back, and
 * every such line would become an `##`. Above about 1.25 an `<h3>` set two points up from the body —
 * which is extremely common in a report — stops being seen at all.
 *
 * Named so it can be argued with rather than buried in a comparison.
 */
export const HEADING_RATIO = 1.15;

/**
 * A heading has to be short enough to be one.
 *
 * Without this, a document whose body is set larger than its footnotes turns every paragraph into an
 * `##`: the mode picks the footnote size as "body" and the actual prose is 1.4× larger. A paragraph is
 * not a heading however big it is set, and the length is what says so.
 */
export const HEADING_MAX_CHARS = 120;

/** One line of a page: the text, and the size it was set in. */
type Line = { text: string; size: number };

/**
 * Text items grouped into blocks — a heading or a paragraph.
 *
 * Two signals, and getting the second one wrong **corrupts words**:
 *
 * **An empty item ends a block.** `extractTextItems` emits one between paragraphs, and that is what
 * separates a heading from the prose under it.
 *
 * **`hasEOL` ends a visual line inside a block**, and the join across it needs a space. This was found
 * by running a real browser-printed PDF rather than by reasoning: pdf.js emits
 * `{str: "…for what we are", hasEOL: true}` then `{str: "building."}`, with no trailing space on the
 * first, because the space *is* the line break. Joining them directly produced `we arebuilding` — a
 * corrupted word in the text a model reads, and one that would have shipped, because a synthetic
 * fixture has no wrapped lines to expose it. The flat `extractText` path joins the same items with a
 * newline, which is why it never had this bug.
 *
 * Items **without** `hasEOL` are a kerning or style split inside one line (`"Ti"` + `"tle"`) and are
 * joined directly. That distinction is exactly why the flag is needed rather than a blanket space.
 *
 * A block's size is the **largest** item in it. A heading with a trailing space set in the body size
 * would otherwise average down into prose, and the largest run is what a reader's eye takes it to be.
 */
export const linesFrom = (items: readonly PdfTextItem[]): Line[] => {
  const lines: Line[] = [];
  let text = "";
  let size = 0;
  let wrapped = false;

  const flush = () => {
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (trimmed !== "") lines.push({ text: trimmed, size });
    text = "";
    size = 0;
    wrapped = false;
  };

  for (const item of items) {
    if (item.str.trim() === "") {
      flush();
      continue;
    }
    // The space the line break stood for. Only where the previous item actually ended a line, and
    // only when neither side already carries one.
    if (wrapped && text !== "" && !/\s$/.test(text) && !/^\s/.test(item.str)) text += " ";
    text += item.str;
    wrapped = item.hasEOL === true;
    if (Number.isFinite(item.height) && item.height > size) size = item.height;
  }
  flush();
  return lines;
};

export type PdfStructure = {
  /** The document as markdown: headings marked, everything else as paragraphs. */
  readonly markdown: string;
  /** How many headings were recovered. Zero means the read is flat — say so rather than implying structure. */
  readonly headingsFound: number;
};

/**
 * A page's text items as markdown.
 *
 * Heading levels come from **rank among the sizes actually present**, not from absolute points: a
 * document whose largest heading is 18pt and one whose largest is 48pt both start at `#`, because what
 * a reader recovers from a document is its hierarchy and not its typography. Capped at `###` —
 * distinguishing a fourth level from a third by size alone is past what this signal can carry.
 *
 * Returns the prose unchanged when nothing stands out, which is the honest answer for a document that
 * has no headings — and for a scanned one, where every height is the same.
 */
export const structureFrom = (items: readonly PdfTextItem[]): PdfStructure => {
  const lines = linesFrom(items);
  if (lines.length === 0) return { markdown: "", headingsFound: 0 };

  const body = bodySizeOf(items);
  const isHeading = (line: Line): boolean =>
    body > 0 && line.size >= body * HEADING_RATIO && line.text.length <= HEADING_MAX_CHARS;

  /*
   * The distinct heading sizes, largest first — the hierarchy this document actually uses. Rounded
   * for the same reason `bodySizeOf` rounds: 17.9 and 18.1 are one level.
   */
  const levels = [...new Set(lines.filter(isHeading).map((line) => Math.round(line.size * 2) / 2))].sort(
    (a, b) => b - a,
  );

  const out: string[] = [];
  let headingsFound = 0;
  for (const line of lines) {
    if (isHeading(line)) {
      const rank = levels.indexOf(Math.round(line.size * 2) / 2);
      out.push(`${"#".repeat(Math.min(rank + 1, 3))} ${line.text}`);
      headingsFound += 1;
    } else {
      out.push(line.text);
    }
  }

  /*
   * A blank line before every heading, so the markdown is valid rather than merely marked up: `##` at
   * the end of a paragraph's line is not a heading to any parser, and a document whose headings all
   * fail to render is worse than one with none.
   */
  const spaced: string[] = [];
  for (const [index, line] of out.entries()) {
    if (line.startsWith("#") && index > 0 && spaced[spaced.length - 1] !== "") spaced.push("");
    spaced.push(line);
  }

  return { markdown: spaced.join("\n").trim(), headingsFound };
};
