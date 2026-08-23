/**
 * PDF text extraction (#131).
 *
 * Over the raw PDF syntax, with `node:zlib` for the compressed streams and no dependency. That is a real
 * decision with real limits, so they are stated here rather than discovered later.
 *
 * **What it handles.** PDFs produced by the tools people actually use — Word, LaTeX, Chrome's print-to-PDF,
 * Google Docs, most report generators. It walks the content streams, follows the text operators, and uses the
 * positioning operators to reconstruct lines and paragraphs. Font size changes become heading levels, because
 * a PDF has no headings: it has text that happens to be bigger, and inferring from that is the only signal
 * available.
 *
 * **What it does not handle**, each of which is reported as a typed failure rather than as empty text:
 *
 * - **Encrypted documents.** Detected by `/Encrypt` in the trailer and refused. Extracting from one would
 *   mean implementing the standard security handler, which is a decryption tool wearing a parser's clothes.
 * - **Scans with no text layer.** A photograph of a page contains no text operators at all. Reported as
 *   `no-text-layer`, which is the answer that sends someone to OCR instead of to a bug report.
 * - **Custom-encoded embedded fonts.** A Type0/CID font with an embedded `ToUnicode` map needs that map
 *   applied; without it the bytes are glyph indices, not characters. Detected as mojibake and warned about
 *   rather than silently returned as text — a garbled answer is worse than a refusal.
 *
 * Tables are the honest weak spot and the comment on `groupIntoBlocks` says how far it gets: a PDF does not
 * contain tables, it contains text at coordinates, and column inference from coordinates is a heuristic. It
 * recovers regular grids and says so when it is unsure.
 */

import { inflateSync } from "node:zlib";
import type {
  DocumentBlock,
  DocumentParser,
  ExtractedDocument,
  ExtractionFailure,
  ExtractionLimits,
  HeadingLevel,
} from "../index.js";
import { createBlockBuilder } from "./text.js";

/**
 * Emitted when the inflated total is cut off.
 *
 * A named constant because a test asserting on it is asserting on the bound itself. The alternative — checking
 * that *something* was truncated — passes when the block or text ceiling fires instead, which is a different
 * bound and does nothing to stop the decompression work.
 */
export const DECOMPRESSION_LIMIT_WARNING =
  "Stopped decompressing: the document's streams expand past the allowed size.";

/** A run of text with where it was drawn. Coordinates are the only structure a PDF actually carries. */
type Fragment = {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly page: number;
};

const ascii = (bytes: Uint8Array): string =>
  // latin1, not utf-8: PDF syntax is bytes, and decoding the structure as UTF-8 would corrupt the binary
  // stream data sitting inside it. Text content is decoded separately, per string.
  Buffer.from(bytes).toString("latin1");

/**
 * `\` escapes inside a PDF literal string.
 *
 * Including the line continuation, which is the one people forget: a backslash at end of line means "no
 * character here", and treating it as a literal backslash inserts one into every wrapped string.
 */
export const unescapePdfString = (raw: string): string => {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break;
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else if (next === "b") out += "\b";
    else if (next === "f") out += "\f";
    else if (next === "\n") {
      // Line continuation: contributes nothing.
    } else if (next === "\r") {
      if (raw[i + 2] === "\n") i += 1;
    } else if (next >= "0" && next <= "7") {
      // Up to three octal digits, and no more — `\0501` is a character followed by a `1`.
      let octal = "";
      let j = i + 1;
      while (j < raw.length && octal.length < 3 && raw[j] !== undefined && raw[j]! >= "0" && raw[j]! <= "7") {
        octal += raw[j];
        j += 1;
      }
      out += String.fromCharCode(Number.parseInt(octal, 8));
      i = j;
      continue;
    } else out += next;
    i += 2;
  }
  return out;
};

