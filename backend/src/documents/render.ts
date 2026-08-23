/**
 * Rendering extracted structure back to text for a model (#131).
 *
 * The counterpart to extraction, and the reason extracting to blocks rather than a string pays off: a table
 * is rendered as a Markdown table, so the model sees the same rows and columns the document had. Flattening
 * happened nowhere — not at extraction, and not here.
 *
 * Markdown specifically, because it is the format models are most reliably trained on for tabular text and
 * the one where a cell's column is unambiguous. A CSV rendering would be more compact and would lose the
 * header's distinctness; an ASCII-art table would cost far more tokens for no gain.
 */

import type { DocumentBlock } from "./index.js";

/** A pipe cell cannot contain a raw `|` without ending the cell, and a newline would end the row. */
const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

export const renderBlock = (block: DocumentBlock): string => {
  switch (block.kind) {
    case "heading":
      return `${"#".repeat(block.level)} ${block.text}`;
    case "paragraph":
      return block.text;
    case "list":
      return block.items.map((item, i) => (block.ordered ? `${i + 1}. ${item}` : `- ${item}`)).join("\n");
    case "table": {
      const rows = block.rows.map((row) => `| ${row.map(cell).join(" | ")} |`);
      if (!block.hasHeader || rows.length === 0) return rows.join("\n");
      // The divider is what makes the first row a header rather than just the first row. Its width has to
      // match the header's cell count or the table reads as malformed.
      const divider = `| ${(block.rows[0] ?? []).map(() => "---").join(" | ")} |`;
      return [rows[0], divider, ...rows.slice(1)].join("\n");
    }
  }
};

/**
 * A window of blocks, rendered.
 *
 * Blocks rather than characters, because a bound that can land inside a table would hand the model half a
 * table — which is worse than no table, since the missing rows are invisible. A block is the smallest unit
 * that is still meaningful on its own.
 */
export const renderBlocks = (blocks: readonly DocumentBlock[]): string =>
  blocks.map(renderBlock).join("\n\n");

/**
 * A one-line description of what a document contains.
 *
 * For the context section: enough for a model to decide whether reading it is worth the budget, at a cost
 * that does not depend on the document's length.
 */
export const summariseBlocks = (blocks: readonly DocumentBlock[]): string => {
  const counts = { heading: 0, paragraph: 0, table: 0, list: 0 };
  for (const block of blocks) counts[block.kind] += 1;
  const parts = [
    counts.heading > 0 ? `${counts.heading} heading${counts.heading === 1 ? "" : "s"}` : null,
    counts.paragraph > 0 ? `${counts.paragraph} paragraph${counts.paragraph === 1 ? "" : "s"}` : null,
    counts.table > 0 ? `${counts.table} table${counts.table === 1 ? "" : "s"}` : null,
    counts.list > 0 ? `${counts.list} list${counts.list === 1 ? "" : "s"}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? "no content" : parts.join(", ");
};
