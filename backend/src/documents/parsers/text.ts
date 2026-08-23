/**
 * Text, Markdown, CSV and JSON extraction (#131).
 *
 * The easy formats, and worth doing properly rather than passing straight through. A CSV handed to a model as
 * one long string is the flattening this whole module exists to avoid — the row and column that give a number
 * its meaning are exactly what gets lost. So a CSV becomes a `table` block with its cells intact, Markdown
 * headings keep their level, and pipe tables survive as tables.
 *
 * Everything here is bounded the same way the PDF parser is, because "it's only text" is how a 200 MB CSV
 * occupies a worker.
 */

import type {
  DocumentBlock,
  DocumentParser,
  ExtractedDocument,
  ExtractionFailure,
  ExtractionLimits,
  HeadingLevel,
} from "../index.js";

/**
 * Accumulates blocks against the limits, so every parser stops the same way.
 *
 * Shared rather than repeated: the two parsers in this module and the PDF one all need the same three
 * ceilings, and three copies of "am I over budget" is three chances for one of them to be wrong.
 */
export const createBlockBuilder = (limits: ExtractionLimits) => {
  const blocks: DocumentBlock[] = [];
  const warnings: string[] = [];
  let textBytes = 0;
  let truncated = false;

  const sizeOf = (block: DocumentBlock): number => {
    switch (block.kind) {
      case "heading":
      case "paragraph":
        return block.text.length;
      case "list":
        return block.items.reduce((n, item) => n + item.length, 0);
      case "table":
        return block.rows.reduce((n, row) => n + row.reduce((m, cell) => m + cell.length, 0), 0);
    }
  };

  return {
    /** Returns false once full, so a caller can stop reading rather than keep parsing into a bin. */
    push(block: DocumentBlock): boolean {
      if (truncated) return false;
      if (blocks.length >= limits.maxBlocks) {
        truncated = true;
        warnings.push(`Stopped after ${limits.maxBlocks} blocks; the document continues.`);
        return false;
      }
      const size = sizeOf(block);
      if (textBytes + size > limits.maxTextBytes) {
        truncated = true;
        warnings.push(`Stopped after ${limits.maxTextBytes} bytes of text; the document continues.`);
        return false;
      }
      textBytes += size;
      blocks.push(block);
      return true;
    },
    warn(message: string): void {
      warnings.push(message);
    },
    get truncated(): boolean {
      return truncated;
    },
    done(pageCount?: number): ExtractedDocument {
      return {
        blocks,
        ...(pageCount === undefined ? {} : { pageCount }),
        truncated,
        warnings,
      };
    },
  };
};

export type BlockBuilder = ReturnType<typeof createBlockBuilder>;

/** Collapse runs of whitespace. A PDF or a wrapped paragraph produces plenty, and none of it is meaning. */
const tidy = (text: string): string => text.replace(/\s+/g, " ").trim();

const decode = (bytes: Uint8Array): string =>
  // `fatal: false`: a byte sequence that is not valid UTF-8 should give a replacement character, not turn a
  // readable document into an extraction failure.
  new TextDecoder("utf-8", { fatal: false }).decode(bytes);

/**
 * A pipe-table row split into cells.
 *
 * Returns null when the line is not a table row, so the caller's check and the split are one decision rather
 * than a test followed by a parse that could disagree with it.
 */
const pipeCells = (line: string): readonly string[] | null => {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  // Leading and trailing pipes are optional in Markdown, so they are stripped before splitting rather than
  // producing phantom empty cells at both ends.
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((cell) => cell.trim());
};

/** `|---|:--:|` — the row that marks the line above as a header. Never content. */
const isPipeDivider = (line: string): boolean =>
  /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/**
 * Markdown, and plain text as its degenerate case.
 *
 * Plain text has no headings or tables, so running it through the same parser costs nothing and means one
 * code path instead of two that differ in how they split paragraphs.
 */