/** A hex string, `<48656C6C6F>`. An odd final digit is padded with zero, as the spec requires. */
export const decodeHexString = (raw: string): string => {
  const hex = raw.replace(/[^0-9A-Fa-f]/g, "");
  const padded = hex.length % 2 === 1 ? `${hex}0` : hex;
  let out = "";
  for (let i = 0; i < padded.length; i += 2) out += String.fromCharCode(Number.parseInt(padded.slice(i, i + 2), 16));
  return out;
};

/**
 * The content streams, decompressed.
 *
 * Streams are located by scanning for `stream`/`endstream` rather than by walking the xref table. The xref is
 * the correct route and also the one that breaks first: an incrementally-updated or linearised PDF has
 * several, a damaged one has a wrong offset, and a scan finds the content either way. The cost is that
 * non-content streams (fonts, images) are also found — they simply yield no text operators.
 */
const contentStreams = (
  raw: string,
  limits: ExtractionLimits,
): { streams: string[]; warnings: string[]; hitDecompressionLimit: boolean } => {
  const streams: string[] = [];
  const warnings: string[] = [];
  let hitDecompressionLimit = false;
  let index = 0;
  let inflatedBytes = 0;

  while (index < raw.length) {
    const start = raw.indexOf("stream", index);
    if (start === -1) break;
    // `endstream`/`endobj` also contain "stream"; require the keyword to stand alone.
    const before = raw[start - 1];
    if (before !== undefined && /[A-Za-z]/.test(before)) {
      index = start + 6;
      continue;
    }
    let dataStart = start + "stream".length;
    if (raw[dataStart] === "\r") dataStart += 1;
    if (raw[dataStart] === "\n") dataStart += 1;
    const end = raw.indexOf("endstream", dataStart);
    if (end === -1) break;

    // The dictionary immediately before the keyword says how this stream is encoded.
    const dictStart = raw.lastIndexOf("<<", start);
    const dict = dictStart === -1 ? "" : raw.slice(dictStart, start);
    const body = raw.slice(dataStart, end);
    index = end + "endstream".length;

    if (/\/Subtype\s*\/(Image|Form1)/.test(dict) && !/\/FlateDecode/.test(dict)) continue;

    if (/\/FlateDecode/.test(dict)) {
      try {
        const out = inflateSync(Buffer.from(body, "latin1"));
        // The decompression bomb bound. A single-page PDF can carry a stream that inflates to gigabytes, so
        // the ceiling is on the *inflated* total and not on the file — checking the file size alone is the
        // check that does not stop this.
        inflatedBytes += out.byteLength;
        if (inflatedBytes > limits.maxTextBytes * 4) {
          warnings.push(DECOMPRESSION_LIMIT_WARNING);
          hitDecompressionLimit = true;
          break;
        }
        streams.push(out.toString("latin1"));
      } catch {
        // A stream that will not inflate is usually a font or an image subtype this scan picked up, not a
        // broken document, so it is skipped rather than failing the whole file.
      }
      continue;
    }
    if (!/\/Filter/.test(dict)) streams.push(body);
  }
  return { streams, warnings, hitDecompressionLimit };
};

/**
 * Walk one content stream's text operators.
 *
 * A small state machine over the operators that move or draw text: `Tf` (font and size), `Td`/`TD`/`Tm`/`T*`
 * (position), `TL` (leading), `Tj`/`'`/`"` (show), `TJ` (show array). Everything else is ignored, which is
 * most of a PDF — paths, colours and clipping have no bearing on the text.
 */
