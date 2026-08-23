/**
 * Markdown export (#134).
 *
 * The easy format, and worth doing deliberately rather than by concatenation. Two things it must get right:
 *
 * - **Citations.** Inline markers and a `References` section, so a claim in the export still points at its
 *   source. An export that dropped them would be a document someone forwards as if it were unsourced.
 * - **Determinism** (AC-6). No timestamps, no ordering that depends on object key iteration — the output is a
 *   pure function of the blocks, so a re-render is byte-identical.
 */

import type { DocumentBlock } from "../documents/index.js";
import { renderBlocks } from "../documents/render.js";
import type { ExportCitation } from "./pdf.js";

export type MarkdownRenderInput = {
  readonly title: string;
  readonly blocks: readonly DocumentBlock[];
  readonly citations?: readonly ExportCitation[];
};

export const renderMarkdown = (input: MarkdownRenderInput): string => {
  const parts = [`# ${input.title}`, renderBlocks(input.blocks)];
  if (input.citations !== undefined && input.citations.length > 0) {
    parts.push("## References");
    parts.push(
      [...input.citations]
        // Sorted by marker, not by insertion: the numbers in the text have to match the order of the list, and
        // relying on the caller's ordering is relying on something no type enforces.
        .sort((a, b) => a.marker - b.marker)
        .map((c) => {
          const detail = [c.locator, c.url].filter((p): p is string => p !== undefined && p !== "");
          return `${c.marker}. ${c.title}${detail.length > 0 ? ` — ${detail.join(" — ")}` : ""}`;
        })
        .join("\n"),
    );
  }
  // A single trailing newline, because a file without one is a file every diff tool complains about.
  return `${parts.filter((p) => p.trim() !== "").join("\n\n")}\n`;
};
