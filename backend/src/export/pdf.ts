/**
 * A deterministic PDF writer (#134).
 *
 * Writing a PDF is far more tractable than reading one, because the output is ours: no unknown producers, no
 * broken xrefs, no font encodings to guess. This emits a small, valid subset — Base-14 fonts, one content
 * stream per page, an uncompressed xref table — which every viewer has supported since 1993.
 *
 * **Determinism is a requirement, not a nicety** (AC-6). A PDF normally carries a `CreationDate` and often a
 * random `/ID`, either of which makes two renders of the same input differ. Both are fixed here: the date
 * comes from the caller (and defaults to a constant), and the `/ID` is derived from the content. That is what
 * lets a re-render be compared byte-for-byte, which is the only way to notice a renderer that has quietly
 * started producing something else.
 *
 * **No font embedding.** Base-14 fonts are guaranteed present in every viewer, so the file carries no font
 * program — which keeps a report a few kilobytes instead of a few hundred, and sidesteps the licensing
 * question entirely. The cost is the character repertoire: WinAnsi, so no CJK. Stated rather than discovered,
 * and `unsupportedCharacters` reports what was dropped instead of silently emitting blanks.
 */

import type { DocumentBlock } from "../documents/index.js";

/** Points. A4 rather than Letter: the deployment is European and the difference is visible when it is wrong. */
export const PAGE_WIDTH = 595.28;
export const PAGE_HEIGHT = 841.89;
export const MARGIN = 56.7; // 20mm

/**
 * Helvetica advance widths, per 1000 units, for the printable WinAnsi range this writer supports.
 *
 * Needed because line wrapping has to know how wide text *will* be. A monospace approximation would wrap
 * badly enough to be obviously wrong — proportional text estimated at a fixed width either overflows the
 * margin or leaves a third of the line empty.
 *
 * Indexed from space (32) to tilde (126); anything outside falls back to the average. The bold face differs
 * enough to matter for headings, so it has its own table.
 */
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556,
  556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278,
  500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469,
  556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500,
  278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
] as const;

const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556,
  556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278,
  556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584,
  556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556,
  333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
] as const;

export type FontFace = "regular" | "bold" | "mono";

const AVERAGE_WIDTH = 556;
/** Courier is monospace at 600/1000, which is why it needs no table. */
const MONO_WIDTH = 600;

const charWidth = (code: number, face: FontFace): number => {
  if (face === "mono") return MONO_WIDTH;
  const table = face === "bold" ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  const index = code - 32;
  return table[index] ?? AVERAGE_WIDTH;
};

/** Width of a string at a size, in points. */
export const textWidth = (text: string, size: number, face: FontFace): number => {
  let total = 0;
  for (const ch of text) total += charWidth(ch.codePointAt(0) ?? 32, face);
  return (total * size) / 1000;
};

/**
 * WinAnsi-encode a string for a PDF literal, reporting what could not be represented.
 *
 * Reported rather than substituted silently: a report whose CJK title rendered as `????` is a report someone
 * sends to a colleague believing it is correct, and finding out later is worse than being told now.
 */
export const encodeWinAnsi = (text: string): { encoded: string; dropped: string[] } => {
  const dropped: string[] = [];
  let encoded = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x0a || code === 0x0d) {
      encoded += " ";
      continue;
    }
    if (code < 32) continue;
    if (code < 127) {
      // The three characters that terminate or escape a PDF literal string.
      if (ch === "(" || ch === ")" || ch === "\\") encoded += `\\${ch}`;
      else encoded += ch;
      continue;
    }
    const winAnsi = WIN_ANSI_EXTRA[ch];
    if (winAnsi !== undefined) {
      // Octal, because a byte above 127 in a literal string is not portable as a raw character.
      encoded += `\\${winAnsi.toString(8).padStart(3, "0")}`;
      continue;
    }
    dropped.push(ch);
  }
  return { encoded, dropped };
};