const readFragments = (stream: string, page: number, into: Fragment[]): void => {
  let x = 0;
  let y = 0;
  let size = 12;
  let leading = 0;
  let index = 0;

  const push = (text: string) => {
    if (text !== "") into.push({ text, x, y, size, page });
  };

  const numbersBefore = (at: number, count: number): number[] => {
    // Operands precede their operator in PostScript-like syntax, so the arguments are behind us.
    const chunk = stream.slice(Math.max(0, at - 120), at);
    const found = chunk.match(/-?\d*\.?\d+/g) ?? [];
    return found.slice(-count).map(Number);
  };

  while (index < stream.length) {
    const char = stream[index];

    if (char === "(") {
      // Literal string. Nesting is legal and unescaped parens must balance, so depth is tracked.
      let depth = 1;
      let raw = "";
      let j = index + 1;
      while (j < stream.length && depth > 0) {
        const c = stream[j];
        if (c === "\\") {
          raw += c;
          raw += stream[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (c === "(") depth += 1;
        if (c === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
        raw += c;
        j += 1;
      }
      const text = unescapePdfString(raw);
      // Which operator follows decides whether this string is drawn and whether the line advances first.
      const after = stream.slice(j + 1, j + 12);
      if (/^\s*'/.test(after)) {
        y -= leading;
        x = 0;
        push(text);
      } else if (/^\s*"/.test(after)) {
        y -= leading;
        x = 0;
        push(text);
      } else if (/^\s*(Tj|TJ)/.test(after) || /^\s*[\d\s.-]*(Tj|TJ)/.test(after)) {
        push(text);
      } else {
        push(text);
      }
      index = j + 1;
      continue;
    }

    if (char === "<" && stream[index + 1] !== "<") {
      const close = stream.indexOf(">", index);
      if (close === -1) break;
      push(decodeHexString(stream.slice(index + 1, close)));
      index = close + 1;
      continue;
    }

    const op = /^(BT|ET|T\*|TD|Td|Tm|TL|Tf)/.exec(stream.slice(index));
    if (op) {
      const name = op[1];
      if (name === "BT") {
        x = 0;
        y = 0;
      } else if (name === "T*") {
        y -= leading;
        x = 0;
      } else if (name === "Td" || name === "TD") {
        const [dx, dy] = numbersBefore(index, 2);
        x += dx ?? 0;
        y += dy ?? 0;
        // `TD` also sets the leading to -dy, which is what makes subsequent `T*` advance correctly.
        if (name === "TD") leading = -(dy ?? 0);
      } else if (name === "Tm") {
        const nums = numbersBefore(index, 6);
        x = nums[4] ?? x;
        y = nums[5] ?? y;
        // The matrix scale multiplies the font size; a document setting `Tf 1` and scaling by 12 in `Tm` is
        // common, and reading the size from `Tf` alone would make every heading look body-sized.
        const scaleY = nums[3] ?? 1;
        if (scaleY !== 0 && Math.abs(scaleY) !== 1) size = Math.abs(size * scaleY);
      } else if (name === "TL") {
        leading = numbersBefore(index, 1)[0] ?? leading;
      } else if (name === "Tf") {
        size = numbersBefore(index, 1)[0] ?? size;
      }
      index += name?.length ?? 1;
      continue;
    }
    index += 1;
  }
};

/** Mojibake test: text that is mostly unmapped glyph indices rather than characters. */
const looksLikeGlyphIndices = (text: string): boolean => {
  if (text.length < 20) return false;
  let odd = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 9 || (code > 13 && code < 32) || (code >= 0xe000 && code <= 0xf8ff)) odd += 1;
  }
  return odd / text.length > 0.3;
};

/**
 * Fragments to blocks.
 *
 * Fragments on the same baseline are one line; a larger-than-usual gap between baselines starts a new
 * paragraph. A line whose font is clearly larger than the document's body size becomes a heading, its level
 * from how much larger.
 *
 * **Tables.** A PDF contains no tables — it contains text at coordinates — so this recovers a grid when the
 * evidence is strong: three or more consecutive lines whose fragments start at the same set of x positions.
 * That catches the regular tables report generators produce and misses merged cells and ruled-only layouts.
 * When lines share x positions but inconsistently, the text is kept as paragraphs and a warning says the
 * layout may not have survived — a wrong table is worse than no table, because a wrong one looks authoritative.
 */
const groupIntoBlocks = (
  fragments: readonly Fragment[],
  builder: ReturnType<typeof createBlockBuilder>,
): void => {
  if (fragments.length === 0) return;

  // Lines: same page, same baseline within a tolerance, ordered left to right.
  type Line = { page: number; y: number; size: number; parts: Fragment[] };
  const lines: Line[] = [];
  for (const fragment of [...fragments].sort((a, b) =>
    a.page !== b.page ? a.page - b.page : b.y !== a.y ? b.y - a.y : a.x - b.x,
  )) {
    const last = lines[lines.length - 1];
    if (last && last.page === fragment.page && Math.abs(last.y - fragment.y) < 2) {
      last.parts.push(fragment);
      last.size = Math.max(last.size, fragment.size);
    } else {
      lines.push({ page: fragment.page, y: fragment.y, size: fragment.size, parts: [fragment] });
    }
  }

  const joinLine = (line: Line): string => {
    let text = "";
    let previousEnd: number | null = null;
    for (const part of line.parts) {
      // A gap wider than a couple of characters is a space the PDF expressed by moving rather than by
      // drawing one. Without this, `Total` and `1,234` in adjacent columns become `Total1,234`.
      if (previousEnd !== null && part.x - previousEnd > line.size * 0.25) text += " ";
      text += part.text;
      previousEnd = part.x + part.text.length * line.size * 0.5;
    }
    return text.replace(/\s+/g, " ").trim();
  };

  // The body size is the most common size, which is what makes "larger than body" mean anything.
  //
  // Weighted by *characters*, not by line count. Headings are short, so a document with a title, two section
  // headings and three lines of prose has more heading lines than body lines and a line-count vote elects the
  // heading size as the body -- after which nothing is a heading and the document's structure is gone. Found
  // rendering a short report in #134 and reading it back with this parser.
  const sizeCounts = new Map<number, number>();
  for (const line of lines) {
    const rounded = Math.round(line.size);
    const weight = Math.max(1, joinLine(line).length);
    sizeCounts.set(rounded, (sizeCounts.get(rounded) ?? 0) + weight);
  }
  // Most common size wins, and on a tie the *smaller* one does. That tie-break is not a detail: a short
  // document with one heading and one paragraph has a 1-1 tie, and picking the larger as "body" makes the
  // heading look body-sized and flattens the only structure the document had. A body is never a document's
  // largest text.
  const bodySize =
    [...sizeCounts.entries()].sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] - b[0]))[0]?.[0] ?? 12;

  const headingLevel = (size: number): HeadingLevel | null => {
    const ratio = size / bodySize;
    if (ratio < 1.15) return null;
    if (ratio >= 1.8) return 1;
    if (ratio >= 1.5) return 2;
    if (ratio >= 1.3) return 3;
    return 4;
  };

  /** x positions a line's fragments start at, rounded so near-identical columns match. */
  const xKey = (line: Line): string => line.parts.map((p) => Math.round(p.x / 5) * 5).join(",");

  let index = 0;
  let paragraph: string[] = [];
  let paragraphPage = lines[0]?.page ?? 1;
  const flushParagraph = (): boolean => {
    if (paragraph.length === 0) return true;
    const text = paragraph.join(" ").replace(/\s+/g, " ").trim();
    paragraph = [];
    return text === "" ? true : builder.push({ kind: "paragraph", text, page: paragraphPage });
  };

  while (index < lines.length) {
    const line = lines[index];
    if (!line) break;

    // A table candidate: consecutive lines with more than one column at matching x positions.
    if (line.parts.length > 1) {
      const key = xKey(line);
      let run = 1;
      while (index + run < lines.length) {
        const next = lines[index + run];
        if (!next || next.page !== line.page || xKey(next) !== key) break;
        run += 1;
      }
      if (run >= 3) {
        if (!flushParagraph()) return;
        const rows = lines.slice(index, index + run).map((l) => l.parts.map((p) => p.text.trim()));
        // The header claim needs evidence: a first row of non-empty cells in a different size or all
        // non-numeric. Claiming a header that is really data mislabels every column.
        const first = rows[0] ?? [];
        const hasHeader =
          first.length > 0 &&
          first.every((cell) => cell !== "") &&
          first.some((cell) => !/^-?[\d.,%$€£\s]+$/.test(cell));
        if (!builder.push({ kind: "table", rows, hasHeader, page: line.page })) return;
        index += run;
        continue;
      }
    }

    const text = joinLine(line);
    if (text === "") {
      index += 1;
      continue;
    }

    const level = headingLevel(line.size);
    if (level !== null) {
      if (!flushParagraph()) return;
      if (!builder.push({ kind: "heading", level, text, page: line.page })) return;
      index += 1;
      continue;
    }

    const previous = lines[index - 1];
    const gap = previous && previous.page === line.page ? previous.y - line.y : Number.POSITIVE_INFINITY;
    // A gap much larger than the line height is a paragraph break; a normal one is a wrap, and joining
    // wrapped lines is what turns a PDF back into sentences.
    if (gap > line.size * 1.8 && !flushParagraph()) return;
    if (paragraph.length === 0) paragraphPage = line.page;
    paragraph.push(text);
    index += 1;
  }
  flushParagraph();
};