export const parseMarkdown = (bytes: Uint8Array, limits: ExtractionLimits): ExtractedDocument => {
  const builder = createBlockBuilder(limits);
  const lines = decode(bytes).split(/\r?\n/);

  let paragraph: string[] = [];
  const flushParagraph = (): boolean => {
    if (paragraph.length === 0) return true;
    const text = tidy(paragraph.join(" "));
    paragraph = [];
    return text === "" ? true : builder.push({ kind: "paragraph", text });
  };

  let listItems: string[] = [];
  let listOrdered = false;
  const flushList = (): boolean => {
    if (listItems.length === 0) return true;
    const items = listItems;
    listItems = [];
    return builder.push({ kind: "list", items, ordered: listOrdered });
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      if (!flushParagraph() || !flushList()) break;
      const level = heading[1]?.length ?? 1;
      if (!builder.push({ kind: "heading", level: level as HeadingLevel, text: tidy(heading[2] ?? "") })) break;
      index += 1;
      continue;
    }

    // A table is recognised by its divider, not by containing a pipe: a sentence with a pipe in it is a
    // sentence, and treating it as a one-column table would be worse than leaving it as prose.
    const cells = pipeCells(line);
    if (cells !== null && cells.length > 1 && isPipeDivider(lines[index + 1] ?? "")) {
      if (!flushParagraph() || !flushList()) break;
      const rows: string[][] = [[...cells]];
      let cursor = index + 2;
      while (cursor < lines.length) {
        const rowCells = pipeCells(lines[cursor] ?? "");
        if (rowCells === null || rowCells.length <= 1) break;
        rows.push([...rowCells]);
        cursor += 1;
      }
      if (!builder.push({ kind: "table", rows, hasHeader: true })) break;
      index = cursor;
      continue;
    }

    const bullet = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      if (!flushParagraph()) break;
      const ordered = bullet[1] !== undefined;
      // A bullet list running into a numbered one is two lists. Keeping them as one would renumber the
      // second, which changes what the document said.
      if (listItems.length > 0 && ordered !== listOrdered && !flushList()) break;
      listOrdered = ordered;
      listItems.push(tidy(bullet[2] ?? ""));
      index += 1;
      continue;
    }

    if (line.trim() === "") {
      if (!flushParagraph() || !flushList()) break;
      index += 1;
      continue;
    }

    if (listItems.length > 0 && !flushList()) break;
    paragraph.push(line);
    index += 1;
  }
  flushParagraph();
  flushList();

  return builder.done();
};

/**
 * A CSV row splitter that understands quotes.
 *
 * Not `line.split(",")`. A quoted field can contain a comma, a newline and an escaped quote, and a splitter
 * that ignores that silently shifts every subsequent column — the worst possible failure for a table, because
 * the result is plausible.
 */
export const parseDelimited = (
  bytes: Uint8Array,
  limits: ExtractionLimits,
  delimiter = ",",
): ExtractedDocument => {
  const builder = createBlockBuilder(limits);
  const text = decode(bytes);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    // A trailing newline would otherwise add a row of one empty cell to every file.
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };

  while (index < text.length) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        // `""` inside a quoted field is one literal quote, not the end of the field.
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"' && field === "") {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === delimiter) {
      endField();
      index += 1;
      continue;
    }
    if (char === "\n") {
      endRow();
      index += 1;
      continue;
    }
    if (char === "\r") {
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }
  if (field !== "" || row.length > 0) endRow();

  if (rows.length === 0) return builder.done();
  // The first row is the header when every cell is non-empty — the usual case, and a header of blanks is a
  // sign the file has none rather than a header worth claiming.
  const hasHeader = (rows[0] ?? []).every((cell) => cell.trim() !== "");
  builder.push({ kind: "table", rows, hasHeader });
  return builder.done();
};

/**
 * JSON as a document.
 *
 * An array of flat objects is a table and is by far the most common shape a JSON attachment has, so it is
 * extracted as one. Anything else is rendered as indented text: still readable, and honest about the fact
 * that there was no table to find.
 */
export const parseJsonDocument = (bytes: Uint8Array, limits: ExtractionLimits): ExtractedDocument | ExtractionFailure => {
  const builder = createBlockBuilder(limits);
  let parsed: unknown;
  try {
    parsed = JSON.parse(decode(bytes));
  } catch {
    return { reason: "malformed", message: "That file is not valid JSON." };
  }

  const isFlatRecord = (value: unknown): value is Record<string, string | number | boolean | null> =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => v === null || ["string", "number", "boolean"].includes(typeof v));

  if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(isFlatRecord)) {
    // The union of keys, in first-seen order: a record missing a key gets an empty cell rather than shifting
    // the row, which is the same silent-corruption failure quoted CSV fields avoid.
    const columns: string[] = [];
    for (const record of parsed) for (const key of Object.keys(record)) if (!columns.includes(key)) columns.push(key);
    const rows = [columns, ...parsed.map((record) => columns.map((c) => String(record[c] ?? "")))];
    builder.push({ kind: "table", rows, hasHeader: true });
    return builder.done();
  }

  builder.push({ kind: "paragraph", text: tidy(JSON.stringify(parsed, null, 2)) });
  return builder.done();
};

/**
 * The parser for every text-shaped type.
 *
 * One parser dispatching on the type it was handed, rather than five parsers sharing a builder. The formats
 * differ only in how a line is read; the bounds, the decoding and the block shapes are identical, and five
 * copies of those is five chances for one to be wrong.
 */
export const TEXT_MEDIA_TYPES = [
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
] as const;

export const createTextDocumentParser = (): DocumentParser => ({
  id: "text",
  mediaTypes: TEXT_MEDIA_TYPES,
  async parse({ bytes, mediaType, limits }) {
    switch (mediaType) {
      case "text/csv":
        return parseDelimited(bytes, limits, ",");
      case "text/tab-separated-values":
        return parseDelimited(bytes, limits, "\t");
      case "application/json":
        return parseJsonDocument(bytes, limits);
      default:
        // Plain text goes through the Markdown parser: plain text is Markdown with no markup, so one path
        // handles both and a `.txt` file that happens to use `#` headings is read the way its author meant.
        return parseMarkdown(bytes, limits);
    }
  },
});