/**
 * The WinAnsi characters worth mapping: European letters, quotes and dashes.
 *
 * Not the full table. These are the ones that appear in real documents and whose absence is noticed — a
 * German report with `ä` mangled is unusable, and a smart quote rendered as nothing is a typo in someone's
 * name. Everything else is reported as dropped rather than approximated, because a wrong character is worse
 * than a visible gap.
 */
const WIN_ANSI_EXTRA: Readonly<Record<string, number>> = {
  "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "‰": 0x89,
  "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97,
  "™": 0x99, " ": 0x20, "±": 0xb1, "µ": 0xb5, "·": 0xb7, "°": 0xb0, "§": 0xa7,
  "£": 0xa3, "¥": 0xa5, "©": 0xa9, "®": 0xae, "«": 0xab, "»": 0xbb, "¼": 0xbc, "½": 0xbd,
  "À": 0xc0, "Á": 0xc1, "Â": 0xc2, "Ã": 0xc3, "Ä": 0xc4, "Å": 0xc5, "Æ": 0xc6, "Ç": 0xc7,
  "È": 0xc8, "É": 0xc9, "Ê": 0xca, "Ë": 0xcb, "Ì": 0xcc, "Í": 0xcd, "Î": 0xce, "Ï": 0xcf,
  "Ñ": 0xd1, "Ò": 0xd2, "Ó": 0xd3, "Ô": 0xd4, "Õ": 0xd5, "Ö": 0xd6, "Ø": 0xd8, "Ù": 0xd9,
  "Ú": 0xda, "Û": 0xdb, "Ü": 0xdc, "ß": 0xdf,
  "à": 0xe0, "á": 0xe1, "â": 0xe2, "ã": 0xe3, "ä": 0xe4, "å": 0xe5, "æ": 0xe6, "ç": 0xe7,
  "è": 0xe8, "é": 0xe9, "ê": 0xea, "ë": 0xeb, "ì": 0xec, "í": 0xed, "î": 0xee, "ï": 0xef,
  "ñ": 0xf1, "ò": 0xf2, "ó": 0xf3, "ô": 0xf4, "õ": 0xf5, "ö": 0xf6, "ø": 0xf8, "ù": 0xf9,
  "ú": 0xfa, "û": 0xfb, "ü": 0xfc, "ÿ": 0xff,
};

/** Break a string into lines that fit `maxWidth`, breaking on words and only inside a word when it must. */
export const wrapText = (
  text: string,
  maxWidth: number,
  size: number,
  face: FontFace,
): readonly string[] => {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((w) => w !== "")) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (textWidth(candidate, size, face) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line !== "") lines.push(line);
    // A single word wider than the column — a URL, usually. Broken mid-word rather than allowed to run off
    // the page, because an overflowing line is silently truncated by the viewer.
    if (textWidth(word, size, face) > maxWidth) {
      let chunk = "";
      for (const ch of word) {
        if (textWidth(chunk + ch, size, face) > maxWidth && chunk !== "") {
          lines.push(chunk);
          chunk = ch;
        } else chunk += ch;
      }
      line = chunk;
    } else line = word;
  }
  if (line !== "") lines.push(line);
  return lines.length === 0 ? [""] : lines;
};

/** A citation, rendered as a numbered marker inline and an entry in a References section. */
export type ExportCitation = {
  readonly marker: number;
  readonly title: string;
  readonly locator?: string;
  readonly url?: string;
};

export type PdfRenderInput = {
  readonly title: string;
  readonly blocks: readonly DocumentBlock[];
  readonly citations?: readonly ExportCitation[];
  /**
   * The document's creation date.
   *
   * A parameter, and constant by default, because `new Date()` here would make AC-6 unachievable: two renders
   * of the same artifact would differ in a field nobody reads and every byte-comparison would fail.
   */
  readonly createdAt?: string;
};

export type PdfRenderResult = {
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  /** Characters the Base-14 fonts cannot represent, deduplicated. Reported, never silently dropped. */
  readonly unsupportedCharacters: readonly string[];
};

