import { describe, expect, it } from "vitest";

import {
  HEADING_MAX_CHARS,
  HEADING_RATIO,
  bodySizeOf,
  linesFrom,
  structureFrom,
  type PdfTextItem,
} from "../pdf-structure.js";

/**
 * Recovering a PDF's headings from font size — #321.
 *
 * The issue's premise was `pypdf`, which *"has no layout model, so true markdown is not directly
 * available"*. There is no Python in this stack: `read_pdf` uses `unpdf`, whose `extractTextItems`
 * returns a `height` per item — the rendered font size. Verified against a real two-size PDF before
 * any of this was written: a 24pt line came back as `height: 24` and a 10pt line as `height: 10`.
 *
 * So the tests here are about the **heuristic**, not the parsing: given sizes, does the right line
 * become a heading? Driven from item arrays rather than PDFs, because that is the seam — a PDF fixture
 * would test `unpdf` as well and fail for two different reasons.
 */
const item = (str: string, height: number): PdfTextItem => ({ str, height });
/** `extractTextItems` emits an empty item per line break; that is the only line signal there is. */
const br = (): PdfTextItem => ({ str: "", height: 0 });

const BODY = "The roasting profile changed this week, and the difference is in the finish of the cup.";

describe("finding the body size", () => {
  it("weighs by characters, not by item", () => {
    /**
     * The decision that makes this work on a real document. Headings are split across items by every
     * kerning change, so a page with one title and nine hundred words of body can have more *items*
     * at the large size — while the body dominates on characters by an order of magnitude.
     */
    const items = [
      item("A", 24), item(" B", 24), item("ig", 24), item(" Ti", 24), item("tle", 24),
      br(),
      item(BODY, 10),
    ];
    expect(bodySizeOf(items)).toBe(10);
  });

  it("rounds to the half point, because one run is not three sizes", () => {
    // A producer emits 9.96 and 10.04 for the same paragraph; three buckets defeat the mode entirely.
    const items = [item(BODY, 9.96), item(BODY, 10.04), item(BODY, 10)];
    expect(bodySizeOf(items)).toBe(10);
  });

  it("ignores empty items and nonsense heights", () => {
    expect(bodySizeOf([br(), item("   ", 12), item(BODY, 11), item("x", Number.NaN), item("y", 0)])).toBe(11);
  });

  it("answers zero for nothing readable, rather than guessing", () => {
    expect(bodySizeOf([])).toBe(0);
    expect(bodySizeOf([br(), item("  ", 10)])).toBe(0);
  });
});

describe("the join across a wrapped line", () => {
  /**
   * The bug a synthetic fixture could never have shown, found by running a real browser-printed PDF.
   *
   * pdf.js emits one item per **visual line** with `hasEOL` on the one that ends it, and **no trailing
   * space** — the space *is* the line break. Joining them directly produced `we arebuilding`: a
   * corrupted word in the text a model reads. The flat `extractText` path joins with a newline, which
   * is why it never had this.
   */
  it("restores the space a line break stood for", () => {
    const items: PdfTextItem[] = [
      { str: "...but not right for what we are", height: 8.25, hasEOL: true },
      { str: "building.", height: 8.25, hasEOL: false },
    ];
    expect(linesFrom(items)[0]?.text).toBe("...but not right for what we are building.");
  });

  it("does not insert one across a kerning split inside a line", () => {
    // `hasEOL: false` means the same visual line continued — a style or kerning break, not a wrap.
    const items: PdfTextItem[] = [
      { str: "Ti", height: 24, hasEOL: false },
      { str: "tle", height: 24, hasEOL: false },
    ];
    expect(linesFrom(items)[0]?.text).toBe("Title");
  });

  it("does not double a space that is already there", () => {
    const items: PdfTextItem[] = [
      { str: "ends with a space ", height: 10, hasEOL: true },
      { str: "next", height: 10, hasEOL: false },
    ];
    expect(linesFrom(items)[0]?.text).toBe("ends with a space next");
  });

  it("does not carry a wrap across a paragraph break", () => {
    const items: PdfTextItem[] = [
      { str: "end of a paragraph", height: 10, hasEOL: true },
      { str: "", height: 0 },
      { str: "start of the next", height: 10, hasEOL: true },
    ];
    expect(linesFrom(items).map((line) => line.text)).toEqual(["end of a paragraph", "start of the next"]);
  });
});

describe("grouping items into lines", () => {
  it("joins a line's runs and takes its largest size", () => {
    /*
     * A heading with a trailing space set in the body size would otherwise average down into prose,
     * and the largest run is what a reader's eye takes the line to be.
     */
    const lines = linesFrom([item("Spring ", 18), item("lot", 18), item(" ", 10), br(), item(BODY, 10)]);
    expect(lines[0]).toEqual({ text: "Spring lot", size: 18 });
    expect(lines[1]?.size).toBe(10);
  });

  it("collapses whitespace inside a line and drops blank ones", () => {
    const lines = linesFrom([item("Two   ", 12), item("words", 12), br(), br(), item("  ", 12)]);
    expect(lines).toEqual([{ text: "Two words", size: 12 }]);
  });
});