/** Pages, from the page-tree objects. `/Count` is authoritative when present; the object count is the fallback. */
const countPages = (raw: string): number => {
  const count = /\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/.exec(raw);
  if (count?.[1] !== undefined) return Number(count[1]);
  return (raw.match(/\/Type\s*\/Page[^s]/g) ?? []).length || 1;
};

export const parsePdf = (bytes: Uint8Array, limits: ExtractionLimits): ExtractedDocument | ExtractionFailure => {
  const raw = ascii(bytes);
  if (!raw.startsWith("%PDF-"))
    return { reason: "malformed", message: "That file does not begin with a PDF header." };

  // Before anything is decoded: extracting from an encrypted document would mean implementing the security
  // handler, which is a decryption tool rather than a parser.
  if (/\/Encrypt\s/.test(raw))
    return {
      reason: "encrypted",
      message: "That PDF is encrypted. Remove its password protection and attach it again.",
    };

  const pageCount = countPages(raw);
  if (pageCount > limits.maxPages)
    return {
      reason: "too-many-pages",
      // The limit is named, not implied. "Too long" sends someone to guess where to split it.
      message: `That PDF has ${pageCount} pages and the limit is ${limits.maxPages}. Split it and attach the part you need.`,
    };

  const { streams, warnings, hitDecompressionLimit } = contentStreams(raw, limits);
  const builder = createBlockBuilder(limits);
  for (const warning of warnings) builder.warn(warning);

  const fragments: Fragment[] = [];
  // Streams are found in file order, which is page order in every PDF a normal tool writes. The page number
  // is therefore approximate for an unusual layout, and it is metadata on a block rather than something the
  // extraction depends on.
  streams.forEach((stream, i) => {
    if (fragments.length > limits.maxBlocks * 4) return;
    readFragments(stream, Math.min(i + 1, pageCount), fragments);
  });

  if (fragments.length === 0) {
    // Which absence this is matters, and the two answers send a user to different places. A document whose
    // streams were too big to decompress is `too-large` -- reporting it as a scan would send someone to run
    // OCR on a file whose problem is its size. Found by sabotage: the bomb case was reported as a scan.
    if (hitDecompressionLimit)
      return {
        reason: "too-large",
        message: "That PDF's compressed content expands past the extraction limit and could not be read.",
      };
    return {
      reason: "no-text-layer",
      // The distinction that matters: this is a scan, not a broken file.
      message:
        "That PDF has no extractable text — it is most likely a scan. It needs optical character recognition.",
    };
  }

  const joined = fragments.map((f) => f.text).join("");
  if (looksLikeGlyphIndices(joined))
    builder.warn(
      "The text may be garbled: this PDF uses embedded fonts whose character map could not be applied.",
    );

  groupIntoBlocks(fragments, builder);
  if (builder.done().blocks.length === 0)
    return {
      reason: "no-text-layer",
      message: "That PDF's text could not be reconstructed into readable content.",
    };

  return { ...builder.done(), pageCount };
};

export const createPdfDocumentParser = (): DocumentParser => ({
  id: "pdf",
  mediaTypes: ["application/pdf"],
  async parse({ bytes, limits }) {
    return parsePdf(bytes, limits);
  },
});