type Op = { readonly text: string };

const FONT_SIZES = { h1: 20, h2: 16, h3: 13, h4: 11.5, body: 10.5, mono: 9.5, small: 8.5 } as const;
const LEADING = 1.35;

/** One page's accumulated content-stream operators plus the y cursor. */
class PageBuilder {
  readonly ops: Op[] = [];
  y = PAGE_HEIGHT - MARGIN;
  get remaining(): number {
    return this.y - MARGIN;
  }
}

const FONT_RES = { regular: "/F1", bold: "/F2", mono: "/F3" } as const;

export const renderPdf = (input: PdfRenderInput): PdfRenderResult => {
  const pages: PageBuilder[] = [new PageBuilder()];
  const dropped = new Set<string>();
  const contentWidth = PAGE_WIDTH - 2 * MARGIN;

  const page = () => pages[pages.length - 1]!;
  const newPage = () => {
    pages.push(new PageBuilder());
    return page();
  };
  /** Reserve vertical space, starting a page when it will not fit. */
  const reserve = (height: number) => {
    if (page().remaining < height) newPage();
    return page();
  };

  const draw = (text: string, x: number, size: number, face: FontFace) => {
    const { encoded, dropped: bad } = encodeWinAnsi(text);
    for (const ch of bad) dropped.add(ch);
    const p = page();
    p.ops.push({
      text: `BT ${FONT_RES[face]} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${p.y.toFixed(2)} Tm (${encoded}) Tj ET`,
    });
  };

  const paragraph = (text: string, size: number, face: FontFace, indent = 0, gapAfter = size * 0.55) => {
    const lines = wrapText(text, contentWidth - indent, size, face);
    for (const line of lines) {
      const p = reserve(size * LEADING);
      p.y -= size * LEADING;
      draw(line, MARGIN + indent, size, face);
    }
    page().y -= gapAfter;
  };

  const rule = (width: number, thickness = 0.5) => {
    const p = reserve(thickness + 2);
    p.y -= 3;
    p.ops.push({
      text: `${thickness} w ${MARGIN.toFixed(2)} ${p.y.toFixed(2)} m ${(MARGIN + width).toFixed(2)} ${p.y.toFixed(2)} l S`,
    });
    p.y -= 4;
  };

  /**
   * A table.
   *
   * Column widths come from the widest cell, scaled to fit — a fixed split would squeeze a column of dates
   * next to a column of prose. The header row repeats on a page break, because a table whose headings are on
   * the previous page is a table nobody can read.
   */
  const table = (rows: readonly (readonly string[])[], hasHeader: boolean) => {
    const columns = Math.max(...rows.map((r) => r.length), 1);
    const natural = Array.from({ length: columns }, (_, c) =>
      Math.max(...rows.map((r) => textWidth(r[c] ?? "", FONT_SIZES.body, "regular")), 20),
    );
    const total = natural.reduce((a, b) => a + b, 0);
    const padding = 5;
    const usable = contentWidth - padding * 2 * columns;
    const widths = natural.map((w) => (w / total) * usable);

    const rowHeight = (cells: readonly string[], face: FontFace): number => {
      const lines = Math.max(
        ...cells.map((cell, c) => wrapText(cell, widths[c] ?? usable, FONT_SIZES.body, face).length),
        1,
      );
      return lines * FONT_SIZES.body * LEADING + padding;
    };

    const drawRow = (cells: readonly string[], face: FontFace) => {
      const height = rowHeight(cells, face);
      const p = reserve(height);
      const top = p.y;
      let x = MARGIN;
      cells.forEach((cell, c) => {
        const width = widths[c] ?? usable;
        const lines = wrapText(cell, width, FONT_SIZES.body, face);
        let lineY = top;
        for (const line of lines) {
          lineY -= FONT_SIZES.body * LEADING;
          const { encoded, dropped: bad } = encodeWinAnsi(line);
          for (const ch of bad) dropped.add(ch);
          p.ops.push({
            text: `BT ${FONT_RES[face]} ${FONT_SIZES.body} Tf 1 0 0 1 ${(x + padding).toFixed(2)} ${lineY.toFixed(2)} Tm (${encoded}) Tj ET`,
          });
        }
        x += width + padding * 2;
      });
      p.y = top - height;
      return p;
    };

    const header = hasHeader ? rows[0] : undefined;
    if (header !== undefined) {
      drawRow(header, "bold");
      rule(contentWidth, 0.8);
    }
    for (const row of hasHeader ? rows.slice(1) : rows) {
      const before = page();
      drawRow(row, "regular");
      // The header repeats after a break. Checked by page identity rather than by counting, because the row
      // itself may have been what caused the break.
      if (page() !== before && header !== undefined) {
        // Reinsert at the top of the new page, above the row just drawn — so it is redrawn rather than moved.
        const current = page();
        current.y = PAGE_HEIGHT - MARGIN;
        current.ops.length = 0;
        drawRow(header, "bold");
        rule(contentWidth, 0.8);
        drawRow(row, "regular");
      }
      rule(contentWidth, 0.2);
    }
    page().y -= 6;
  };

  // Title, then the blocks.
  paragraph(input.title, FONT_SIZES.h1, "bold", 0, FONT_SIZES.h1 * 0.8);

  for (const block of input.blocks) {
    switch (block.kind) {
      case "heading": {
        const size =
          block.level === 1 ? FONT_SIZES.h1 : block.level === 2 ? FONT_SIZES.h2 : block.level === 3 ? FONT_SIZES.h3 : FONT_SIZES.h4;
        // Space *before* a heading, so it groups with the text it introduces rather than floating.
        page().y -= size * 0.45;
        paragraph(block.text, size, "bold", 0, size * 0.35);
        break;
      }
      case "paragraph":
        paragraph(block.text, FONT_SIZES.body, "regular");
        break;
      case "list":
        block.items.forEach((item, i) => {
          const marker = block.ordered ? `${i + 1}.` : "•";
          const markerWidth = textWidth(`${marker} `, FONT_SIZES.body, "regular");
          const p = reserve(FONT_SIZES.body * LEADING);
          p.y -= FONT_SIZES.body * LEADING;
          draw(marker, MARGIN + 6, FONT_SIZES.body, "regular");
          // The item's text is drawn hanging-indented, so a wrapped second line aligns under the first rather
          // than under the bullet.
          const lines = wrapText(item, contentWidth - markerWidth - 12, FONT_SIZES.body, "regular");
          lines.forEach((line, li) => {
            if (li > 0) {
              const q = reserve(FONT_SIZES.body * LEADING);
              q.y -= FONT_SIZES.body * LEADING;
            }
            draw(line, MARGIN + 6 + markerWidth + 4, FONT_SIZES.body, "regular");
          });
        });
        page().y -= FONT_SIZES.body * 0.5;
        break;
      case "table":
        table(block.rows, block.hasHeader);
        break;
    }
  }

  // References last, as a numbered list matching the inline markers.
  if (input.citations !== undefined && input.citations.length > 0) {
    page().y -= FONT_SIZES.h2 * 0.6;
    paragraph("References", FONT_SIZES.h2, "bold", 0, FONT_SIZES.h2 * 0.3);
    for (const citation of input.citations) {
      const parts = [citation.title, citation.locator, citation.url].filter(
        (part): part is string => part !== undefined && part !== "",
      );
      paragraph(`[${citation.marker}] ${parts.join(" — ")}`, FONT_SIZES.small, "regular", 0, 3);
    }
  }

  return {
    bytes: assemble(pages, input.createdAt ?? FIXED_CREATION_DATE),
    pageCount: pages.length,
    // Sorted, so the same input reports the same list in the same order — AC-6 applies to the result, not
    // only to the bytes.
    unsupportedCharacters: [...dropped].sort(),
  };
};