describe("what becomes a heading", () => {
  const doc = (...lines: readonly (readonly [string, number])[]): PdfTextItem[] =>
    lines.flatMap(([text, size]) => [item(text, size), br()]);

  it("marks a line set larger than the body", () => {
    const { markdown, headingsFound } = structureFrom(doc(["Spring lot", 18], [BODY, 10]));
    expect(headingsFound).toBe(1);
    expect(markdown).toContain("# Spring lot");
    expect(markdown).toContain(BODY);
  });

  it("ranks levels by the sizes the document actually uses, not by absolute points", () => {
    /**
     * A document whose largest heading is 18pt and one whose largest is 48pt both start at `#`,
     * because what a reader recovers is a hierarchy rather than a typography.
     */
    const small = structureFrom(doc(["Title", 18], ["Section", 14], [BODY, 10]));
    const large = structureFrom(doc(["Title", 48], ["Section", 30], [BODY, 20]));
    expect(small.markdown).toContain("# Title");
    expect(small.markdown).toContain("## Section");
    expect(large.markdown).toContain("# Title");
    expect(large.markdown).toContain("## Section");
  });

  it("stops at three levels", () => {
    // Distinguishing a fourth level from a third by size alone is past what this signal can carry.
    const { markdown } = structureFrom(doc(["A", 30], ["B", 24], ["C", 18], ["D", 14], [BODY, 10]));
    expect(markdown).toContain("### C");
    expect(markdown).toContain("### D");
    expect(markdown).not.toContain("#### ");
  });

  it("refuses a paragraph however large it is set", () => {
    /**
     * Without the length rule, a document whose body is larger than its footnotes turns every
     * paragraph into an `##`: the mode picks the footnote size as "body" and the prose is 1.4× it.
     */
    const long = "x".repeat(HEADING_MAX_CHARS + 1);
    const { headingsFound } = structureFrom([
      item(long, 14), br(),
      item("a footnote".repeat(30), 9), br(),
    ]);
    expect(headingsFound).toBe(0);
  });

  it("ignores a size difference too small to mean anything", () => {
    // Producers emit 10 and 10.8 for one paragraph when a font falls back; every such line would
    // otherwise become a heading.
    const { headingsFound } = structureFrom(doc(["Nearly the same", 10.8], [BODY, 10]));
    expect(10.8 / 10).toBeLessThan(HEADING_RATIO);
    expect(headingsFound).toBe(0);
  });

  it("returns flat prose for a document with no headings, and says so", () => {
    /*
     * The honest answer for a document that has none — and for a scanned one, where every height is
     * identical. `headingsFound: 0` is what tells those apart from a document whose structure came
     * through, since the text looks the same either way.
     */
    const { markdown, headingsFound } = structureFrom(doc([BODY, 10], [BODY, 10]));
    expect(headingsFound).toBe(0);
    expect(markdown).not.toContain("#");
  });

  it("puts a blank line before every heading, or the markdown does not parse", () => {
    /**
     * `##` at the end of a paragraph's line is not a heading to any parser. A document whose headings
     * all fail to render is worse than one with none, because the `#` characters then read as text.
     */
    const { markdown } = structureFrom(doc([BODY, 10], ["Next section", 18], [BODY, 10]));
    const lines = markdown.split("\n");
    const at = lines.findIndex((line) => line.startsWith("#"));
    expect(at).toBeGreaterThan(0);
    expect(lines[at - 1]).toBe("");
  });

  it("does not open with a blank line", () => {
    const { markdown } = structureFrom(doc(["Title", 20], [BODY, 10]));
    expect(markdown.startsWith("#")).toBe(true);
  });

  it("keeps every line of prose — structure must not cost content", () => {
    /**
     * The property the caller's length guard also checks, asserted here at the source: a pass that
     * recovered two headings while dropping a third of the prose would be a worse read that looked
     * like a better one.
     */
    const body = ["First paragraph here.", "Second paragraph here.", "Third paragraph here."];
    const { markdown } = structureFrom([
      item("A Heading", 20), br(),
      ...body.flatMap((line) => [item(line, 10), br()]),
    ]);
    for (const line of body) expect(markdown).toContain(line);
  });

  it("answers empty for an empty document rather than throwing", () => {
    expect(structureFrom([])).toEqual({ markdown: "", headingsFound: 0 });
    expect(structureFrom([br(), br()])).toEqual({ markdown: "", headingsFound: 0 });
  });
});