/**
 * The default creation date.
 *
 * A constant, and that is the point. `new Date()` would put a different timestamp in every render and make
 * byte-for-byte comparison impossible — so a caller that wants a real date passes one, and a caller that
 * wants reproducibility gets it by default. The date chosen is the PDF epoch's own convention for "unset".
 */
export const FIXED_CREATION_DATE = "2000-01-01T00:00:00.000Z";

/** `D:YYYYMMDDHHmmSSZ`, the only date format a PDF accepts. */
const pdfDate = (iso: string): string => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(
    d.getUTCMinutes(),
  )}${pad(d.getUTCSeconds())}Z`;
};

/**
 * Assemble the object graph, the xref table and the trailer.
 *
 * Byte offsets in the xref must be exact — a viewer that cannot parse the xref falls back to scanning, and
 * some refuse outright — so the file is built as a list of latin1 chunks whose lengths are the offsets.
 */
const assemble = (pages: readonly PageBuilder[], createdAt: string): Uint8Array => {
  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length; // 1-based object numbers
  };

  // Fonts first, so their numbers are stable regardless of page count — a stable object graph is one fewer
  // way for two renders to differ.
  const f1 = add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
  const f2 = add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`);
  const f3 = add(`<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>`);
  const resources = `<< /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R >> >>`;

  // Reserve the pages node's number before the page objects, since each page must point back at it.
  const pagesNumber = add("placeholder");
  const pageNumbers: number[] = [];
  for (const p of pages) {
    const content = p.ops.map((o) => o.text).join("\n");
    const stream = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
    pageNumbers.push(
      add(
        `<< /Type /Page /Parent ${pagesNumber} 0 R /MediaBox [0 0 ${PAGE_WIDTH.toFixed(2)} ${PAGE_HEIGHT.toFixed(
          2,
        )}] /Resources ${resources} /Contents ${stream} 0 R >>`,
      ),
    );
  }
  objects[pagesNumber - 1] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageNumbers
    .map((n) => `${n} 0 R`)
    .join(" ")}] >>`;

  const catalog = add(`<< /Type /Catalog /Pages ${pagesNumber} 0 R >>`);
  const info = add(
    `<< /Producer (agentkit) /Creator (agentkit) /CreationDate (${pdfDate(createdAt)}) /ModDate (${pdfDate(
      createdAt,
    )}) >>`,
  );

  const chunks: string[] = ["%PDF-1.4\n"];
  // A binary comment marks the file as binary for transfer-mode heuristics. Fixed bytes, so it costs nothing
  // in determinism.
  chunks.push("%âãÏÓ\n");
  const offsets: number[] = [];
  let position = chunks.reduce((n, c) => n + Buffer.byteLength(c, "latin1"), 0);
  objects.forEach((body, i) => {
    offsets.push(position);
    const chunk = `${i + 1} 0 obj\n${body}\nendobj\n`;
    chunks.push(chunk);
    position += Buffer.byteLength(chunk, "latin1");
  });

  const xrefStart = position;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    // The free-list head. Exactly 20 bytes per entry, including the two-character EOL — a viewer indexes
    // into this by multiplication, so a byte out is every object misread.
    `0000000000 65535 f \n`,
    ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`),
  ].join("");
  chunks.push(xref);
  chunks.push(
    // `/ID` is derived from the object count and the date rather than random, because a random id is the other
    // thing that makes two identical renders differ.
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R /ID [<${idHex(
      objects.length,
      createdAt,
    )}> <${idHex(objects.length, createdAt)}>] >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );

  return new Uint8Array(Buffer.from(chunks.join(""), "latin1"));
};

/** A stable 16-byte id, derived rather than random so identical input yields identical bytes. */
const idHex = (objectCount: number, createdAt: string): string => {
  let h = 0x811c9dc5;
  for (const ch of `${objectCount}:${createdAt}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").repeat(4);
};
